//! Views of the built-in Foxglove types: `/views` and `/views/latest`.

use crate::common::*;

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

#[tokio::test]
async fn camera_calibration_view_validates_and_converts() {
    let dir = tempfile::tempdir().unwrap();
    support::write_camera_calibration(&dir.path().join("camera.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, events) = frames(
        &app,
        &view_url("views", "/calibration", "camera_calibration", ""),
    )
    .await;
    assert_eq!(events[0].0["value"]["frame_id"], "camera");
    assert_eq!(
        events[0].0["value"]["intrinsics"],
        json!([400., 0., 320., 0., 400., 240., 0., 0., 1.])
    );
    assert_eq!(events[0].0["value"]["distortion"], json!([0.1]));
    assert_eq!(events[0].0["value"]["distortion_model"], "plumb_bob");
    assert!(
        events[1].0["error"]
            .as_str()
            .unwrap()
            .contains("camera matrix")
    );
}

#[tokio::test]
async fn raw_image_view_preserves_pixels_and_rejects_invalid_messages() {
    let dir = tempfile::tempdir().unwrap();
    support::write_raw_images(&dir.path().join("raw.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(topics[0]["views"][0]["kind"], "image");
    let (_, events) = frames(&app, &view_url("views", "/raw", "raw_image", "")).await;
    let value = &events[0].0["value"];
    assert_eq!(value["frame_id"], "camera");
    assert_eq!(value["format"], "raw");
    assert_eq!(value["encoding"], "rgb8");
    assert_eq!(value["width"], 2);
    assert_eq!(value["step"], 8);
    assert_eq!(&events[0].1[..8], &[255, 0, 0, 0, 255, 0, 9, 9]);
    assert!(events[1].0["error"].as_str().unwrap().contains("step"));
    assert!(events[2].0["error"].as_str().unwrap().contains("encoding"));
    assert!(events[3].0["error"].as_str().unwrap().contains("even"));
}

#[tokio::test]
async fn odometry_provides_a_validated_pose_view() {
    let dir = tempfile::tempdir().unwrap();
    support::write_odometry(&dir.path().join("odom.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    let (_, topics) = get(app.clone(), "/g/topics").await;
    assert_eq!(topics[0]["views"][0]["kind"], "pose");
    let (_, events) = frames(&app, &view_url("views", "/odometry", "pose", "")).await;
    assert_eq!(
        events[0].0["value"],
        json!({"kind":"pose", "frame_id":"map", "pose":{"position":[2.,3.,4.], "orientation":[0.,0.,0.,1.]}})
    );
    assert!(events[1].0["error"].as_str().unwrap().contains("no pose"));
    assert!(
        events[2].0["error"]
            .as_str()
            .unwrap()
            .contains("Non-finite")
    );
}

impl hahn::ViewConverter for Echo {
    fn id(&self) -> &'static str {
        "echo"
    }
    fn kind(&self) -> hahn::Kind {
        self.0
    }
    fn name(&self) -> &'static str {
        "Echo"
    }
    fn accepts(&self, schema_name: &str, _: &hahn::FieldDefs) -> bool {
        schema_name == "test/Echo"
    }
    fn convert(&self, message: &hahn::Message<'_>) -> anyhow::Result<hahn::View> {
        Ok((self.1)(message.number("case")? as u32))
    }
}

#[tokio::test]
async fn points_without_a_position_are_left_out_with_their_values() {
    let events = echoed(hahn::Kind::PointCloud, 2, |case| {
        let intensity = hahn::PointField {
            name: "intensity".into(),
            numeric_type: hahn::NumericType::U8,
            // The second case has one value too many.
            data: vec![10, 20, 30, 40][..3 + case as usize].to_vec(),
        };
        hahn::PointCloudView {
            positions: vec![[1., 2., 3.], [f32::NAN, 0., 0.], [4., 5., 6.]],
            fields: vec![intensity],
            ..Default::default()
        }
        .into()
    })
    .await;
    let (header, payload) = &events[0];
    let value = &header["value"];
    assert_eq!(value["count"], 2);
    let blob = &value["fields"][0]["data"]["$blob"];
    let offset = blob["offset"].as_u64().unwrap() as usize;
    assert_eq!(blob["length"], 2);
    assert_eq!(&payload[offset..offset + 2], [10, 30]);
    let error = events[1].0["error"].as_str().unwrap();
    assert!(error.contains("one value per point"), "{error}");
}

#[tokio::test]
async fn a_point_feature_must_be_on_the_earth() {
    let events = echoed(hahn::Kind::Geo, 2, |case| {
        hahn::GeoView {
            frame_id: None,
            features: vec![hahn::GeoFeature::point(
                [10., 91.][case as usize],
                0.,
                Some(f64::NAN),
            )],
        }
        .into()
    })
    .await;
    // An altitude that is not finite is left out.
    assert_eq!(
        events[0].0["value"]["features"][0]["geometry"]["coordinates"],
        json!([0., 10.])
    );
    assert!(
        events[1].0["error"]
            .as_str()
            .unwrap()
            .contains("Invalid location")
    );
}

