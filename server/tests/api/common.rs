//! Helpers shared by the API tests: fixtures, requests and response parsing.

pub(crate) use crate::support;
pub(crate) use axum::{
    body::Body,
    http::{Request, StatusCode},
};
pub(crate) use http_body_util::BodyExt;
pub(crate) use serde_json::{Value, json};
pub(crate) use tower::ServiceExt;

pub(crate) fn fixture(count: usize, stats: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    support::write_fixture(&dir.path().join("test.mcap"), count, stats).unwrap();
    dir
}

pub(crate) async fn raw_get(app: &axum::Router, url: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(Request::get(url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

/// Expands `/g`, which stands for the first group of the first run, and `/r`, its run.
pub(crate) async fn resolve(app: &axum::Router, url: &str) -> String {
    let (_, runs) = raw_get(app, "/api/runs").await;
    let run = runs["items"][0]["id"].as_str().unwrap_or_default();
    if let Some(tail) = url.strip_prefix("/r/") {
        return format!("/api/runs/{run}/{tail}");
    }
    let Some(tail) = url.strip_prefix("/g") else {
        return url.to_owned();
    };
    let (_, detail) = raw_get(app, &format!("/api/runs/{run}")).await;
    let group = detail["groups"][0]["id"].as_str().unwrap();
    format!("/api/runs/{run}/groups/{group}{tail}")
}

pub(crate) async fn get(app: axum::Router, url: &str) -> (StatusCode, Value) {
    let url = resolve(&app, url).await;
    raw_get(&app, &url).await
}

/// Every field of a schema tree by path, like a client walking it.
pub(crate) fn flat(fields: &Value, prefix: &[Value], out: &mut Vec<(Value, Value)>) {
    for field in fields.as_array().unwrap() {
        let mut path = prefix.to_vec();
        path.push(field["name"].clone());
        out.push((Value::Array(path.clone()), field.clone()));
        if field.get("fields").is_some() {
            flat(&field["fields"], &path, out);
        }
    }
}

pub(crate) fn flattened(fields: &Value) -> Vec<(Value, Value)> {
    let mut out = Vec::new();
    flat(fields, &[], &mut out);
    out
}

/// Percent-encodes everything but unreserved characters.
pub(crate) fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Reads each field exactly with its own request, as a client does, and zips the rows.
pub(crate) async fn series(app: axum::Router, body: Value) -> (StatusCode, Vec<Value>) {
    let mut columns: Vec<Vec<Value>> = Vec::new();
    let mut last = Value::Null;
    for field in body["fields"].as_array().unwrap() {
        let mut query = body.clone();
        query["path"] = field.clone();
        query["preview"] = json!(false);
        query.as_object_mut().unwrap().remove("fields");
        let (status, events) = stream(app.clone(), "/g/messages", query).await;
        if status != StatusCode::OK {
            return (status, events);
        }
        let rows = events.iter().filter_map(|e| e["rows"].as_array()).flatten();
        columns.push(rows.cloned().collect());
        last = events.last().unwrap().clone();
    }
    let rows: Vec<Value> = (0..columns[0].len())
        .map(|i| {
            let values: Vec<_> = columns.iter().map(|c| c[i]["value"].clone()).collect();
            json!({"time_ns": columns[0][i]["time_ns"], "values": values})
        })
        .collect();
    let mut events = Vec::new();
    if !rows.is_empty() {
        events.push(json!({"type":"batch","rows":rows}));
    }
    events.push(last);
    (StatusCode::OK, events)
}

pub(crate) async fn stream(app: axum::Router, url: &str, query: Value) -> (StatusCode, Vec<Value>) {
    let url = resolve(&app, url).await;
    let params: Vec<String> = query
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            format!("{key}={}", encode(&text))
        })
        .collect();
    let response = app
        .oneshot(
            Request::get(format!("{url}?{}", params.join("&")))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let events = std::str::from_utf8(&body)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    (status, events)
}

pub(crate) fn visual_app() -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    support::write_visual_fixture(&dir.path().join("visual.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    (dir, app)
}

/// The headers of a frames response, each with its payload.
pub(crate) async fn frames(app: &axum::Router, url: &str) -> (StatusCode, Vec<(Value, Vec<u8>)>) {
    let url = resolve(app, url).await;
    let response = app
        .clone()
        .oneshot(Request::get(&url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    if status != StatusCode::OK {
        return (status, Vec::new());
    }
    assert_eq!(
        response.headers()["content-type"],
        "application/vnd.hahn.frames"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let mut rest = &body[..];
    let mut out = Vec::new();
    while !rest.is_empty() {
        let header_len = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_le_bytes(rest[4..8].try_into().unwrap()) as usize;
        let header = serde_json::from_slice(&rest[8..8 + header_len]).unwrap();
        let start = (8 + header_len).next_multiple_of(8);
        out.push((header, rest[start..start + payload_len].to_vec()));
        rest = &rest[start + payload_len..];
    }
    (status, out)
}

pub(crate) async fn batch_frames(app: &axum::Router, body: Value) -> Vec<Vec<Value>> {
    let count = body["views"].as_array().unwrap().len();
    let url = resolve(app, "/g/views/batch").await;
    let response = app
        .clone()
        .oneshot(
            Request::post(url)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let mut rest = &bytes[..];
    let mut streams = vec![Vec::new(); count];
    while !rest.is_empty() {
        let header_len = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_le_bytes(rest[4..8].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(&rest[8..8 + header_len]).unwrap();
        streams[header["stream"].as_u64().unwrap() as usize].push(header);
        rest = &rest[(8 + header_len).next_multiple_of(8) + payload_len..];
    }
    streams
}

pub(crate) fn view_url(path: &str, topic: &str, view: &str, query: &str) -> String {
    format!("/g/{path}?topic={topic}&view={view}{query}")
}

/// A ROS 2 topic of `int64 count` and `string label`, one message per `(log_time, count, label)`.
pub(crate) fn write_rows(path: &std::path::Path, topic: &str, rows: &[(u64, i64, &str)]) {
    let mut writer = mcap::Writer::new(std::fs::File::create(path).unwrap()).unwrap();
    let schema = writer
        .add_schema("example/msg/Row", "ros2msg", b"int64 count\nstring label\n")
        .unwrap();
    let channel = writer
        .add_channel(schema, topic, "cdr", &Default::default())
        .unwrap();
    for (sequence, &(time, count, label)) in rows.iter().enumerate() {
        let mut cdr = vec![0, 1, 0, 0];
        cdr.extend_from_slice(&count.to_le_bytes());
        cdr.extend_from_slice(&(label.len() as u32 + 1).to_le_bytes());
        cdr.extend_from_slice(label.as_bytes());
        cdr.push(0);
        writer
            .write_to_known_channel(
                &mcap::records::MessageHeader {
                    channel_id: channel,
                    sequence: sequence as u32,
                    log_time: time,
                    publish_time: time,
                },
                &cdr,
            )
            .unwrap();
    }
    writer.finish().unwrap();
}
