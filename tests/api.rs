#[path = "../examples/support/mod.rs"]
mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

fn fixture(count: usize, stats: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    support::write_fixture(&dir.path().join("test.mcap"), count, stats).unwrap();
    dir
}

async fn get(app: axum::Router, url: &str) -> (StatusCode, Value) {
    let response = app
        .oneshot(Request::get(url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}
async fn series(app: axum::Router, body: Value) -> (StatusCode, Vec<Value>) {
    let response = app
        .oneshot(
            Request::post("/api/files/0/series")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
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

#[tokio::test]
async fn metadata_includes_all_field_types() {
    let dir = fixture(2200, true);
    let app = hahn::router(dir.path()).unwrap();
    let (_, files) = get(app.clone(), "/api/files").await;
    assert_eq!(files[0]["name"], "test.mcap");
    assert!(files[0].get("path").is_none());
    let (status, info) = get(app.clone(), "/api/files/0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["start_ns"], support::ORIGIN.to_string());
    assert_eq!(
        info["end_ns"],
        (support::ORIGIN + 2199 * 10_000_000).to_string()
    );
    assert_eq!(info["message_count"], 4400);
    let (_, topics) = get(app.clone(), "/api/files/0/topics").await;
    let telemetry = topics
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["topic"] == "/telemetry")
        .unwrap();
    let fields = telemetry["fields"].as_array().unwrap();
    for (path, kind) in [
        (vec!["position"], "struct"),
        (vec!["position", "x"], "f64"),
        (vec!["label"], "string"),
        (vec!["active"], "bool"),
    ] {
        let field = fields.iter().find(|f| f["path"] == json!(path)).unwrap();
        assert_eq!(field["data_type"], kind);
    }
    let mode = fields
        .iter()
        .find(|field| field["path"] == json!(["mode"]))
        .unwrap();
    assert_eq!(mode["data_type"], "enum");
    assert_eq!(mode["type_name"], "hahn.Mode");
    assert_eq!(
        mode["enum_values"],
        json!([
            {"name":"IDLE", "value":0},
            {"name":"ACTIVE", "value":1}
        ])
    );
    let position = fields
        .iter()
        .find(|field| field["path"] == json!(["position"]))
        .unwrap();
    assert_eq!(position["data_type"], "struct");
    assert_eq!(position["type_name"], "hahn.Position");
    assert!(fields.iter().any(|f| f["path"] == json!(["tags"])));
    // Strings stream like other scalars; lists do not.
    let (status, _) = series(
        app.clone(),
        json!({"topic":"/telemetry", "fields":[["label"]]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = series(
        app.clone(),
        json!({"topic":"/telemetry", "fields":[["tags"]]}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(get(app, "/api/files/100").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stream_batches_exact_values_gaps_and_completion() {
    let dir = fixture(2200, true);
    let (status, events) = series(
        hahn::router(dir.path()).unwrap(),
        json!({"topic":"/telemetry", "fields":[["signal"],["counter"],["position","x"]]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(events.len() >= 4);
    assert_eq!(events[0]["type"], "batch");
    assert_eq!(events.last().unwrap()["type"], "complete");
    let rows: Vec<_> = events
        .iter()
        .filter_map(|e| e["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 2200);
    assert_eq!(rows[0]["time_ns"], support::ORIGIN.to_string());
    assert_eq!(rows[0]["values"][1], "9007199254740993");
    assert!(rows[9]["values"][0].is_null());
    assert!(rows[10]["values"][2].is_null());
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(
            row["values"][1],
            (9_007_199_254_740_993_i64 + i as i64).to_string()
        );
        if i != 9 {
            let t = i as f64 / 100.;
            let expected = (t * 2.).sin() * 12. + (t * 7.).cos() * 2.;
            assert!((row["values"][0].as_f64().unwrap() - expected).abs() < 1e-12);
        }
    }
    assert_eq!(events.last().unwrap()["scanned_messages"], 2200);
}

#[tokio::test]
async fn state_stream_preserves_boolean_values() {
    let dir = fixture(4, false);
    let (status, events) = series(
        hahn::router(dir.path()).unwrap(),
        json!({"topic":"/telemetry", "fields":[["active"]]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows: Vec<_> = events
        .iter()
        .filter_map(|event| event["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|row| row["values"][0] == true));
}

#[tokio::test]
async fn state_stream_preserves_enum_labels() {
    let dir = fixture(4, false);
    let (status, events) = series(
        hahn::router(dir.path()).unwrap(),
        json!({"topic":"/telemetry", "fields":[["mode"]]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows: Vec<_> = events
        .iter()
        .filter_map(|event| event["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0]["values"][0], "IDLE");
    assert_eq!(rows[1]["values"][0], "ACTIVE");
}

#[tokio::test]
async fn inclusive_start_exclusive_end_and_empty_ranges() {
    let dir = fixture(2200, false);
    let app = hahn::router(dir.path()).unwrap();
    let (_, info) = get(app.clone(), "/api/files/0").await;
    assert_eq!(info["start_ns"], support::ORIGIN.to_string());
    assert!(info["message_count"].is_null());
    let (_, events) = series(app.clone(), json!({"topic":"/telemetry","fields":[["counter"]],"start_ns":(support::ORIGIN+10_000_000).to_string(),"end_ns":(support::ORIGIN+30_000_000).to_string()})).await;
    let rows: Vec<_> = events
        .iter()
        .filter_map(|e| e["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["values"][0], "9007199254740994");
    let (_, events) = series(
        app.clone(),
        json!({"topic":"/telemetry","fields":[["signal"]],"start_ns":"1","end_ns":"1"}),
    )
    .await;
    assert_eq!(
        events,
        vec![json!({"type":"complete","scanned_messages":0})]
    );
    for body in [
        json!({"topic":"/telemetry","fields":[]}),
        json!({"topic":"/telemetry","fields":[["signal"]],"start_ns":"bad"}),
        json!({"topic":"/telemetry","fields":[["signal"]],"start_ns":"2","end_ns":"1"}),
    ] {
        assert_eq!(series(app.clone(), body).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        series(app, json!({"topic":"/telemetry","fields":[["missing"]]}))
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn malformed_recording_and_symlink_escape() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("bad.mcap"), b"not MCAP").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/", dir.path().join("outside")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, files) = get(app.clone(), "/api/files").await;
    assert_eq!(files.as_array().unwrap().len(), 1);
    let (status, body) = get(app, "/api/files/0").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn first_batch_can_be_consumed_without_collecting_full_response() {
    let dir = fixture(30_000, true);
    let app = hahn::router(dir.path()).unwrap();
    let response = app
        .oneshot(
            Request::post("/api/files/0/series")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"topic":"/telemetry","fields":[["signal"]]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let mut body = response.into_body();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let first: Value = serde_json::from_slice(frame.data_ref().unwrap()).unwrap();
    assert_eq!(first["type"], "batch");
    assert!(first["scanned_messages"].as_u64().unwrap() <= 1024);
    // Dropping the body closes the bounded receiver and unblocks the producer.
    drop(body);
}

#[tokio::test]
async fn decode_failure_after_first_batch_is_an_error_event() {
    let dir = tempfile::tempdir().unwrap();
    support::write_fixture_with_options(&dir.path().join("broken.mcap"), 2200, true, Some(1500))
        .unwrap();
    let (status, events) = series(
        hahn::router(dir.path()).unwrap(),
        json!({"topic":"/telemetry","fields":[["signal"]]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(events[0]["type"], "batch");
    assert_eq!(events.last().unwrap()["type"], "error");
    assert!(events.iter().all(|e| e["type"] != "complete"));
}

#[tokio::test]
async fn unindexed_recordings_are_rejected_instead_of_silently_empty() {
    for summary in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = mcap::WriteOptions::new()
            .emit_summary_records(summary)
            .emit_message_indexes(false)
            .create(std::fs::File::create(dir.path().join("unindexed.mcap")).unwrap())
            .unwrap();
        let channel = writer
            .add_channel(0, "/raw", "unknown", &Default::default())
            .unwrap();
        writer
            .write_to_known_channel(
                &mcap::records::MessageHeader {
                    channel_id: channel,
                    sequence: 0,
                    log_time: 1,
                    publish_time: 1,
                },
                b"payload",
            )
            .unwrap();
        writer.finish().unwrap();
        let (status, body) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].is_string());
    }
}
