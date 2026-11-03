//! Topics, fields and messages: `/topics`, `/messages` and `/messages/latest`.

use crate::common::*;

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

fn rows_fixture(topic: &str, rows: &[(u64, i64, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write_rows(&dir.path().join("rows.mcap"), topic, rows);
    dir
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
    let dir = rows_fixture(
        "/window",
        &[
            (1_000_000_000, 1, ""),
            (2_000_000_000, 2, ""),
            (2_000_000_000, 3, ""),
            (3_000_000_000, 4, ""),
        ],
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
async fn json_channels_without_a_schema_show_parsed_messages() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer =
        mcap::Writer::new(std::fs::File::create(dir.path().join("json.mcap")).unwrap()).unwrap();
    let schema = writer.add_schema("Status", "jsonschema", b"").unwrap();
    let channel = writer
        .add_channel(schema, "/status", "json", &Default::default())
        .unwrap();
    let text = r#"{"speed": 1.5}"#;
    writer
        .write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id: channel,
                sequence: 0,
                log_time: 1,
                publish_time: 1,
            },
            text.as_bytes(),
        )
        .unwrap();
    writer.finish().unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (status, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(status, StatusCode::OK);
    assert!(topics[0]["error"].is_null());
    assert_eq!(topics[0]["schema_encoding"], "jsonschema");
    assert_eq!(topics[0]["fields"][0]["name"], "json");
    assert_eq!(topics[0]["fields"][0]["data_type"], "json");
    assert_eq!(topics[0]["fields"][0]["type_name"], "json");
    let rows = |events: Vec<serde_json::Value>| -> Vec<serde_json::Value> {
        events
            .iter()
            .filter_map(|event| event["rows"].as_array())
            .flatten()
            .cloned()
            .collect()
    };
    let (status, events) = stream(app.clone(), "/g/messages", json!({"topic":"/status"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows(events)[0]["value"], json!({"json": {"speed": 1.5}}));
    // Exact values keep the message's own text.
    let (status, events) = stream(
        app,
        "/g/messages",
        json!({"topic":"/status","path":"[\"json\"]","preview":"false"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows(events)[0]["value"], text);
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
async fn exact_values_do_not_shorten_strings_and_require_a_scalar() {
    let long = "x".repeat(10_050);
    let dir = rows_fixture("/drive", &[(1, 0, &long)]);
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
    let shortened = shortened[0]["rows"][0]["value"].as_str().unwrap();
    assert_eq!(shortened.chars().count(), 10_001);
    assert!(shortened.ends_with('…'));
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
}

