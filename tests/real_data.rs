//! Opt-in checks against the user's real recordings. No copies or rewrites.
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use mcapdecode::{
    McapReader, ReadOptions,
    core::{DataTypeDef, FieldDefs, Value},
};
use serde_json::json;
use std::path::PathBuf;
use tower::ServiceExt;

fn data_dir() -> PathBuf {
    std::env::var_os("MCAP_TEST_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data"))
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

async fn compare(file_name: &str, topic: &str, fields: &[&[&str]]) {
    let root = data_dir();
    let reader = McapReader::builder()
        .with_default_decoders()
        .with_parallel(false)
        .build();
    let path = root.join(file_name);
    let defs = reader.topic_field_defs(&path, topic).unwrap();
    let mut expected = Vec::new();
    reader.for_each_decoded_message_with_options(&path, topic, &ReadOptions { limit: Some(8), ..Default::default() }, |msg| {
        expected.push(json!({"time_ns":msg.log_time.to_string(), "values":fields.iter().map(|f| scalar(&defs, &msg.value, f)).collect::<Vec<_>>()}));
        Ok(())
    }).unwrap();
    assert!(!expected.is_empty());
    let app = hahn::router(&root).unwrap();
    let response = app
        .clone()
        .oneshot(Request::get("/api/files").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let files: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let id = files
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == file_name)
        .unwrap()["id"]
        .as_u64()
        .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/api/files/{id}/topics"))
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
    let response = app
        .oneshot(
            Request::post(format!("/api/files/{id}/series"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"topic":topic,"fields":fields}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_success());
    let mut body = response.into_body();
    let mut actual = Vec::new();
    while actual.len() < expected.len() {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(30), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Ok(bytes) = frame.into_data() {
            let event: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_ne!(event["type"], "error", "{event}");
            if let Some(rows) = event["rows"].as_array() {
                actual.extend(rows.iter().take(expected.len() - actual.len()).cloned());
            }
        }
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
async fn protobuf_recording() {
    compare(
        "protobuf.mcap",
        "/chassis",
        &[
            &["speed"],
            &["throttle"],
            &["header", "lidar_timestamp"],
        ],
    )
    .await;
}
#[tokio::test]
#[ignore = "Requires real recordings in data/"]
async fn ros2_idl_recording() {
    compare(
        "ros2.mcap",
        "/pose",
        &[&["pose", "position", "x"], &["pose", "position", "y"]],
    )
    .await;
}
#[tokio::test]
#[ignore = "Requires real recordings in data/"]
async fn ros2_msg_recording() {
    compare(
        "ros2msg_test.mcap",
        "/example/sample",
        &[&["x"], &["value"]],
    )
    .await;
}
