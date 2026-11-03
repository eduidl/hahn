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

