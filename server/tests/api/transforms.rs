//! The frame graph of a run: `/frames`, `/transforms` and poses in a target frame.

use crate::common::*;

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
async fn pose_history_resolves_transforms_at_each_recorded_time() {
    let dir = tempfile::tempdir().unwrap();
    support::write_odometry(&dir.path().join("odom.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, events) = frames(
        &app,
        &view_url("views", "/odometry", "pose", "&target_frame=fixed"),
    )
    .await;
    assert_eq!(events[0].0["value"]["frame_id"], "fixed");
    assert_eq!(
        events[0].0["value"]["pose"]["position"],
        json!([12., 3., 4.])
    );
    assert!(events[1].0["error"].is_string());
    assert_eq!(
        events[3].0["value"]["pose"]["position"],
        json!([26., 0., 0.])
    );
    let (_, missing) = frames(
        &app,
        &view_url("views", "/odometry", "pose", "&target_frame=unknown"),
    )
    .await;
    assert!(
        missing[0].0["error"]
            .as_str()
            .unwrap()
            .contains("No transform")
    );
}

/// Reads topic `tf` and `tf_static` of the in-memory recording: one transform per
/// message, rotated about z.
struct Links;

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

/// `child` in `parent`: moved by `x` and rotated by `[0, 0, qz, qw]`.
type Link = (u64, &'static str, &'static str, f64, [f64; 2]);

/// A quarter turn about z.
const TURN: [f64; 2] = [
    std::f64::consts::FRAC_1_SQRT_2,
    std::f64::consts::FRAC_1_SQRT_2,
];
const STILL: [f64; 2] = [0., 1.];

fn links_app(dynamic: &[Link], fixed: &[Link]) -> (tempfile::TempDir, axum::Router) {
    use crate::memory::Topic;
    use hahn::{DataTypeDef as D, Value as V};
    let topic = |name, links: &[Link]| {
        let mut topic = Topic::new(
            name,
            "test/Link",
            vec![
                ("parent", D::String),
                ("child", D::String),
                ("x", D::F64),
                ("qz", D::F64),
                ("qw", D::F64),
            ],
        );
        for &(time, parent, child, x, [qz, qw]) in links {
            topic = topic.at(
                time,
                vec![
                    V::string(parent),
                    V::string(child),
                    V::F64(x),
                    V::F64(qz),
                    V::F64(qw),
                ],
            );
        }
        topic
    };
    crate::memory::app(
        vec![topic("tf", dynamic), topic("tf_static", fixed)],
        |builder| builder.transforms(Links),
    )
}

/// Every frame's transform into `target` at `time`.
async fn resolved(app: &axum::Router, target: &str, time: u64) -> Value {
    let (status, body) = get(
        app.clone(),
        &format!("/r/transforms?target={target}&time_ns={time}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["frames"].clone()
}

fn close(value: &Value, expected: &[f64]) {
    let actual: Vec<f64> = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(actual.len(), expected.len(), "{value}");
    for (a, b) in actual.iter().zip(expected) {
        assert!((a - b).abs() < 1e-9, "{value} != {expected:?}");
    }
}

#[tokio::test]
async fn a_transform_rotates_before_it_translates() {
    // `base` is 1 m along x of `map`, turned a quarter; `lidar` is 1 m ahead of it.
    let (_dir, app) = links_app(
        &[],
        &[
            (1, "map", "base", 1., TURN),
            (1, "base", "lidar", 1., STILL),
        ],
    );
    let frames = resolved(&app, "map", 1).await;
    close(&frames["lidar"]["translation"], &[1., 1., 0.]);
    // The other way round, the inverse.
    let frames = resolved(&app, "lidar", 1).await;
    close(&frames["map"]["translation"], &[-1., 1., 0.]);
}

#[tokio::test]
async fn dynamic_transforms_are_interpolated_but_never_extrapolated() {
    let (_dir, app) = links_app(
        &[
            (100, "map", "base", 0., STILL),
            (200, "map", "base", 10., STILL),
        ],
        &[],
    );
    assert!(resolved(&app, "map", 99).await.get("base").is_none());
    close(
        &resolved(&app, "map", 100).await["base"]["translation"],
        &[0., 0., 0.],
    );
    close(
        &resolved(&app, "map", 150).await["base"]["translation"],
        &[5., 0., 0.],
    );
    close(
        &resolved(&app, "map", 200).await["base"]["translation"],
        &[10., 0., 0.],
    );
    assert!(resolved(&app, "map", 201).await.get("base").is_none());
}

#[tokio::test]
async fn rotations_are_interpolated_the_short_way_round() {
    // The same quarter turn written as -q.
    let (_dir, app) = links_app(
        &[
            (100, "map", "base", 0., STILL),
            (200, "map", "base", 0., TURN.map(|v| -v)),
        ],
        &[],
    );
    let eighth = std::f64::consts::FRAC_PI_8;
    let rotation = &resolved(&app, "map", 150).await["base"]["rotation"];
    close(rotation, &[0., 0., eighth.sin(), eighth.cos()]);
}

#[tokio::test]
async fn static_and_dynamic_transforms_chain_in_both_directions() {
    let (_dir, app) = links_app(
        &[
            (100, "map", "base", 1., STILL),
            (200, "map", "base", 1., STILL),
        ],
        &[(1, "base", "lidar", 2., STILL)],
    );
    close(
        &resolved(&app, "map", 150).await["lidar"]["translation"],
        &[3., 0., 0.],
    );
    close(
        &resolved(&app, "lidar", 150).await["map"]["translation"],
        &[-3., 0., 0.],
    );
    // Past the dynamic samples only the static transform remains.
    let later = resolved(&app, "lidar", 300).await;
    assert!(later.get("base").is_some());
    assert!(later.get("map").is_none());
}

#[tokio::test]
async fn frames_not_connected_to_the_target_are_left_out() {
    let (_dir, app) = links_app(
        &[],
        &[
            (1, "map", "base", 1., STILL),
            (1, "other", "tag", 1., STILL),
        ],
    );
    let frames = resolved(&app, "map", 1).await;
    assert!(frames.get("base").is_some());
    assert!(frames.get("tag").is_none());
}

#[tokio::test]
async fn a_frame_changing_parent_is_not_interpolated_across() {
    let (_dir, app) = links_app(
        &[(100, "a", "base", 1., STILL), (200, "b", "base", 9., STILL)],
        &[],
    );
    close(
        &resolved(&app, "a", 150).await["base"]["translation"],
        &[1., 0., 0.],
    );
    assert!(resolved(&app, "b", 150).await.get("base").is_none());
    close(
        &resolved(&app, "b", 200).await["base"]["translation"],
        &[9., 0., 0.],
    );
}
