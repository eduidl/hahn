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
    stream(app, "/api/files/0/series", body).await
}
async fn stream(app: axum::Router, url: &str, body: Value) -> (StatusCode, Vec<Value>) {
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

#[tokio::test]
async fn metadata_includes_all_field_types() {
    let dir = fixture(2200, true);
    let app = hahn::router(dir.path()).unwrap();
    let (_, runs) = get(app.clone(), "/api/runs").await;
    assert_eq!(
        runs,
        json!({"items": [{"id": runs["items"][0]["id"], "name": "test.mcap"}], "truncated": false})
    );
    let (status, info) = get(app.clone(), "/g").await;
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
        (vec!["position", "x"], "float64"),
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
    // A long stream arrives in several batches.
    let (_, raw) = stream(
        hahn::router(dir.path()).unwrap(),
        "/g/messages",
        json!({"topic":"/telemetry","path":["signal"],"preview":false}),
    )
    .await;
    assert!(raw.len() >= 4);
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
            Request::get(format!(
                "{url}?topic=%2Ftelemetry&path=%5B%22signal%22%5D&preview=false"
            ))
            .body(Body::empty())
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

#[tokio::test]
async fn message_at_time_is_latest_at_or_before_with_named_fields() {
    let dir = fixture(300, true);
    let app = hahn::router(dir.path()).unwrap();
    let at = |t: u64| format!("/api/files/0/message?topic=/telemetry&time_ns={t}");
    // Between samples 25 and 26: the latest at or before wins.
    let (status, body) = get(app.clone(), &at(support::ORIGIN + 25 * 10_000_000 + 3)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["time_ns"],
        (support::ORIGIN + 25 * 10_000_000).to_string()
    );
    let value = body["value"].as_object().unwrap();
    // Schema order, exact 64-bit integers, nested structs and lists.
    assert_eq!(
        value.keys().collect::<Vec<_>>(),
        [
            "signal", "counter", "position", "label", "active", "tags", "mode"
        ]
    );
    assert_eq!(
        value["counter"],
        (9_007_199_254_740_993_i64 + 25).to_string()
    );
    assert!(value["position"]["x"].is_number());
    assert_eq!(value["tags"], json!(["test"]));
    // A field path returns that subtree only.
    let (_, body) = get(
        app.clone(),
        &format!(
            "{}&path=%5B%22position%22%5D",
            at(support::ORIGIN + 25 * 10_000_000)
        ),
    )
    .await;
    assert_eq!(
        body["value"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["x"]
    );
    // Before the first message the first one is shown; far after the end, the last.
    let (_, body) = get(app.clone(), &at(1)).await;
    assert_eq!(body["time_ns"], support::ORIGIN.to_string());
    let (_, body) = get(app.clone(), &at(support::ORIGIN + 3_600_000_000_000)).await;
    assert_eq!(
        body["time_ns"],
        (support::ORIGIN + 299 * 10_000_000).to_string()
    );
    let (status, _) = get(app, &at(0).replace("time_ns=0", "time_ns=abc")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

fn csv_fixture(name: &str, content: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(name), content).unwrap();
    dir
}

const CSV: &str = "\
time_ns,speed,count,ok,mode,pose.x,pose.y
1760000000000000300,3.5,3,true,drive,1,2.5
1760000000000000100,1.5,1,false,park,1,0.5
1760000000000000200,,2,true,drive,1,1.5
";

#[tokio::test]
async fn csv_is_one_topic_with_inferred_nested_fields() {
    let dir = csv_fixture("drive.csv", CSV);
    let app = hahn::router(dir.path()).unwrap();
    let (_, files) = get(app.clone(), "/api/files").await;
    assert_eq!(files[0]["name"], "drive.csv");
    assert_eq!(files[0]["format"], "csv");
    let (_, info) = get(app.clone(), "/api/files/0").await;
    assert_eq!(info["start_ns"], "1760000000000000100");
    assert_eq!(info["end_ns"], "1760000000000000300");
    assert_eq!(info["message_count"], 3);
    let (_, topics) = get(app.clone(), "/api/files/0/topics").await;
    assert_eq!(topics.as_array().unwrap().len(), 1);
    let topic = &topics[0];
    assert_eq!(topic["topic"], "/drive");
    assert_eq!(topic["schema_encoding"], "csv");
    assert_eq!(topic["message_count"], 3);
    let types: Vec<(Value, Value)> = topic["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].clone(), f["data_type"].clone()))
        .collect();
    assert_eq!(
        types,
        [
            (json!(["speed"]), json!("float64")),
            (json!(["count"]), json!("int64")),
            (json!(["ok"]), json!("bool")),
            (json!(["mode"]), json!("string")),
            (json!(["pose"]), types[4].1.clone()),
            (json!(["pose", "x"]), json!("int64")),
            (json!(["pose", "y"]), json!("float64")),
        ]
    );
}

#[tokio::test]
async fn csv_series_and_message_follow_the_shared_range_rules() {
    let dir = csv_fixture("drive.csv", CSV);
    let app = hahn::router(dir.path()).unwrap();
    let topic = "/drive";
    // Rows are sorted by time; empty cells are null; end is exclusive.
    let (status, events) = series(
        app.clone(),
        json!({"topic":topic,"fields":[["speed"],["pose","y"],["mode"]],
               "start_ns":"1760000000000000100","end_ns":"1760000000000000300"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        events[0]["rows"],
        json!([
            {"time_ns":"1760000000000000100","values":[1.5,0.5,"park"]},
            {"time_ns":"1760000000000000200","values":[null,1.5,"drive"]},
        ])
    );
    assert_eq!(events.last().unwrap()["type"], "complete");
    let (_, events) = series(
        app.clone(),
        json!({"topic":topic,"fields":[["count"]],
               "start_ns":"1760000000000000150","end_ns":"1760000000000000150"}),
    )
    .await;
    assert_eq!(events, [json!({"type":"complete","scanned_messages":0})]);

    let at = |t: &str| format!("/api/files/0/message?topic=/drive&time_ns={t}");
    let (_, body) = get(app.clone(), &at("1760000000000000250")).await;
    assert_eq!(body["time_ns"], "1760000000000000200");
    // Exact 64-bit integers are strings, as for MCAP.
    assert_eq!(body["value"]["pose"], json!({"x": "1", "y": 1.5}));
    let (_, body) = get(app.clone(), &at("1")).await;
    assert_eq!(body["time_ns"], "1760000000000000100");
    let (status, _) = series(app, json!({"topic":"/other","fields":[["count"]]})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn csv_time_units_and_malformed_files() {
    let dir = csv_fixture("a.csv", "t_ms,v\n1760000000000.5,1\n");
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
    assert_eq!(info["start_ns"], "1760000000000500000");
    let dir = csv_fixture("a.csv", "time,v\n1760000000.25,1\n");
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
    assert_eq!(info["start_ns"], "1760000000250000000");
    for content in [
        "time_ns,v\nsoon,1\n",
        "time_ns,v,v\n1,1,2\n",
        "time_ns,a,a.b\n1,1,2\n",
        "time_ns,v\n1,1,extra\n",
        "time_ns,v\n",
    ] {
        let dir = csv_fixture("bad.csv", content);
        let (status, body) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{content:?}");
        assert!(body["error"].is_string());
    }
}

fn parquet_fixture(name: &str, batch: arrow::array::RecordBatch) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let file = std::fs::File::create(dir.path().join(name)).unwrap();
    let mut writer = parquet::arrow::ArrowWriter::try_new(file, batch.schema(), None).unwrap();
    writer.write(&batch).unwrap();
    writer.close().unwrap();
    dir
}

fn drive_parquet() -> arrow::array::RecordBatch {
    use arrow::{
        array::{
            ArrayRef, DictionaryArray, Float64Array, Int64Array, ListArray, StructArray,
            TimestampNanosecondArray,
        },
        datatypes::{DataType, Field, Float64Type, Int32Type},
    };
    use std::sync::Arc;
    let pose = StructArray::from(vec![
        (
            Arc::new(Field::new("x", DataType::Float64, false)),
            Arc::new(Float64Array::from(vec![3.0, 1.0, 2.0])) as ArrayRef,
        ),
        (
            Arc::new(Field::new("y", DataType::Float64, false)),
            Arc::new(Float64Array::from(vec![30.0, 10.0, 20.0])) as ArrayRef,
        ),
    ]);
    let mode: DictionaryArray<Int32Type> = vec!["drive", "park", "drive"].into_iter().collect();
    arrow::array::RecordBatch::try_from_iter([
        (
            "time",
            Arc::new(TimestampNanosecondArray::from(vec![
                1_760_000_000_000_000_300,
                1_760_000_000_000_000_100,
                1_760_000_000_000_000_200,
            ])) as ArrayRef,
        ),
        (
            "speed",
            Arc::new(Float64Array::from(vec![Some(3.5), Some(1.5), None])) as ArrayRef,
        ),
        (
            "count",
            Arc::new(Int64Array::from(vec![3, 1, 2])) as ArrayRef,
        ),
        ("mode", Arc::new(mode) as ArrayRef),
        ("pose", Arc::new(pose) as ArrayRef),
        (
            "ranges",
            Arc::new(ListArray::from_iter_primitive::<Float64Type, _, _>(vec![
                Some(vec![Some(3.0)]),
                Some(vec![Some(1.0), Some(1.1)]),
                None,
            ])) as ArrayRef,
        ),
    ])
    .unwrap()
}

#[tokio::test]
async fn parquet_keeps_arrow_types_and_nesting() {
    let dir = parquet_fixture("drive.parquet", drive_parquet());
    let app = hahn::router(dir.path()).unwrap();
    let (_, files) = get(app.clone(), "/api/files").await;
    assert_eq!(files[0]["format"], "parquet");
    let (_, info) = get(app.clone(), "/api/files/0").await;
    assert_eq!(info["start_ns"], "1760000000000000100");
    assert_eq!(info["end_ns"], "1760000000000000300");
    assert_eq!(info["message_count"], 3);
    let (_, topics) = get(app.clone(), "/api/files/0/topics").await;
    assert_eq!(topics[0]["topic"], "/drive");
    assert_eq!(topics[0]["schema_encoding"], "parquet");
    let types: Vec<(Value, Value)> = topics[0]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].clone(), f["data_type"].clone()))
        .collect();
    let paths: Vec<_> = types.iter().map(|(p, _)| p.clone()).collect();
    assert_eq!(
        paths,
        [
            json!(["speed"]),
            json!(["count"]),
            json!(["mode"]),
            json!(["pose"]),
            json!(["pose", "x"]),
            json!(["pose", "y"]),
            json!(["ranges"]),
        ]
    );
    // Dictionaries are decoded to their value type.
    assert_eq!(types[2].1, "string");

    let (status, events) = series(
        app.clone(),
        json!({"topic":"/drive","fields":[["speed"],["pose","x"],["mode"]],
               "end_ns":"1760000000000000300"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        events[0]["rows"],
        json!([
            {"time_ns":"1760000000000000100","values":[1.5,1.0,"park"]},
            {"time_ns":"1760000000000000200","values":[null,2.0,"drive"]},
        ])
    );
    let at = |t: &str| format!("/api/files/0/message?topic=/drive&time_ns={t}");
    let (_, body) = get(app.clone(), &at("1760000000000000150")).await;
    assert_eq!(body["time_ns"], "1760000000000000100");
    assert_eq!(body["value"]["ranges"], json!([1.0, 1.1]));
    assert_eq!(body["value"]["pose"], json!({"x": 1.0, "y": 10.0}));
    assert_eq!(body["value"]["count"], "1");
}

#[tokio::test]
async fn parquet_time_units_and_malformed_files() {
    use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
    use std::sync::Arc;
    let batch = |time: ArrayRef| {
        arrow::array::RecordBatch::try_from_iter([
            ("t_ms", time),
            ("v", Arc::new(Int64Array::from(vec![1])) as ArrayRef),
        ])
        .unwrap()
    };
    let dir = parquet_fixture(
        "a.parquet",
        batch(Arc::new(Int64Array::from(vec![1_760_000_000_000]))),
    );
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
    assert_eq!(info["start_ns"], "1760000000000000000");
    let dir = parquet_fixture(
        "a.parquet",
        batch(Arc::new(Float64Array::from(vec![1_760_000_000_000.5]))),
    );
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
    assert_eq!(info["start_ns"], "1760000000000500000");
    for time in [
        Arc::new(StringArray::from(vec!["soon"])) as ArrayRef,
        Arc::new(Int64Array::from(vec![None])) as ArrayRef,
        Arc::new(Int64Array::from(vec![-1])) as ArrayRef,
    ] {
        let dir = parquet_fixture("bad.parquet", batch(time));
        let (status, body) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].is_string());
    }
    let dir = csv_fixture("bad.parquet", "not parquet");
    let (status, _) = get(hahn::router(dir.path()).unwrap(), "/api/files/0").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn messages_history_keeps_full_rows_and_subtree_selection() {
    let dir = fixture(2200, true);
    let app = hahn::router(dir.path()).unwrap();
    let (status, events) = stream(
        app.clone(),
        "/api/files/0/messages",
        json!({"topic":"/telemetry"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        events.last().unwrap(),
        &json!({"type":"complete","scanned_messages":2200})
    );
    let rows: Vec<_> = events
        .iter()
        .filter_map(|e| e["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 2200);
    let timestamp = (support::ORIGIN + 250_000_000).to_string();
    let row = rows.iter().find(|r| r["time_ns"] == timestamp).unwrap();
    assert_eq!(row["value"]["counter"], "9007199254741018");
    assert!(row["value"]["position"]["x"].is_number());
    assert_eq!(row["value"]["tags"], json!(["test"]));
    for path in [json!(["position"]), json!(["counter"]), json!(["tags"])] {
        let (status, events) = stream(
            app.clone(),
            "/api/files/0/messages",
            json!({"topic":"/telemetry","path":path}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let subtree = events
            .iter()
            .filter_map(|e| e["rows"].as_array())
            .flatten()
            .find(|r| r["time_ns"] == row["time_ns"])
            .unwrap();
        assert_eq!(subtree["value"], row["value"][path[0].as_str().unwrap()]);
    }
    for body in [
        json!({"topic":"/missing"}),
        json!({"topic":"/telemetry","path":["missing"]}),
    ] {
        assert_eq!(
            stream(app.clone(), "/api/files/0/messages", body).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}

#[tokio::test]
async fn messages_history_retains_nulls_and_duplicate_timestamps() {
    let dir = csv_fixture(
        "drive.csv",
        "time_ns,count,label\n1000000000,1,a\n1000000000,2,\n2000000000,3,b\n",
    );
    let app = hahn::router(dir.path()).unwrap();
    let (_, events) = stream(app, "/api/files/0/messages", json!({"topic":"/drive"})).await;
    let rows: Vec<_> = events
        .iter()
        .filter_map(|e| e["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["time_ns"], rows[1]["time_ns"]);
    assert_eq!(rows[0]["value"]["count"], "1");
    assert_eq!(rows[1]["value"]["label"], Value::Null);
}

#[tokio::test]
async fn messages_history_uses_raw_message_preview_limits() {
    use arrow::{
        array::{
            ArrayRef, BinaryArray, FixedSizeBinaryArray, Int64Array, ListArray, RecordBatch,
            StringArray,
        },
        datatypes::Int64Type,
    };
    use std::sync::Arc;
    let bytes = vec![7_u8; 50];
    let batch = RecordBatch::try_from_iter([
        ("time_ns", Arc::new(Int64Array::from(vec![1])) as ArrayRef),
        (
            "label",
            Arc::new(StringArray::from(vec!["あ".repeat(10_001)])) as ArrayRef,
        ),
        (
            "bytes",
            Arc::new(BinaryArray::from(vec![bytes.as_slice()])) as ArrayRef,
        ),
        (
            "fixed_bytes",
            Arc::new(FixedSizeBinaryArray::try_from_iter([bytes.as_slice()].into_iter()).unwrap())
                as ArrayRef,
        ),
        (
            "items",
            Arc::new(ListArray::from_iter_primitive::<Int64Type, _, _>([Some(
                (0..101).map(Some).collect::<Vec<_>>(),
            )])) as ArrayRef,
        ),
    ])
    .unwrap();
    let dir = parquet_fixture("preview.parquet", batch);
    let app = hahn::router(dir.path()).unwrap();
    let (_, events) = stream(app.clone(), "/g/messages", json!({"topic":"/preview"})).await;
    let value = &events[0]["rows"][0]["value"];
    assert_eq!(value["label"].as_str().unwrap().chars().count(), 10_001);
    assert!(value["label"].as_str().unwrap().ends_with('…'));
    assert_eq!(value["bytes"]["$bytes"], 50);
    assert_eq!(value["bytes"]["head"].as_array().unwrap().len(), 32);
    assert_eq!(value["fixed_bytes"], value["bytes"]);
    assert_eq!(value["items"]["$truncated"], true);
    assert_eq!(value["items"]["length"], 101);
    assert_eq!(value["items"]["items"].as_array().unwrap().len(), 100);
}

#[tokio::test]
async fn messages_history_reports_decode_errors_after_partial_data() {
    let dir = tempfile::tempdir().unwrap();
    support::write_fixture_with_options(&dir.path().join("broken.mcap"), 2200, true, Some(1500))
        .unwrap();
    let (status, events) = stream(
        hahn::router(dir.path()).unwrap(),
        "/api/files/0/messages",
        json!({"topic":"/telemetry"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(events[0]["type"], "batch");
    assert_eq!(events.last().unwrap()["type"], "error");
    assert!(events.iter().all(|e| e["type"] != "complete"));
}

#[tokio::test]
async fn message_windows_keep_timestamp_ties_and_validate_bounds() {
    let dir = csv_fixture(
        "window.csv",
        "time_ns,count\n1000000000,1\n2000000000,2\n2000000000,3\n3000000000,4\n",
    );
    let app = hahn::router(dir.path()).unwrap();
    let (status, events) = stream(
        app.clone(),
        "/api/files/0/messages",
        json!({
            "topic":"/window", "start_ns":"2000000000", "end_ns":"3000000000"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows: Vec<_> = events
        .iter()
        .filter_map(|e| e["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["value"]["count"], "2");
    assert_eq!(rows[1]["value"]["count"], "3");
    for (start, end) in [("bad", "3"), ("-1", "3"), ("3", "2")] {
        assert_eq!(
            stream(
                app.clone(),
                "/api/files/0/messages",
                json!({
                    "topic":"/window", "start_ns":start, "end_ns":end
                })
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn ros_uint8_sequences_use_list_previews() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer =
        mcap::Writer::new(std::fs::File::create(dir.path().join("bytes.mcap")).unwrap()).unwrap();
    let schema = writer
        .add_schema(
            "example/msg/Bytes",
            "ros2msg",
            b"uint8[] data\nuint8[<=128] bounded\n",
        )
        .unwrap();
    let channel = writer
        .add_channel(schema, "/bytes", "cdr", &Default::default())
        .unwrap();
    for (sequence, len) in [0_u32, 3, 101].into_iter().enumerate() {
        let mut cdr = vec![0, 1, 0, 0];
        for _ in 0..2 {
            while !cdr.len().is_multiple_of(4) {
                cdr.push(0);
            }
            cdr.extend_from_slice(&len.to_le_bytes());
            cdr.extend((0..len).map(|value| value as u8));
        }
        writer
            .write_to_known_channel(
                &mcap::records::MessageHeader {
                    channel_id: channel,
                    sequence: sequence as u32,
                    log_time: sequence as u64 + 1,
                    publish_time: sequence as u64 + 1,
                },
                &cdr,
            )
            .unwrap();
    }
    writer.finish().unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (status, topics) = get(app.clone(), "/api/files/0/topics").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(topics[0]["fields"][0]["data_type"], "list");
    assert_eq!(topics[0]["fields"][0]["type_name"], "uint8[]");
    assert_eq!(topics[0]["fields"][1]["type_name"], "uint8[<=128]");
    let (status, events) = stream(app, "/api/files/0/messages", json!({"topic":"/bytes"})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(events.iter().all(|event| event["type"] != "error"));
    let rows: Vec<_> = events
        .iter()
        .filter_map(|event| event["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 3);
    for field in ["data", "bounded"] {
        assert_eq!(rows[0]["value"][field], json!([]));
        assert_eq!(rows[1]["value"][field], json!([0, 1, 2]));
        assert_eq!(
            rows[2]["value"][field],
            json!({
                "$truncated": true, "length": 101, "items": (0..100).collect::<Vec<_>>()
            })
        );
    }
}
fn visual_app() -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    support::write_visual_fixture(&dir.path().join("visual.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    (dir, app)
}

#[tokio::test]
async fn frames_are_merged_from_every_transform_topic() {
    let (_dir, app) = visual_app();
    let (status, body) = get(app, "/r/frames").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["frames"],
        json!([
            {"id": "base_link", "parent": "map"},
            {"id": "lidar", "parent": "base_link"},
            {"id": "map", "parent": null},
        ])
    );
}

