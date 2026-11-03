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

impl hahn::TransformReader for Links {
    fn accepts(&self, schema_name: &str, _: &hahn::FieldDefs) -> bool {
        schema_name == "test/Link"
    }
    fn read(&self, message: &hahn::Message<'_>) -> anyhow::Result<Vec<hahn::TransformSample>> {
        Ok(vec![hahn::TransformSample {
            parent: message.string("parent")?.into(),
            child: message.string("child")?.into(),
            translation: [message.number("x")?, 0., 0.],
            rotation: [0., 0., message.number("qz")?, message.number("qw")?],
        }])
    }
}

