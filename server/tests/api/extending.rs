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
    // The samples without a child or with a number that is not finite are left out.
    assert_eq!(
        body["frames"],
        json!([
            {"id": "base", "parent": "map"},
            {"id": "map", "parent": null},
            {"id": "sensor", "parent": "base"},
        ])
    );
    let quarter = support::ros2::ACME_COUNT / 4 * support::ros2::ACME_STEP_NS;
    let (status, body) = get(
        app.clone(),
        &format!("/r/transforms?target=map&time_ns={quarter}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // `base` faces -x at the top of the circle, so `sensor` is 1 m further in -x.
    let sensor = &body["frames"]["sensor"]["translation"];
    assert!((sensor[0].as_f64().unwrap() + 1.).abs() < 1e-9, "{sensor}");
    assert!((sensor[1].as_f64().unwrap() - 5.).abs() < 1e-9, "{sensor}");

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

