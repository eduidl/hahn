//! Converters, transform readers and file formats added by an application.

use crate::common::*;

struct CustomImage;

impl hahn::ViewConverter for CustomImage {
    fn id(&self) -> &'static str {
        "custom-image"
    }
    fn kind(&self) -> hahn::Kind {
        hahn::Kind::Image
    }
    fn name(&self) -> &'static str {
        "Custom image"
    }
    fn accepts(&self, schema_name: &str, defs: &hahn::FieldDefs) -> bool {
        schema_name == "foxglove.CompressedImage" && defs.iter().any(|field| field.name == "data")
    }
    fn convert(&self, message: &hahn::Message<'_>) -> anyhow::Result<hahn::View> {
        Ok(hahn::ImageView {
            frame_id: None,
            format: "PNG".into(),
            data: message.bytes("data")?,
        }
        .into())
    }
}

#[tokio::test]
async fn external_image_converter_is_declared_and_served() {
    let dir = tempfile::tempdir().unwrap();
    support::write_visual_fixture(&dir.path().join("visual.mcap")).unwrap();
    let app = hahn::Builder::new(dir.path())
        .view(CustomImage)
        .router()
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
        hahn::Builder::new(dir.path())
            .view(CustomImage)
            .view(CustomImage)
            .router()
            .is_err()
    );
}

/// A pose on a plane, `acme_msgs/msg/Pose2D`, as an application would add it.
struct AcmePose2d;

impl hahn::ViewConverter for AcmePose2d {
    fn id(&self) -> &'static str {
        "acme_pose2d"
    }
    fn kind(&self) -> hahn::Kind {
        hahn::Kind::Pose
    }
    fn name(&self) -> &'static str {
        "Pose"
    }
    fn accepts(&self, schema_name: &str, defs: &hahn::FieldDefs) -> bool {
        use hahn::schema::{has, is_number, is_string};
        schema_name == "acme_msgs/msg/Pose2D"
            && has(defs, "frame_id", is_string)
            && has(defs, "x", is_number)
            && has(defs, "y", is_number)
            && has(defs, "theta", is_number)
    }
    fn convert(&self, message: &hahn::Message<'_>) -> anyhow::Result<hahn::View> {
        let half = message.number("theta")? / 2.;
        Ok(hahn::PoseView {
            frame_id: message.frame_id()?,
            pose: hahn::Pose {
                position: [message.number("x")?, message.number("y")?, 0.],
                orientation: [0., 0., half.sin(), half.cos()],
            },
        }
        .into())
    }
}

/// Declares a pose but returns a location.
struct WrongKind;

impl hahn::ViewConverter for WrongKind {
    fn id(&self) -> &'static str {
        "wrong_kind"
    }
    fn kind(&self) -> hahn::Kind {
        hahn::Kind::Pose
    }
    fn name(&self) -> &'static str {
        "Wrong"
    }
    fn accepts(&self, schema_name: &str, _: &hahn::FieldDefs) -> bool {
        schema_name == "acme_msgs/msg/Pose2D"
    }
    fn convert(&self, _: &hahn::Message<'_>) -> anyhow::Result<hahn::View> {
        Ok(hahn::GeoView {
            frame_id: None,
            features: vec![hahn::GeoFeature::point(35., 139., None)],
        }
        .into())
    }
}

/// `acme_msgs/msg/Link2D`: one transform on a plane, as an application would add it.
struct AcmeLink2d;

impl hahn::TransformReader for AcmeLink2d {
    fn accepts(&self, schema_name: &str, _: &hahn::FieldDefs) -> bool {
        schema_name == "acme_msgs/msg/Link2D"
    }
    fn read(&self, message: &hahn::Message<'_>) -> anyhow::Result<Vec<hahn::TransformSample>> {
        let half = message.number("theta")? / 2.;
        Ok(vec![hahn::TransformSample {
            parent: message.string("parent")?.into(),
            child: message.string("child")?.into(),
            translation: [message.number("x")?, message.number("y")?, 0.],
            rotation: [0., 0., half.sin(), half.cos()],
            stamp_ns: None,
        }])
    }
}

fn acme_app() -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    support::ros2::write_acme_fixture(&dir.path().join("acme.mcap"), true).unwrap();
    let app = hahn::Builder::new(dir.path())
        .view(AcmePose2d)
        .view(WrongKind)
        .transforms(AcmeLink2d)
        .router()
        .unwrap();
    (dir, app)
}

#[tokio::test]
async fn an_applications_own_type_is_read_as_transforms() {
    let (dir, app) = acme_app();
    let (status, body) = get(app.clone(), "/r/frames").await;
    assert_eq!(status, StatusCode::OK);
    // The samples without a child or with a number that is not finite are left out,
    // and counted for their child when it has a name.
    assert_eq!(
        body["frames"],
        json!([
            {"id": "base", "parent": "map", "kind": "dynamic", "parents": ["map"], "dropped_samples": 0},
            {"id": "broken", "parent": null, "parents": [], "dropped_samples": 1},
            {"id": "map", "parent": null, "parents": [], "dropped_samples": 0},
            {"id": "sensor", "parent": "base", "kind": "static", "parents": ["base"], "dropped_samples": 0},
        ])
    );
    // The reader's samples: `sensor` fixed on `base`, `base` driving round `map`.
    let (_, body) = get(app.clone(), "/r/transforms/static").await;
    assert_eq!(body["transforms"][0]["child"], "sensor");
    assert_eq!(body["transforms"][0]["parent"], "base");
    let quarter = support::ros2::ACME_COUNT / 4 * support::ros2::ACME_STEP_NS;
    let (_, body) = get(
        app.clone(),
        &format!(
            "/r/transforms/dynamic?start_ns={quarter}&end_ns={}",
            quarter + 1
        ),
    )
    .await;
    // At the top of the circle of radius 5.
    let base = &body["samples"][0]["translation"];
    assert!(base[0].as_f64().unwrap().abs() < 1e-9, "{base}");
    assert!((base[1].as_f64().unwrap() - 5.).abs() < 1e-9, "{base}");

    // Without the reader, the type is not a transform.
    let plain = hahn::Builder::new(dir.path()).router().unwrap();
    let (_, body) = get(plain, "/r/frames").await;
    assert_eq!(body["frames"], json!([]));
}

#[tokio::test]
async fn an_applications_own_type_is_served_as_a_pose() {
    let (_dir, app) = acme_app();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    let views = &topics[0]["views"];
    assert_eq!(
        views[0],
        json!({"id": "acme_pose2d", "kind": "pose", "name": "Pose"})
    );
    let quarter = support::ros2::ACME_COUNT / 4 * support::ros2::ACME_STEP_NS;
    let (status, events) = frames(
        &app,
        &view_url(
            "views/latest",
            "/acme_pose",
            "acme_pose2d",
            &format!("&time_ns={quarter}"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let value = &events[0].0["value"];
    assert_eq!(value["kind"], "pose");
    assert_eq!(value["frame_id"], "map");
    let position = &value["pose"]["position"];
    assert!(position[0].as_f64().unwrap().abs() < 1e-9);
    assert!((position[1].as_f64().unwrap() - 5.).abs() < 1e-9);
    // Rotated by 180 degrees about z.
    assert!((value["pose"]["orientation"][2].as_f64().unwrap() - 1.).abs() < 1e-9);

    let (_, history) = frames(&app, &view_url("views", "/acme_pose", "acme_pose2d", "")).await;
    let poses: Vec<_> = history
        .iter()
        .filter(|(header, _)| header["type"] == "frame")
        .collect();
    assert_eq!(poses.len() as u64, support::ros2::ACME_COUNT);
    assert_eq!(poses[9].0["value"]["frame_id"], Value::Null);
}

#[tokio::test]
async fn a_value_of_another_kind_than_declared_fails_its_frame() {
    let (_dir, app) = acme_app();
    let (status, events) = frames(
        &app,
        &view_url("views/latest", "/acme_pose", "wrong_kind", "&time_ns=0"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let error = events[0].0["error"].as_str().unwrap();
    assert!(error.contains("returned geo instead of pose"), "{error}");
    assert_eq!(events.last().unwrap().0["type"], "complete");
}

#[tokio::test]
async fn an_applications_own_file_format_is_served() {
    let dir = tempfile::tempdir().unwrap();
    support::acme_log::write_acme_log(&dir.path().join("acme.acmelog")).unwrap();
    std::fs::write(dir.path().join("broken.acmelog"), "1 /speed fast\n").unwrap();
    // Without the format, its files are not recordings.
    let plain = hahn::router(dir.path()).unwrap();
    let (_, runs) = raw_get(&plain, "/api/runs").await;
    assert_eq!(runs["items"], json!([]));

    let app = hahn::Builder::new(dir.path())
        .format(support::acme_log::AcmeLog)
        .router()
        .unwrap();
    let (_, runs) = raw_get(&app, "/api/runs").await;
    let names: Vec<_> = runs["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["name"].clone())
        .collect();
    assert_eq!(names, vec![json!("acme.acmelog"), json!("broken.acmelog")]);

    let (status, info) = get(app.clone(), "/g").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["start_ns"], "0");
    assert_eq!(info["end_ns"], "3900000000");
    assert_eq!(info["message_count"], 50);

    let (_, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(topics[0]["topic"], "/speed");
    assert_eq!(topics[0]["schema_name"], "acme_log/Scalar");
    assert_eq!(topics[0]["fields"][0]["name"], "value");
    assert_eq!(topics[1]["topic"], "/battery");
    assert_eq!(topics[1]["message_count"], 10);

    let (status, events) = stream(
        app.clone(),
        "/g/messages",
        json!({"topic":"/speed","path":["value"],"preview":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows: Vec<_> = events
        .iter()
        .filter_map(|e| e["rows"].as_array())
        .flatten()
        .collect();
    assert_eq!(rows.len(), 40);
    assert_eq!(rows[3]["time_ns"], "300000000");
    assert_eq!(rows[3]["value"], 3.);
    assert_eq!(events.last().unwrap()["type"], "complete");

    // A file that cannot be read fails for its own run only.
    let broken = runs["items"][1]["id"].as_str().unwrap();
    let (_, detail) = raw_get(&app, &format!("/api/runs/{broken}")).await;
    let group = detail["groups"][0]["id"].as_str().unwrap();
    let (status, body) = raw_get(&app, &format!("/api/runs/{broken}/groups/{group}")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["error"].as_str().unwrap().contains("invalid"),
        "{body}"
    );
}

#[test]
fn packed_points_are_unpacked_by_offset() {
    use hahn::{NumericType, PackedField, PointCloudView};
    let fields = [
        ("x", 0, NumericType::F32),
        ("y", 4, NumericType::F32),
        ("intensity", 8, NumericType::U8),
    ]
    .map(|(name, offset, numeric_type)| PackedField {
        name: name.into(),
        offset,
        numeric_type,
    });
    let mut point = Vec::new();
    point.extend_from_slice(&1f32.to_le_bytes());
    point.extend_from_slice(&2f32.to_le_bytes());
    point.push(7);
    let cloud = PointCloudView::from_packed(None, &fields, [point.as_slice()]).unwrap();
    // A missing axis is zero.
    assert_eq!(cloud.positions, vec![[1., 2., 0.]]);
    assert_eq!(cloud.fields[0].data, vec![7]);
    // A point too short for its fields is refused rather than read past.
    assert!(PointCloudView::from_packed(None, &fields, [&point[..4]]).is_err());
}

#[test]
fn messages_read_rotations_as_unit_quaternions() {
    use crate::memory::{defs, structure};
    use hahn::{DataTypeDef as D, Message, Value as V};
    let quaternion = || {
        structure(vec![
            ("x", D::F64),
            ("y", D::F64),
            ("z", D::F64),
            ("w", D::F64),
        ])
    };
    let defs = defs(vec![
        ("zero", quaternion()),
        ("double", quaternion()),
        ("unset", quaternion()),
    ]);
    let at = |w| V::Struct(vec![V::F64(0.), V::F64(0.), V::F64(0.), V::F64(w)]);
    let value = V::Struct(vec![at(0.), at(2.), V::Null]);
    let message = Message::new(&defs, &value).unwrap();
    for name in ["zero", "double", "unset"] {
        assert_eq!(
            message.quaternion(name).unwrap(),
            [0., 0., 0., 1.],
            "{name}"
        );
    }
}

struct BatchProbe;
impl hahn::ViewConverter for BatchProbe {
    fn id(&self) -> &'static str {
        "batch-probe"
    }
    fn kind(&self) -> hahn::Kind {
        hahn::Kind::Position
    }
    fn name(&self) -> &'static str {
        "Batch probe"
    }
    fn accepts(&self, name: &str, _: &hahn::FieldDefs) -> bool {
        name == "example/msg/Probe"
    }
    fn convert(&self, message: &hahn::Message<'_>) -> anyhow::Result<hahn::View> {
        Ok(hahn::PositionView {
            frame_id: None,
            position: [message.number("value")?, 0., 0.],
        }
        .into())
    }
}

#[tokio::test]
async fn batch_decode_failure_preserves_other_stream_and_does_not_repeat_frames() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer =
        mcap::Writer::new(std::fs::File::create(dir.path().join("batch.mcap")).unwrap()).unwrap();
    let schema = writer
        .add_schema("example/msg/Probe", "ros2msg", b"int32 value\n")
        .unwrap();
    let good = writer
        .add_channel(schema, "/good", "cdr", &Default::default())
        .unwrap();
    let bad = writer
        .add_channel(schema, "/bad", "cdr", &Default::default())
        .unwrap();
    for (channel, time, payload) in [
        (good, 1, vec![0, 1, 0, 0, 1, 0, 0, 0]),
        (bad, 2, vec![0, 1, 0, 0]),
        (good, 3, vec![0, 1, 0, 0, 3, 0, 0, 0]),
    ] {
        writer
            .write_to_known_channel(
                &mcap::records::MessageHeader {
                    channel_id: channel,
                    sequence: 0,
                    log_time: time,
                    publish_time: time,
                },
                &payload,
            )
            .unwrap();
    }
    writer.finish().unwrap();
    let app = hahn::Builder::new(dir.path())
        .view(BatchProbe)
        .router()
        .unwrap();
    let streams = batch_frames(&app, json!({"views":[{"topic":"/good","view":"batch-probe"},{"topic":"/bad","view":"batch-probe"}]})).await;
    assert_eq!(
        streams[0]
            .iter()
            .filter(|event| event["type"] == "frame")
            .map(|event| event["time_ns"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["1", "3"]
    );
    assert_eq!(streams[0].last().unwrap()["type"], "complete");
    assert_eq!(streams[1].last().unwrap()["type"], "error");
}
