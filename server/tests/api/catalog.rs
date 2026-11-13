//! How the data directory becomes runs and groups, and requests about them.

use crate::common::*;

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
    // Discovery goes by file name and does not open the files.
    let file = |path: &str| std::fs::write(root.join(path), "").unwrap();
    file("single.mcap");
    file("ignored.txt");
    std::fs::create_dir_all(root.join("empty")).unwrap();
    // A plain run: numbered files stay separate without a bag's metadata.
    std::fs::create_dir_all(root.join("drive/nested")).unwrap();
    file("drive/cam_0.mcap");
    file("drive/cam_1.mcap");
    file("drive/nested/imu.mcap");
    // A bag inside a run is one group.
    std::fs::create_dir_all(root.join("drive/bag")).unwrap();
    std::fs::write(root.join("drive/bag/metadata.yaml"), "").unwrap();
    file("drive/bag/bag_0.mcap");
    file("drive/bag/bag_1.mcap");
    // A bag at the top level is a run with one group.
    std::fs::create_dir_all(root.join("alone")).unwrap();
    std::fs::write(root.join("alone/metadata.yaml"), "").unwrap();
    file("alone/alone_0.mcap");
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
                    group("cam_0.mcap"),
                    group("cam_1.mcap"),
                    group("nested/imu.mcap"),
                ],
            ),
            ("single.mcap".to_owned(), vec![group("single.mcap")]),
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
async fn a_recording_file_is_the_only_run() {
    let dir = fixture(10, true);
    let path = dir.path().join("test.mcap");
    std::fs::write(dir.path().join("other.mcap"), "").unwrap();
    let app = hahn::router(&path).unwrap();
    assert_eq!(
        run_names(&app).await,
        vec![("test.mcap".to_owned(), vec!["test.mcap".to_owned()])]
    );
    // It reads like the same file as a run of its directory, under the same id.
    let in_dir = hahn::router(dir.path()).unwrap();
    let (_, alone) = raw_get(&app, "/api/runs").await;
    let (_, listed) = raw_get(&in_dir, "/api/runs?q=test").await;
    assert_eq!(alone["items"], listed["items"]);
    let base = resolve(&app, "/g").await;
    let (status, info) = raw_get(&app, &base).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info, raw_get(&in_dir, &base).await.1);
    // A file no format reads is not served.
    std::fs::write(dir.path().join("notes.txt"), "").unwrap();
    assert!(hahn::router(&dir.path().join("notes.txt")).is_err());
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
    write_rows(&bag.join("bag_0.mcap"), "/bag_0", &[(1, 1, "")]);
    write_rows(&bag.join("bag_1.mcap"), "/bag_1", &[(2, 2, "")]);
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let topic = topics
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["topic"] == "/bag_1")
        .unwrap();
    let (_, events) = series(
        app.clone(),
        json!({"topic":topic["id"],"fields":[["count"]]}),
    )
    .await;
    assert_eq!(events[0]["rows"][0]["time_ns"], "2");
    assert_eq!(events.last().unwrap()["type"], "complete");
    let (status, _) = series(app, json!({"topic":"/nope","fields":[["count"]]})).await;
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
    for name in ["Morning.mcap", "morning_2.mcap", "night.mcap"] {
        std::fs::write(dir.path().join(name), "").unwrap();
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
    assert_eq!(names(&found), ["Morning.mcap", "morning_2.mcap"]);
    let (_, limited) = raw_get(&app, "/api/runs?q=morn&limit=1").await;
    assert_eq!(names(&limited), ["Morning.mcap"]);
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
        let app = hahn::router(dir.path()).unwrap();
        let (status, body) = get(app.clone(), "/g").await;
        assert_eq!(status, StatusCode::OK, "stats: {stats}: {body}");
        assert_eq!(body, json!({"message_count": 0}), "stats: {stats}");
        // Its topics are still listed, and reading one finds nothing rather than failing.
        let (status, topics) = get(app.clone(), "/g/topics").await;
        assert_eq!(status, StatusCode::OK);
        let topic = topics[0]["id"].as_str().unwrap();
        let (status, latest) = get(
            app.clone(),
            &format!("/g/messages/latest?topic={}&time_ns=1", encode(topic)),
        )
        .await;
        assert_eq!((status, latest), (StatusCode::OK, Value::Null));
        let (status, events) = stream(app, "/g/messages", json!({"topic": topic})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            events,
            vec![json!({"type":"complete","scanned_messages":0})]
        );
    }
}
