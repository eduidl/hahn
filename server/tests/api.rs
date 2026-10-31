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

async fn raw_get(app: &axum::Router, url: &str) -> (StatusCode, Value) {
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
async fn resolve(app: &axum::Router, url: &str) -> String {
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
async fn get(app: axum::Router, url: &str) -> (StatusCode, Value) {
    let url = resolve(&app, url).await;
    raw_get(&app, &url).await
}
/// Every field of a schema tree by path, like a client walking it.
fn flat(fields: &Value, prefix: &[Value], out: &mut Vec<(Value, Value)>) {
    for field in fields.as_array().unwrap() {
        let mut path = prefix.to_vec();
        path.push(field["name"].clone());
        out.push((Value::Array(path.clone()), field.clone()));
        if field.get("fields").is_some() {
            flat(&field["fields"], &path, out);
        }
    }
}
fn flattened(fields: &Value) -> Vec<(Value, Value)> {
    let mut out = Vec::new();
    flat(fields, &[], &mut out);
    out
}
/// Percent-encodes everything but unreserved characters.
fn encode(value: &str) -> String {
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
async fn series(app: axum::Router, body: Value) -> (StatusCode, Vec<Value>) {
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
async fn stream(app: axum::Router, url: &str, query: Value) -> (StatusCode, Vec<Value>) {
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
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let telemetry = topics
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["topic"] == "/telemetry")
        .unwrap();
    let fields = flattened(&telemetry["fields"]);
    for (path, kind) in [
        (vec!["position"], "struct"),
        (vec!["position", "x"], "float64"),
        (vec!["label"], "string"),
        (vec!["active"], "bool"),
    ] {
        let (_, field) = fields.iter().find(|(p, _)| *p == json!(path)).unwrap();
        assert_eq!(field["data_type"], kind);
    }
    let (_, mode) = fields.iter().find(|(p, _)| *p == json!(["mode"])).unwrap();
    assert_eq!(mode["data_type"], "enum");
    assert_eq!(mode["type_name"], "hahn.Mode");
    assert_eq!(
        mode["enum_values"],
        json!([
            {"name":"IDLE", "value":"0"},
            {"name":"ACTIVE", "value":"1"}
        ])
    );
    let (_, position) = fields
        .iter()
        .find(|(p, _)| *p == json!(["position"]))
        .unwrap();
    assert_eq!(position["data_type"], "struct");
    assert_eq!(position["type_name"], "hahn.Position");
    assert!(fields.iter().any(|(p, _)| *p == json!(["tags"])));
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
    assert_eq!(get(app, "/api/runs/none").await.0, StatusCode::NOT_FOUND);
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
    let (_, info) = get(app.clone(), "/g").await;
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
    let (_, runs) = get(app.clone(), "/api/runs").await;
    assert_eq!(runs["items"].as_array().unwrap().len(), 1);
    let (status, body) = get(app, "/g").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn first_batch_can_be_consumed_without_collecting_full_response() {
    let dir = fixture(30_000, true);
    let app = hahn::router(dir.path()).unwrap();
    let url = resolve(&app, "/g/messages").await;
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
        let (status, body) = get(hahn::router(dir.path()).unwrap(), "/g").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].is_string());
    }
}

#[tokio::test]
async fn message_at_time_is_latest_at_or_before_with_named_fields() {
    let dir = fixture(300, true);
    let app = hahn::router(dir.path()).unwrap();
    let at = |t: u64| format!("/g/messages/latest?topic=/telemetry&time_ns={t}");
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
    // Before the first message there is nothing yet; far after the end, the last.
    let (_, body) = get(app.clone(), &at(1)).await;
    assert!(body.is_null());
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
    let (_, runs) = get(app.clone(), "/api/runs").await;
    assert_eq!(runs["items"][0]["name"], "drive.csv");
    let (_, info) = get(app.clone(), "/g").await;
    assert_eq!(info["start_ns"], "1760000000000000100");
    assert_eq!(info["end_ns"], "1760000000000000300");
    assert_eq!(info["message_count"], 3);
    let (_, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(topics.as_array().unwrap().len(), 1);
    let topic = &topics[0];
    assert_eq!(topic["topic"], "/drive");
    assert_eq!(topic["schema_encoding"], "csv");
    assert_eq!(topic["message_count"], 3);
    let types: Vec<(Value, Value)> = flattened(&topic["fields"])
        .into_iter()
        .map(|(path, f)| (path, f["data_type"].clone()))
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
            {"time_ns": "1760000000000000100", "values": [1.5, 0.5, "park"]},
            {"time_ns": "1760000000000000200", "values": [null, 1.5, "drive"]},
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

    let at = |t: &str| format!("/g/messages/latest?topic=/drive&time_ns={t}");
    let (_, body) = get(app.clone(), &at("1760000000000000250")).await;
    assert_eq!(body["time_ns"], "1760000000000000200");
    // Exact 64-bit integers are strings, as for MCAP.
    assert_eq!(body["value"]["pose"], json!({"x": "1", "y": 1.5}));
    let (_, body) = get(app.clone(), &at("1")).await;
    assert!(body.is_null());
    let (status, _) = series(app, json!({"topic":"/other","fields":[["count"]]})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn csv_time_units_and_malformed_files() {
    let dir = csv_fixture("a.csv", "t_ms,v\n1760000000000.5,1\n");
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/g").await;
    assert_eq!(info["start_ns"], "1760000000000500000");
    let dir = csv_fixture("a.csv", "time,v\n1760000000.25,1\n");
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/g").await;
    assert_eq!(info["start_ns"], "1760000000250000000");
    for content in [
        "time_ns,v\nsoon,1\n",
        "time_ns,v,v\n1,1,2\n",
        "time_ns,a,a.b\n1,1,2\n",
        "time_ns,$bytes\n1,1\n",
        "time_ns,pose.$x\n1,1\n",
        "time_ns,v\n1,1,extra\n",
        "time_ns,v\n",
    ] {
        let dir = csv_fixture("bad.csv", content);
        let (status, body) = get(hahn::router(dir.path()).unwrap(), "/g").await;
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
    let (_, runs) = get(app.clone(), "/api/runs").await;
    assert_eq!(runs["items"][0]["name"], "drive.parquet");
    let (_, info) = get(app.clone(), "/g").await;
    assert_eq!(info["start_ns"], "1760000000000000100");
    assert_eq!(info["end_ns"], "1760000000000000300");
    assert_eq!(info["message_count"], 3);
    let (_, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(topics[0]["topic"], "/drive");
    assert_eq!(topics[0]["schema_encoding"], "parquet");
    let types: Vec<(Value, Value)> = flattened(&topics[0]["fields"])
        .into_iter()
        .map(|(path, f)| (path, f["data_type"].clone()))
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
            {"time_ns": "1760000000000000100", "values": [1.5, 1.0, "park"]},
            {"time_ns": "1760000000000000200", "values": [null, 2.0, "drive"]},
        ])
    );
    let at = |t: &str| format!("/g/messages/latest?topic=/drive&time_ns={t}");
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
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/g").await;
    assert_eq!(info["start_ns"], "1760000000000000000");
    let dir = parquet_fixture(
        "a.parquet",
        batch(Arc::new(Float64Array::from(vec![1_760_000_000_000.5]))),
    );
    let (_, info) = get(hahn::router(dir.path()).unwrap(), "/g").await;
    assert_eq!(info["start_ns"], "1760000000000500000");
    for time in [
        Arc::new(StringArray::from(vec!["soon"])) as ArrayRef,
        Arc::new(Int64Array::from(vec![None])) as ArrayRef,
        Arc::new(Int64Array::from(vec![-1])) as ArrayRef,
    ] {
        let dir = parquet_fixture("bad.parquet", batch(time));
        let (status, body) = get(hahn::router(dir.path()).unwrap(), "/g").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].is_string());
    }
    let dir = csv_fixture("bad.parquet", "not parquet");
    let (status, _) = get(hahn::router(dir.path()).unwrap(), "/g").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn messages_history_keeps_full_rows_and_subtree_selection() {
    let dir = fixture(2200, true);
    let app = hahn::router(dir.path()).unwrap();
    let (status, events) = stream(app.clone(), "/g/messages", json!({"topic":"/telemetry"})).await;
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
    let value = &row["value"];
    assert_eq!(value["counter"], "9007199254741018");
    assert!(value["position"]["x"].is_number());
    assert_eq!(value["tags"], json!(["test"]));
    for path in [json!(["position"]), json!(["counter"]), json!(["tags"])] {
        let (status, events) = stream(
            app.clone(),
            "/g/messages",
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
            stream(app.clone(), "/g/messages", body).await.0,
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
    let (_, events) = stream(app, "/g/messages", json!({"topic":"/drive"})).await;
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
        "/g/messages",
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
        "/g/messages",
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
                "/g/messages",
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
    let (status, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(topics[0]["fields"][0]["data_type"], "list");
    assert_eq!(topics[0]["fields"][0]["element"]["data_type"], "uint8");
    assert_eq!(topics[0]["fields"][0]["type_name"], "uint8[]");
    assert_eq!(topics[0]["fields"][1]["type_name"], "uint8[<=128]");
    let (status, events) = stream(app, "/g/messages", json!({"topic":"/bytes"})).await;
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

#[tokio::test]
async fn extractor_rejections_are_json_errors() {
    let dir = fixture(10, true);
    let app = hahn::router(dir.path()).unwrap();
    let base = resolve(&app, "/g").await;
    let requests = [
        (
            Request::get(format!("{base}/messages/latest?topic=x")).body(Body::empty()),
            StatusCode::BAD_REQUEST,
        ),
        (
            Request::get(format!("{base}/messages")).body(Body::empty()),
            StatusCode::BAD_REQUEST,
        ),
        (
            Request::get(format!("{base}/messages?topic=x&preview=maybe")).body(Body::empty()),
            StatusCode::BAD_REQUEST,
        ),
        (
            Request::get(format!("{base}/messages?topic=x&path=nope")).body(Body::empty()),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (request, expected) in requests {
        let response = app.clone().oneshot(request.unwrap()).await.unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["content-type"], "application/json");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert!(!body["error"].as_str().unwrap().is_empty());
    }
}

fn segment_fixture(dir: &std::path::Path, name: &str, count: usize, offset_ns: u64) {
    support::write_fixture_at(&dir.join(name), count, true, None, offset_ns).unwrap();
}

async fn run_names(app: &axum::Router) -> Vec<(String, Vec<String>)> {
    let (_, runs) = raw_get(app, "/api/runs").await;
    let mut names = Vec::new();
    for run in runs["items"].as_array().unwrap() {
        let (_, detail) = raw_get(app, &format!("/api/runs/{}", run["id"].as_str().unwrap())).await;
        let groups = detail["groups"].as_array().unwrap();
        assert!(groups.iter().all(|g| g["default_open"] == true));
        names.push((
            detail["name"].as_str().unwrap().to_owned(),
            groups
                .iter()
                .map(|g| g["name"].as_str().unwrap().to_owned())
                .collect(),
        ));
    }
    names
}

#[tokio::test]
async fn data_directory_maps_onto_runs_and_groups() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let csv = "t_ns,v\n1,1\n";
    std::fs::write(root.join("single.csv"), csv).unwrap();
    std::fs::write(root.join("ignored.txt"), "x").unwrap();
    std::fs::create_dir_all(root.join("empty")).unwrap();
    // A plain run: numbered files stay separate without a bag's metadata.
    std::fs::create_dir_all(root.join("drive/nested")).unwrap();
    std::fs::write(root.join("drive/cam_0.csv"), csv).unwrap();
    std::fs::write(root.join("drive/cam_1.csv"), csv).unwrap();
    std::fs::write(root.join("drive/nested/imu.csv"), csv).unwrap();
    // A bag inside a run is one group.
    std::fs::create_dir_all(root.join("drive/bag")).unwrap();
    std::fs::write(root.join("drive/bag/metadata.yaml"), "").unwrap();
    std::fs::write(root.join("drive/bag/bag_0.csv"), csv).unwrap();
    std::fs::write(root.join("drive/bag/bag_1.csv"), "t_ns,v\n2,1\n").unwrap();
    // A bag at the top level is a run with one group.
    std::fs::create_dir_all(root.join("alone")).unwrap();
    std::fs::write(root.join("alone/metadata.yaml"), "").unwrap();
    std::fs::write(root.join("alone/alone_0.csv"), csv).unwrap();
    let app = hahn::router(root).unwrap();
    let group = |name: &str| name.to_owned();
    assert_eq!(
        run_names(&app).await,
        vec![
            ("alone".to_owned(), vec![group("alone")]),
            (
                "drive".to_owned(),
                vec![
                    group("bag"),
                    group("cam_0.csv"),
                    group("cam_1.csv"),
                    group("nested/imu.csv"),
                ],
            ),
            ("single.csv".to_owned(), vec![group("single.csv")]),
        ]
    );
    let (_, runs) = raw_get(&app, "/api/runs").await;
    let run = runs["items"][0]["id"].as_str().unwrap();
    assert_eq!(
        raw_get(&app, &format!("/api/runs/{run}/groups/none"))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    // Ids survive a restart, unlike list positions.
    let again = hahn::router(root).unwrap();
    assert_eq!(raw_get(&again, "/api/runs").await.1, runs);
}

#[tokio::test]
async fn numbered_files_of_a_bag_read_as_one_recording() {
    const COUNT: usize = 100;
    let dir = tempfile::tempdir().unwrap();
    let bag = dir.path().join("bag");
    std::fs::create_dir_all(&bag).unwrap();
    std::fs::write(bag.join("metadata.yaml"), "").unwrap();
    // Numbered out of lexical order: segment 10 comes after segment 2.
    let span = COUNT as u64 * 10_000_000;
    segment_fixture(&bag, "bag_2.mcap", COUNT, 0);
    segment_fixture(&bag, "bag_10.mcap", COUNT, span);
    let app = hahn::router(dir.path()).unwrap();
    assert_eq!(
        run_names(&app).await,
        vec![("bag".to_owned(), vec!["bag".to_owned()])]
    );

    let (_, info) = get(app.clone(), "/g").await;
    assert_eq!(info["start_ns"], support::ORIGIN.to_string());
    assert_eq!(info["message_count"], 4 * COUNT);
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let telemetry: Vec<_> = topics
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["topic"] == "/telemetry")
        .collect();
    assert_eq!(telemetry.len(), 2);
    assert_ne!(telemetry[0]["id"], telemetry[1]["id"]);
    for (i, topic) in telemetry.iter().enumerate() {
        assert_eq!(topic["message_count"], COUNT);
        let (status, events) = series(
            app.clone(),
            json!({"topic":topic["id"],"fields":[["counter"]]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let rows: Vec<_> = events
            .iter()
            .filter_map(|e| e["rows"].as_array())
            .flatten()
            .collect();
        assert_eq!(rows.len(), COUNT);
        assert_eq!(
            rows[0]["time_ns"],
            (support::ORIGIN + span * i as u64).to_string()
        );
    }
}

#[tokio::test]
async fn a_topic_missing_from_one_segment_is_still_readable() {
    let dir = tempfile::tempdir().unwrap();
    let bag = dir.path().join("bag");
    std::fs::create_dir_all(&bag).unwrap();
    std::fs::write(bag.join("metadata.yaml"), "").unwrap();
    // A CSV's topic is its file name, so these segments share no topic.
    std::fs::write(bag.join("bag_0.csv"), "t_ns,v\n1,1\n").unwrap();
    std::fs::write(bag.join("bag_1.csv"), "t_ns,v\n2,2\n").unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let topic = topics
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["topic"] == "/bag_1")
        .unwrap();
    let (_, events) = series(app.clone(), json!({"topic":topic["id"],"fields":[["v"]]})).await;
    assert_eq!(events[0]["rows"][0]["time_ns"], "2");
    assert_eq!(events.last().unwrap()["type"], "complete");
    let (status, _) = series(app, json!({"topic":"/nope","fields":[["v"]]})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn overlapping_segments_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let bag = dir.path().join("bag");
    std::fs::create_dir_all(&bag).unwrap();
    std::fs::write(bag.join("metadata.yaml"), "").unwrap();
    segment_fixture(&bag, "bag_0.mcap", 100, 0);
    segment_fixture(&bag, "bag_1.mcap", 100, 10_000_000);
    let (status, body) = get(hahn::router(dir.path()).unwrap(), "/g").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["error"].as_str().unwrap().contains("overlap"),
        "{body}"
    );
}

#[tokio::test]
async fn runs_are_filtered_and_limited() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["Morning.csv", "morning_2.csv", "night.csv"] {
        std::fs::write(dir.path().join(name), "t_ns,v\n1,1\n").unwrap();
    }
    let app = hahn::router(dir.path()).unwrap();
    let names = |body: &Value| -> Vec<String> {
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let (_, all) = raw_get(&app, "/api/runs").await;
    assert_eq!(names(&all).len(), 3);
    assert_eq!(all["truncated"], false);
    let (_, found) = raw_get(&app, "/api/runs?q=MORN").await;
    assert_eq!(names(&found), ["Morning.csv", "morning_2.csv"]);
    let (_, limited) = raw_get(&app, "/api/runs?q=morn&limit=1").await;
    assert_eq!(names(&limited), ["Morning.csv"]);
    assert_eq!(limited["truncated"], true);
    let (_, exact) = raw_get(&app, "/api/runs?q=morn&limit=2").await;
    assert_eq!(exact["truncated"], false);
    let (_, none) = raw_get(&app, "/api/runs?q=nope").await;
    assert_eq!(none, json!({"items": [], "truncated": false}));
    for limit in ["0", "201", "x"] {
        let (status, body) = raw_get(&app, &format!("/api/runs?limit={limit}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{limit}");
        assert!(body["error"].is_string());
    }
}

#[tokio::test]
async fn gzip_applies_only_when_enabled_and_accepted() {
    let dir = fixture(10, true);
    let encoding = |app: axum::Router, accept: bool| async move {
        let mut request = Request::get("/api/runs");
        if accept {
            request = request.header("accept-encoding", "gzip");
        }
        let response = app
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        response.headers().get("content-encoding").cloned()
    };
    let plain = hahn::router(dir.path()).unwrap();
    assert_eq!(encoding(plain, true).await, None);
    let gzip = hahn::gzip(hahn::router(dir.path()).unwrap());
    assert_eq!(encoding(gzip.clone(), false).await, None);
    assert_eq!(encoding(gzip, true).await.unwrap(), "gzip");
}

#[tokio::test]
async fn exact_values_do_not_shorten_strings_and_require_a_scalar() {
    let long = "x".repeat(10_050);
    let dir = csv_fixture("drive.csv", &format!("t_ns,label\n1,{long}\n"));
    let app = hahn::router(dir.path()).unwrap();
    let read = |preview: bool| {
        stream(
            app.clone(),
            "/g/messages",
            json!({"topic":"/drive","path":["label"],"preview":preview}),
        )
    };
    let (_, exact) = read(false).await;
    assert_eq!(exact[0]["rows"][0]["value"], long);
    let (_, shortened) = read(true).await;
    assert_ne!(shortened[0]["rows"][0]["value"], long);
    let (status, _) = stream(
        app,
        "/g/messages",
        json!({"topic":"/drive","preview":false}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn meta_fields_read_times_recorded_beside_the_message() {
    let dir = fixture(10, true);
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(
        topics[0]["meta_fields"],
        json!([
            {"name":"log_time","data_type":"uint64","type_name":"uint64"},
            {"name":"publish_time","data_type":"uint64","type_name":"uint64"},
        ])
    );
    let read = |meta: &'static str| {
        stream(
            app.clone(),
            "/g/messages",
            json!({"topic":"/telemetry","meta":meta}),
        )
    };
    let (_, published) = read("publish_time").await;
    let row = &published[0]["rows"][0];
    assert_eq!(row["time_ns"], support::ORIGIN.to_string());
    assert_eq!(
        row["value"],
        (support::ORIGIN + support::PUBLISH_DELAY_NS).to_string()
    );
    let (_, logged) = read("log_time").await;
    assert_eq!(logged[0]["rows"][0]["value"], support::ORIGIN.to_string());
    let (status, _) = read("nope").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = stream(
        app.clone(),
        "/g/messages",
        json!({"topic":"/telemetry","meta":"log_time","path":["signal"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let at = support::ORIGIN + 3;
    let (_, latest) = get(
        app,
        &format!("/g/messages/latest?topic=/telemetry&meta=publish_time&time_ns={at}"),
    )
    .await;
    assert_eq!(
        latest["value"],
        (support::ORIGIN + support::PUBLISH_DELAY_NS).to_string()
    );
    // Formats without them list none.
    let dir = csv_fixture("drive.csv", "t_ns,v\n1,1\n");
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app, "/g/topics").await;
    assert_eq!(topics[0]["meta_fields"], json!([]));
}

#[tokio::test]
async fn parquet_rejects_reserved_field_names() {
    use arrow::{
        array::{ArrayRef, Float64Array, RecordBatch, TimestampNanosecondArray},
        datatypes::{DataType, Field, Schema, TimeUnit},
    };
    use std::sync::Arc;
    let schema = Schema::new(vec![
        Field::new(
            "time",
            DataType::Timestamp(TimeUnit::Nanosecond, None),
            false,
        ),
        Field::new("$bytes", DataType::Float64, false),
    ]);
    let columns: Vec<ArrayRef> = vec![
        Arc::new(TimestampNanosecondArray::from(vec![1])),
        Arc::new(Float64Array::from(vec![1.0])),
    ];
    let batch = RecordBatch::try_new(Arc::new(schema), columns).unwrap();
    let dir = parquet_fixture("bad.parquet", batch);
    let (status, body) = get(hahn::router(dir.path()).unwrap(), "/g").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["error"].as_str().unwrap().contains("reserved"),
        "{body}"
    );
}

#[tokio::test]
async fn runs_declare_the_configured_timezone() {
    let dir = fixture(10, true);
    let declared = |app: axum::Router| async move {
        let url = resolve(&app, "/g").await;
        let run = url.split("/groups/").next().unwrap().to_owned();
        raw_get(&app, &run).await.1["timezone"].clone()
    };
    let plain = hahn::router(dir.path()).unwrap();
    assert_eq!(declared(plain).await, Value::Null);
    let tokyo = hahn::router_with_timezone(dir.path(), Some("Asia/Tokyo".into())).unwrap();
    assert_eq!(declared(tokyo).await, "Asia/Tokyo");
}

#[tokio::test]
async fn a_group_without_messages_has_no_time_range() {
    for stats in [true, false] {
        let dir = fixture(0, stats);
        let (status, body) = get(hahn::router(dir.path()).unwrap(), "/g").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "stats: {stats}");
        assert!(body["error"].is_string());
    }
}

fn visual_app() -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    support::write_visual_fixture(&dir.path().join("visual.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    (dir, app)
}

/// The headers of a frames response, each with its payload.
async fn frames(app: &axum::Router, url: &str) -> (StatusCode, Vec<(Value, Vec<u8>)>) {
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

fn view_url(path: &str, topic: &str, view: &str, query: &str) -> String {
    format!("/g/{path}?topic={topic}&view={view}{query}")
}

#[tokio::test]
async fn topics_declare_their_views_from_the_schema() {
    let (_dir, app) = visual_app();
    let (_, topics) = get(app, "/g/topics").await;
    let views = |name: &str| {
        topics
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["topic"] == name)
            .unwrap()["views"]
            .clone()
    };
    assert_eq!(views("/camera")[0]["kind"], "image");
    assert_eq!(views("/lidar")[0]["kind"], "pointcloud");
    assert_eq!(views("/gps")[0]["kind"], "geo");
    // Transforms are the frame graph, not a view.
    assert_eq!(views("/tf"), json!([]));

    let (_dir, app) = {
        let dir = fixture(1, true);
        let app = hahn::router(dir.path()).unwrap();
        (dir, app)
    };
    let (_, topics) = get(app, "/g/topics").await;
    assert_eq!(topics[0]["views"], json!([]));
}

struct CustomImage;

impl hahn::ImageConverter for CustomImage {
    fn id(&self) -> &'static str {
        "custom-image"
    }
    fn name(&self) -> &'static str {
        "Custom image"
    }
    fn accepts(&self, schema_name: &str, defs: &hahn::FieldDefs) -> bool {
        schema_name == "foxglove.CompressedImage" && defs.iter().any(|field| field.name == "data")
    }
    fn convert(&self, message: &hahn::Message<'_>) -> anyhow::Result<hahn::ImageView> {
        Ok(hahn::ImageView {
            frame_id: None,
            format: "PNG".into(),
            data: message.bytes("data")?,
        })
    }
}

#[tokio::test]
async fn external_image_converter_is_declared_and_served() {
    let dir = tempfile::tempdir().unwrap();
    support::write_visual_fixture(&dir.path().join("visual.mcap")).unwrap();
    let app = hahn::router_with_image_converters(
        dir.path(),
        None,
        vec![std::sync::Arc::new(CustomImage)],
    )
    .unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let camera = topics
        .as_array()
        .unwrap()
        .iter()
        .find(|topic| topic["topic"] == "/camera")
        .unwrap();
    assert!(
        camera["views"]
            .as_array()
            .unwrap()
            .iter()
            .any(|view| view["id"] == "image")
    );
    assert!(
        camera["views"]
            .as_array()
            .unwrap()
            .iter()
            .any(|view| view["id"] == "custom-image" && view["kind"] == "image")
    );
    let time = support::ORIGIN + support::VISUAL_STEP_NS;
    let (status, events) = frames(
        &app,
        &view_url(
            "views/latest",
            "/camera",
            "custom-image",
            &format!("&time_ns={time}"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let value = &events[0].0["value"];
    assert_eq!(value["format"], "png");
    let offset = value["data"]["$blob"]["offset"].as_u64().unwrap() as usize;
    let len = value["data"]["$blob"]["length"].as_u64().unwrap() as usize;
    assert_eq!(&events[0].1[offset..offset + len], support::PNG);
    assert!(
        hahn::router_with_image_converters(
            dir.path(),
            None,
            vec![
                std::sync::Arc::new(CustomImage),
                std::sync::Arc::new(CustomImage)
            ]
        )
        .is_err()
    );
}

#[tokio::test]
async fn image_frames_carry_the_recorded_bytes() {
    let (_dir, app) = visual_app();
    let time = support::ORIGIN + support::VISUAL_STEP_NS;
    let url = view_url(
        "views/latest",
        "/camera",
        "image",
        &format!("&time_ns={time}"),
    );
    let (status, events) = frames(&app, &url).await;
    assert_eq!(status, StatusCode::OK);
    let (header, payload) = &events[0];
    assert_eq!(header["type"], "frame");
    assert_eq!(header["time_ns"], time.to_string());
    let value = &header["value"];
    assert_eq!(value["kind"], "image");
    assert_eq!(value["format"], "png");
    assert_eq!(value["frame_id"], "camera");
    let (offset, length) = (
        value["data"]["$blob"]["offset"].as_u64().unwrap() as usize,
        value["data"]["$blob"]["length"].as_u64().unwrap() as usize,
    );
    assert_eq!(&payload[offset..offset + length], support::PNG);
    assert_eq!(
        events[1].0,
        json!({"type": "complete", "scanned_messages": 1})
    );
}

#[tokio::test]
async fn a_message_failing_conversion_does_not_end_the_stream() {
    let (_dir, app) = visual_app();
    let (status, events) = frames(&app, &view_url("views", "/camera", "image", "")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(events.len(), support::VISUAL_COUNT + 1);
    let bad = &events[support::BAD_IMAGE].0;
    assert!(bad["error"].as_str().unwrap().contains("bmp"));
    assert!(bad.get("value").is_none());
    assert!(events[support::BAD_IMAGE + 1].0["value"].is_object());
    assert_eq!(events.last().unwrap().0["type"], "complete");
}

#[tokio::test]
async fn point_frames_hold_a_column_per_field() {
    let (_dir, app) = visual_app();
    let start = support::ORIGIN + support::VISUAL_STEP_NS;
    let query = format!("&start_ns={start}&end_ns={}", start + 1);
    let (_, events) = frames(&app, &view_url("views", "/lidar", "pointcloud", &query)).await;
    assert_eq!(events.len(), 2);
    let (header, payload) = &events[0];
    let value = &header["value"];
    assert_eq!(value["count"], 2);
    assert_eq!(value["pose"]["orientation"], json!([0.0, 0.0, 0.0, 1.0]));
    let blob = |reference: &Value| {
        let (offset, length) = (
            reference["$blob"]["offset"].as_u64().unwrap() as usize,
            reference["$blob"]["length"].as_u64().unwrap() as usize,
        );
        assert_eq!(offset % 8, 0);
        &payload[offset..offset + length]
    };
    let positions: Vec<f32> = blob(&value["positions"])
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    assert_eq!(positions, [1., 0., 1., 2., 0., 1.]);
    let field = &value["fields"][0];
    assert_eq!(field["name"], "intensity");
    assert_eq!(field["type"], "u8");
    assert_eq!(blob(&field["data"]), [1, 2]);
    assert_eq!(value["fields"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn location_frames_are_geojson_in_longitude_order() {
    let (_dir, app) = visual_app();
    let query = format!("&time_ns={}", support::ORIGIN);
    let (_, events) = frames(&app, &view_url("views/latest", "/gps", "geo", &query)).await;
    let feature = &events[0].0["value"]["features"][0];
    assert_eq!(
        feature["geometry"],
        json!({"type": "Point", "coordinates": [139.76, 35.68, 40.0]})
    );
    assert_eq!(feature["properties"]["accuracy_m"], 3.0);
    assert!(events[0].1.is_empty());
}

#[tokio::test]
async fn latest_view_reports_nothing_and_unchanged_frames() {
    let (_dir, app) = visual_app();
    let camera = |query: String| view_url("views/latest", "/camera", "image", &query);
    let (status, events) = frames(&app, &camera("&time_ns=1".into())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        events[0].0,
        json!({"type": "complete", "scanned_messages": 0})
    );

    let time = support::ORIGIN + support::VISUAL_STEP_NS;
    // Later than the held frame but before the next one: the same message is current.
    let query = format!("&time_ns={}&known_time_ns={time}", time + 5);
    let (_, events) = frames(&app, &camera(query)).await;
    assert_eq!(events[0].0, json!({"type": "unchanged"}));
    assert!(events[0].1.is_empty());
    assert_eq!(events[1].0["type"], "complete");

    let query = format!("&time_ns={}&known_time_ns={}", time, support::ORIGIN);
    let (_, events) = frames(&app, &camera(query)).await;
    assert_eq!(events[0].0["type"], "frame");
}

#[tokio::test]
async fn views_validate_their_requests() {
    let (_dir, app) = visual_app();
    let cases = [
        (view_url("views/latest", "/camera", "image", ""), 400),
        (
            view_url("views/latest", "/camera", "image", "&time_ns=x"),
            400,
        ),
        (
            view_url(
                "views/latest",
                "/camera",
                "image",
                "&time_ns=1&known_time_ns=x",
            ),
            400,
        ),
        (
            view_url("views", "/camera", "image", "&start_ns=2&end_ns=1"),
            400,
        ),
        (view_url("views", "/camera", "nope", ""), 422),
        (view_url("views", "/nope", "image", ""), 422),
        (view_url("views", "/tf", "image", ""), 422),
    ];
    for (url, expected) in cases {
        let (status, _) = frames(&app, &url).await;
        assert_eq!(status.as_u16(), expected, "{url}");
    }
    let error = resolve(&app, &view_url("views", "/camera", "nope", "")).await;
    let (_, body) = raw_get(&app, &error).await;
    assert!(body["error"].as_str().unwrap().contains("nope"));
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

#[tokio::test]
async fn duplicate_topic_images_have_independent_views() {
    let dir = tempfile::tempdir().unwrap();
    support::write_duplicate_images(&dir.path().join("images.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let topics = topics.as_array().unwrap();
    assert_eq!(topics.len(), 2);
    assert_ne!(topics[0]["id"], topics[1]["id"]);
    for (i, topic) in topics.iter().enumerate() {
        assert_eq!(topic["topic"], "/camera");
        let id = topic["id"].as_str().unwrap();
        let (status, events) =
            frames(&app, &view_url("views/latest", id, "image", "&time_ns=100")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            events[0].0["value"]["frame_id"],
            format!("camera-{}", 50 + i)
        );
    }
}

#[tokio::test]
async fn batched_transforms_are_merged_from_multiple_channels() {
    let dir = tempfile::tempdir().unwrap();
    support::write_batch_tf_fixture(&dir.path().join("batch.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let static_topics: Vec<_> = topics
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["topic"] == "/tf-static")
        .collect();
    assert_eq!(static_topics.len(), 4);
    assert_eq!(
        static_topics
            .iter()
            .map(|t| t["message_count"].as_u64().unwrap())
            .sum::<u64>(),
        3
    );
    assert!(static_topics.iter().all(|t| t["error"].is_null()));
    assert_ne!(static_topics[0]["id"], static_topics[1]["id"]);
    for topic in static_topics.iter().filter(|t| t["message_count"] == 1) {
        let id = topic["id"].as_str().unwrap();
        let (_, messages) = stream(app.clone(), "/g/messages", json!({"topic":id})).await;
        assert_eq!(
            messages
                .iter()
                .filter_map(|e| e["rows"].as_array())
                .map(Vec::len)
                .sum::<usize>(),
            1
        );
        let (status, latest) = get(
            app.clone(),
            &format!("/g/messages/latest?topic={id}&time_ns=20"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(latest["value"].is_object());
    }
    let (_, frames) = get(app.clone(), "/r/frames").await;
    assert_eq!(
        frames["frames"],
        json!([
            {"id":"base", "parent":"map"},
            {"id":"camera", "parent":"base"},
            {"id":"imu", "parent":"base"},
            {"id":"lidar", "parent":"base"},
            {"id":"map", "parent":null},
        ])
    );
    let (_, current) = get(app.clone(), "/r/transforms?target=map&time_ns=15").await;
    assert_eq!(
        current["frames"]["camera"]["translation"],
        json!([18.0, 0.0, 0.0])
    );
    assert_eq!(
        current["frames"]["lidar"]["translation"],
        json!([19.0, 0.0, 0.0])
    );
    assert_eq!(
        current["frames"]["imu"]["translation"],
        json!([20.0, 0.0, 0.0])
    );
    let (_, early) = get(app, "/r/transforms?target=base&time_ns=0").await;
    assert_eq!(
        early["frames"]["camera"]["translation"],
        json!([3.0, 0.0, 0.0])
    );
    assert!(early["frames"].get("map").is_none());
}

#[tokio::test]
async fn transforms_resolve_the_graph_at_a_time() {
    let (_dir, app) = visual_app();
    let time = support::ORIGIN + support::VISUAL_STEP_NS + support::VISUAL_STEP_NS / 2;
    let url = format!("/r/transforms?target=map&time_ns={time}");
    let (status, body) = get(app.clone(), &url).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["target"], "map");
    assert_eq!(body["time_ns"], time.to_string());
    assert_eq!(body["frames"]["map"]["translation"], json!([0.0, 0.0, 0.0]));
    assert_eq!(
        body["frames"]["base_link"]["translation"],
        json!([1.5, 0.0, 0.0])
    );
    assert_eq!(
        body["frames"]["lidar"]["translation"],
        json!([1.5, 0.0, 2.0])
    );

    // Outside the dynamic samples only what the static edge connects remains.
    let (_, body) = get(app.clone(), "/r/transforms?target=lidar&time_ns=1").await;
    assert!(body["frames"].get("base_link").is_some());
    assert!(body["frames"].get("map").is_none());

    let (status, _) = get(app.clone(), "/r/transforms?target=nope&time_ns=1").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = get(app.clone(), "/r/transforms?target=map&time_ns=x").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = get(app, "/r/transforms?target=map").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn frames_span_the_groups_of_a_run() {
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("drive");
    std::fs::create_dir(&run).unwrap();
    // The first group holds no transforms, and another cannot be read at all.
    support::write_fixture(&run.join("a.mcap"), 1, true).unwrap();
    std::fs::write(run.join("b.mcap"), b"not a recording").unwrap();
    support::write_visual_fixture(&run.join("c.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (status, body) = get(app.clone(), "/r/frames").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["frames"].as_array().unwrap().len(), 3);
    let url = format!("/r/transforms?target=map&time_ns={}", support::ORIGIN);
    let (status, body) = get(app.clone(), &url).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["frames"].get("lidar").is_some());
    let (status, _) = get(app, "/api/runs/no-such-run/frames").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_run_without_transforms_has_no_frames() {
    let dir = fixture(1, true);
    let app = hahn::router(dir.path()).unwrap();
    let (status, body) = get(app.clone(), "/r/frames").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"frames": []}));
    let (status, _) = get(app, "/r/transforms?target=map&time_ns=1").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn gzip_leaves_frames_alone() {
    let (_dir, app) = visual_app();
    let app = hahn::gzip(app);
    let url = resolve(&app, &view_url("views", "/lidar", "pointcloud", "")).await;
    let response = app
        .oneshot(
            Request::get(&url)
                .header("accept-encoding", "gzip")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get("content-encoding").is_none());
}
