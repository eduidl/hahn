//! Opt-in checks against the user's real recordings. No copies or rewrites.
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use mcapdecode::{
    McapReader, ReadOptions,
    core::{DataTypeDef, FieldDefs, Value},
};
use serde_json::{Value as Json, json};
use std::path::PathBuf;
use tower::ServiceExt;

fn data_dir() -> PathBuf {
    std::env::var_os("MCAP_TEST_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("data"))
}

fn scalar(defs: &FieldDefs, value: &Value, path: &[&str]) -> serde_json::Value {
    let index = defs.iter().position(|f| f.name == path[0]).unwrap();
    let Value::Struct(values) = value else {
        return serde_json::Value::Null;
    };
    if path.len() > 1 {
        let DataTypeDef::Struct(children) = &defs[index].element.data_type else {
            panic!("Expected struct");
        };
        return scalar(&children.fields, &values[index], &path[1..]);
    }
    match &values[index] {
        Value::Null => serde_json::Value::Null,
        Value::F32(v) => json!(*v as f64),
        Value::F64(v) => json!(v),
        Value::I32(v) => json!(v),
        Value::U64(v) => json!(v.to_string()),
        other => panic!("Unexpected test field value: {other:?}"),
    }
}

fn encode(value: &str) -> String {
    value.bytes().map(|b| format!("%{b:02X}")).collect()
}

async fn get_json(app: &axum::Router, url: &str) -> Json {
    let response = app
        .clone()
        .oneshot(Request::get(url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

/// Paths of the fields [`scalar`] can compare, struct fields included.
fn numeric_paths(fields: &Json, prefix: &[String], out: &mut Vec<Vec<String>>) {
    for field in fields.as_array().unwrap() {
        let mut path = prefix.to_vec();
        path.push(field["name"].as_str().unwrap().to_owned());
        match field["data_type"].as_str().unwrap() {
            "float32" | "float64" | "int32" | "uint64" => out.push(path),
            "struct" => numeric_paths(&field["fields"], &path, out),
            _ => {}
        }
    }
}

async fn compare(file_name: &str, topic: &str, fields: &[Vec<String>]) {
    let fields: Vec<Vec<&str>> = fields
        .iter()
        .map(|path| path.iter().map(String::as_str).collect())
        .collect();
    let fields = &fields;
    let root = data_dir();
    let reader = McapReader::builder()
        .with_default_decoders()
        .with_parallel(false)
        .build();
    let path = root.join(file_name);
    let defs = reader.topic_field_defs(&path, topic).unwrap();
    let mut expected = Vec::new();
    reader
        .for_each_decoded_message_with_options(
            &path,
            topic,
            &ReadOptions {
                limit: Some(8),
                ..Default::default()
            },
            |msg| {
                expected.push(json!({"time_ns":msg.log_time.to_string(), "values":fields.iter().map(|f| scalar(&defs, &msg.value, f)).collect::<Vec<_>>()}));
                Ok(())
            },
        )
        .unwrap();
    assert!(!expected.is_empty());
    let app = hahn::router(&root).unwrap();
    let response = app
        .clone()
        .oneshot(Request::get("/api/runs").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let runs: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let run = runs["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == file_name)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/api/runs/{run}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let detail: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let base = format!(
        "/api/runs/{run}/groups/{}",
        detail["groups"][0]["id"].as_str().unwrap()
    );
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("{base}/topics"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let topics: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let target = topics
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["topic"] == topic)
        .unwrap();
    let typed_fields: Vec<_> = target["fields"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|field| field["data_type"] == "enum" || field["data_type"] == "struct")
        .collect();
    assert!(
        typed_fields
            .iter()
            .all(|field| field["type_name"].is_string())
    );
    let mut columns = Vec::new();
    for field in fields {
        let path = serde_json::to_string(field).unwrap();
        let query = format!(
            "topic={}&path={}&preview=false",
            encode(topic),
            encode(&path)
        );
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("{base}/messages?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());
        let mut body = response.into_body();
        let mut rows = Vec::new();
        let mut pending = Vec::new();
        while rows.len() < expected.len() {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(30), body.frame())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Ok(bytes) = frame.into_data() {
                pending.extend_from_slice(&bytes);
                while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = pending.drain(..=end).collect();
                    let event: Json = serde_json::from_slice(&line).unwrap();
                    assert_ne!(event["type"], "error", "{event}");
                    if let Some(new) = event["rows"].as_array() {
                        rows.extend(new.iter().cloned());
                    }
                }
            }
        }
        rows.truncate(expected.len());
        columns.push(rows);
    }
    let actual: Vec<Json> = (0..expected.len())
        .map(|i| {
            let values: Vec<_> = columns.iter().map(|c| c[i]["value"].clone()).collect();
            json!({"time_ns": columns[0][i]["time_ns"], "values": values})
        })
        .collect();
    assert_eq!(actual, expected);
}

#[tokio::test]
#[ignore = "Requires real recordings in data/"]
async fn real_recordings_match_direct_decoding() {
    let app = hahn::router(&data_dir()).unwrap();
    let runs = get_json(&app, "/api/runs?limit=200").await;
    let mut compared = 0;
    for run in runs["items"].as_array().unwrap() {
        let name = run["name"].as_str().unwrap();
        if !name.ends_with(".mcap") {
            continue;
        }
        let id = run["id"].as_str().unwrap();
        let detail = get_json(&app, &format!("/api/runs/{id}")).await;
        let group = detail["groups"][0]["id"].as_str().unwrap();
        let topics = get_json(&app, &format!("/api/runs/{id}/groups/{group}/topics")).await;
        for topic in topics.as_array().unwrap() {
            let mut paths = Vec::new();
            numeric_paths(&topic["fields"], &[], &mut paths);
            paths.truncate(3);
            if paths.is_empty() || topic["message_count"].as_u64().unwrap_or(0) == 0 {
                continue;
            }
            compare(name, topic["topic"].as_str().unwrap(), &paths).await;
            compared += 1;
            break;
        }
    }
    assert!(compared > 0, "No MCAP recording with numeric fields");
}
