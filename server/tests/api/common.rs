pub(crate) fn fixture(count: usize, stats: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    support::write_fixture(&dir.path().join("test.mcap"), count, stats).unwrap();
    dir
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
