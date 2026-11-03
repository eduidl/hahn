//! The frame graph of a run as delivered: `/frames`, `/transforms/static` and
//! `/transforms/dynamic`. Clients resolve it themselves.

use crate::common::*;

#[tokio::test]
async fn frames_are_merged_from_every_transform_topic() {
    let (_dir, app) = visual_app();
    let (status, body) = get(app, "/r/frames").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["frames"],
        json!([
            {"id": "base_link", "parent": "map", "kind": "dynamic", "parents": ["map"], "dropped_samples": 0},
            {"id": "lidar", "parent": "base_link", "kind": "static", "parents": ["base_link"], "dropped_samples": 0},
            {"id": "map", "parent": null, "parents": [], "dropped_samples": 0},
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
            {"id": "base", "parent": "map", "kind": "dynamic", "parents": ["map"], "dropped_samples": 0},
            // Its only sample has a number that is not finite.
            {"id": "broken", "parent": null, "parents": [], "dropped_samples": 1},
            {"id": "camera", "parent": "base", "kind": "static", "parents": ["base"], "dropped_samples": 0},
            {"id": "imu", "parent": "base", "kind": "static", "parents": ["base"], "dropped_samples": 0},
            {"id": "lidar", "parent": "base", "kind": "static", "parents": ["base"], "dropped_samples": 0},
            {"id": "map", "parent": null, "parents": [], "dropped_samples": 0},
        ])
    );
    // Every channel's static transforms, each child once.
    let (_, fixed) = get(app.clone(), "/r/transforms/static").await;
    let offsets: Vec<_> = fixed["transforms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["child"].clone(), t["translation"][0].clone()))
        .collect();
    assert_eq!(
        offsets,
        vec![
            (json!("camera"), json!(3.0)),
            (json!("imu"), json!(5.0)),
            (json!("lidar"), json!(4.0)),
        ]
    );
    let (_, dynamic) = get(app, "/r/transforms/dynamic?start_ns=0&end_ns=100").await;
    let samples = dynamic["samples"].as_array().unwrap();
    assert!(!samples.is_empty());
    assert!(
        samples
            .iter()
            .all(|s| s["child"] == "base" && s["parent"] == "map")
    );
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
    let (status, body) = get(app.clone(), "/r/transforms/static").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body["transforms"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["child"] == "lidar")
    );
    let (status, _) = get(app, "/api/runs/no-such-run/frames").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_run_without_transforms_has_no_frames() {
    let dir = fixture(1, true);
    let app = hahn::router(dir.path()).unwrap();
    let (status, body) = get(app.clone(), "/r/frames").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"frames": [], "unreadable_groups": []}));
    let (_, body) = get(app.clone(), "/r/transforms/static").await;
    assert_eq!(body, json!({"transforms": []}));
    let (_, body) = get(app, "/r/transforms/dynamic?start_ns=0&end_ns=10").await;
    assert_eq!(body, json!({"samples": []}));
}

/// Reads topics of `test/StampedLink`: a translation along x with a measurement
/// stamp, zero for none.
struct StampedLinks;

impl hahn::TransformReader for StampedLinks {
    fn accepts(&self, schema_name: &str, _: &hahn::FieldDefs) -> bool {
        schema_name == "test/StampedLink"
    }
    fn read(&self, message: &hahn::Message<'_>) -> anyhow::Result<Vec<hahn::TransformSample>> {
        Ok(vec![hahn::TransformSample {
            parent: message.string("parent")?.into(),
            child: message.string("child")?.into(),
            translation: [message.number("x")?, 0., 0.],
            rotation: [0., 0., 0., 1.],
            stamp_ns: Some(message.number("stamp")? as u64).filter(|&stamp| stamp > 0),
        }])
    }
}

#[tokio::test]
async fn samples_are_served_by_recording_time_with_their_stamps() {
    use crate::memory::Topic;
    use hahn::{DataTypeDef as D, Value as V};
    // (recording time, parent, child, x, stamp)
    let topic = |name, links: &[(u64, &str, &str, f64, u64)]| {
        let mut topic = Topic::new(
            name,
            "test/StampedLink",
            vec![
                ("parent", D::String),
                ("child", D::String),
                ("x", D::F64),
                ("stamp", D::U64),
            ],
        );
        for &(time, parent, child, x, stamp) in links {
            topic = topic.at(
                time,
                vec![
                    V::string(parent),
                    V::string(child),
                    V::F64(x),
                    V::U64(stamp),
                ],
            );
        }
        topic
    };
    let dynamic = topic(
        "tf",
        &[
            (10, "map", "base", 1., 5),
            (20, "map", "base", 2., 15),
            (25, "base", "arm", 1., 24),
            (30, "map", "base", 3., 0),
        ],
    );
    // `arm` is also on the dynamic topic, so it is dynamic and keeps this sample.
    let fixed = topic(
        "tf_static",
        &[(1, "base", "lidar", 0.5, 0), (5, "base", "arm", 0., 0)],
    );
    let (_dir, app) = crate::memory::app(vec![dynamic, fixed], |builder| {
        builder.transforms(StampedLinks)
    });

    let (status, body) = get(app.clone(), "/r/transforms/static").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({"transforms": [
            {"child": "lidar", "parent": "base", "translation": [0.5, 0., 0.], "rotation": [0., 0., 0., 1.]},
        ]})
    );

    let sample = |child, parent, x: f64, time: &str, stamp: Option<&str>| {
        let mut row = json!({
            "child": child, "parent": parent,
            "translation": [x, 0., 0.], "rotation": [0., 0., 0., 1.],
            "time_ns": time,
        });
        if let Some(stamp) = stamp {
            row["stamp_ns"] = json!(stamp);
        }
        row
    };
    // Recording order, the end excluded; samples without a stamp have none.
    let (status, body) = get(app.clone(), "/r/transforms/dynamic?start_ns=5&end_ns=30").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["samples"],
        json!([
            sample("arm", "base", 0., "5", None),
            sample("base", "map", 1., "10", Some("5")),
            sample("base", "map", 2., "20", Some("15")),
            sample("arm", "base", 1., "25", Some("24")),
        ])
    );
    let (_, body) = get(app.clone(), "/r/transforms/dynamic?start_ns=30&end_ns=31").await;
    assert_eq!(
        body["samples"],
        json!([sample("base", "map", 3., "30", None)])
    );

    for query in ["start_ns=2&end_ns=1", "start_ns=1", "end_ns=1"] {
        let (status, body) = get(app.clone(), &format!("/r/transforms/dynamic?{query}")).await;
        assert_eq!(
            (status, body["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("invalid_request")),
            "{query}"
        );
    }

    let (_, frames) = get(app, "/r/frames").await;
    let kinds: Vec<_> = frames["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|frame| (frame["id"].clone(), frame["kind"].clone()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (json!("arm"), json!("dynamic")),
            (json!("base"), json!("dynamic")),
            (json!("lidar"), json!("static")),
            (json!("map"), Value::Null),
        ]
    );
}

#[tokio::test]
async fn frames_name_the_groups_they_could_not_read() {
    let root = tempfile::tempdir().unwrap();
    let run = root.path().join("drive");
    std::fs::create_dir(&run).unwrap();
    support::write_visual_fixture(&run.join("good.mcap")).unwrap();
    std::fs::write(run.join("bad.mcap"), b"not MCAP").unwrap();
    let app = hahn::router(root.path()).unwrap();
    let (_, runs) = get(app.clone(), "/api/runs").await;
    let run = runs["items"][0]["id"].as_str().unwrap();
    let (_, detail) = get(app.clone(), &format!("/api/runs/{run}")).await;
    let bad = detail["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["name"] == "bad.mcap")
        .unwrap()["id"]
        .clone();
    let (status, frames) = get(app, "/r/frames").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(frames["unreadable_groups"], json!([bad]));
    // The readable group's frames are still there.
    assert!(
        frames["frames"]
            .as_array()
            .unwrap()
            .iter()
            .any(|frame| frame["id"] == "lidar")
    );
}
