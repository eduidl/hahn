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
    assert_eq!(views("/gps")[0]["kind"], "geo_location");
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
async fn locations_are_in_longitude_order() {
    let (_dir, app) = visual_app();
    let query = format!("&time_ns={}", support::ORIGIN);
    let (_, events) = frames(&app, &view_url("views/latest", "/gps", "geo", &query)).await;
    let value = &events[0].0["value"];
    assert_eq!(value["kind"], "geo_location");
    assert_eq!(value["position"], json!([139.76, 35.68]));
    assert_eq!(value["altitude"], 40.0);
    assert_eq!(value["accuracy_m"], 3.0);
    assert!(events[0].1.is_empty());
}

#[tokio::test]
async fn a_location_must_be_on_the_earth_and_its_optional_numbers_finite() {
    let events = echoed(hahn::Kind::GeoLocation, 2, |case| {
        hahn::GeoLocationView {
            latitude: [10., 91.][case as usize],
            longitude: 0.,
            altitude: Some(f64::NAN),
            heading: Some(1.5),
            accuracy_m: None,
        }
        .into()
    })
    .await;
    assert_eq!(
        events[0].0["value"],
        json!({"kind": "geo_location", "position": [0., 10.], "heading": 1.5})
    );
    assert!(
        events[1].0["error"]
            .as_str()
            .unwrap()
            .contains("Invalid location")
    );
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
        &view_url("views", "/camera/calibration", "camera_calibration", ""),
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

/// Converts topic `echo`, whose messages hold a case number, to whatever `make`
/// returns for that case.
struct Echo(hahn::Kind, fn(u32) -> hahn::View);

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

/// The frames of every case `make` handles, as the server sends them.
async fn echoed(
    kind: hahn::Kind,
    cases: u32,
    make: fn(u32) -> hahn::View,
) -> Vec<(Value, Vec<u8>)> {
    use crate::memory::Topic;
    let mut topic = Topic::new("echo", "test/Echo", vec![("case", hahn::DataTypeDef::U32)]);
    for case in 0..cases {
        topic = topic.at(case as u64, vec![hahn::Value::U32(case)]);
    }
    let (_dir, app) = crate::memory::app(vec![topic], |builder| builder.view(Echo(kind, make)));
    let (status, mut events) = frames(&app, &view_url("views", "echo", "echo", "")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(events.pop().unwrap().0["type"], "complete");
    events
}

#[tokio::test]
async fn image_formats_are_normalized_and_checked() {
    let events = echoed(hahn::Kind::Image, 2, |case| {
        hahn::ImageView {
            frame_id: None,
            format: ["JPG", "bmp"][case as usize].into(),
            data: [1u8].as_slice().into(),
        }
        .into()
    })
    .await;
    assert_eq!(events[0].0["value"]["format"], "jpeg");
    assert_eq!(events[0].0["value"]["frame_id"], Value::Null);
    let error = events[1].0["error"].as_str().unwrap();
    assert!(error.contains("Unsupported image format"), "{error}");
}

#[tokio::test]
async fn unset_rotations_are_identity_and_others_are_normalized() {
    let events = echoed(hahn::Kind::Pose, 3, |case| {
        hahn::PoseView {
            frame_id: None,
            pose: hahn::Pose {
                position: [0.; 3],
                orientation: [0., 0., 0., [0., 2., f64::NAN][case as usize]],
            },
        }
        .into()
    })
    .await;
    for (header, _) in &events[..2] {
        assert_eq!(
            header["value"]["pose"]["orientation"],
            json!([0., 0., 0., 1.])
        );
    }
    assert!(
        events[2].0["error"]
            .as_str()
            .unwrap()
            .contains("Non-finite")
    );
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
    assert_eq!(value["omitted"], 1);
    let blob = &value["fields"][0]["data"]["$blob"];
    let offset = blob["offset"].as_u64().unwrap() as usize;
    assert_eq!(blob["length"], 2);
    assert_eq!(&payload[offset..offset + 2], [10, 30]);
    let error = events[1].0["error"].as_str().unwrap();
    assert!(error.contains("one value per point"), "{error}");
}

#[tokio::test]
async fn a_shape_off_the_earth_is_left_out_alone_and_counted() {
    let events = echoed(hahn::Kind::Geo, 1, |_| {
        hahn::GeoView {
            frame_id: None,
            features: vec![
                hahn::GeoFeature::point(10., 0., Some(f64::NAN)),
                hahn::GeoFeature::point(91., 0., None),
            ],
        }
        .into()
    })
    .await;
    let value = &events[0].0["value"];
    // An altitude that is not finite is left out of the point.
    assert_eq!(
        value["features"],
        json!([{"type": "Feature", "geometry": {"type": "Point", "coordinates": [0., 10.]}, "properties": {}}])
    );
    assert_eq!(value["omitted"], 1);
}

#[tokio::test]
async fn foxglove_geojson_is_read_as_shapes() {
    use crate::memory::Topic;
    use hahn::{DataTypeDef as D, Value as V};
    let text = |document: serde_json::Value| V::string(document.to_string());
    let line = json!({"type": "LineString", "coordinates": [[0., 0.], [1., 1.]]});
    let topic = Topic::new("shapes", "foxglove.GeoJSON", vec![("geojson", D::String)])
        .at(
            1,
            vec![text(json!({"type": "FeatureCollection", "features": [
                {"type": "Feature", "geometry": line, "properties": {"name": "road"}},
                {"type": "Feature", "properties": {}},
            ]}))],
        )
        .at(2, vec![text(line.clone())])
        .at(3, vec![V::string("{broken")]);
    let (_dir, app) = crate::memory::app(vec![topic], |builder| builder);
    let (_, events) = frames(&app, &view_url("views", "shapes", "geojson", "")).await;
    let first = &events[0].0["value"];
    assert_eq!(first["kind"], "geo");
    assert_eq!(first["features"][0]["properties"]["name"], "road");
    // The feature without a geometry is left out and counted.
    assert_eq!(first["omitted"], 1);
    assert_eq!(events[1].0["value"]["features"][0]["geometry"], line);
    assert!(events[2].0["error"].is_string());
}

#[tokio::test]
async fn blobs_start_on_eight_byte_boundaries_and_frames_end_on_one() {
    use crate::memory::Topic;
    let topic = Topic::new("echo", "test/Echo", vec![("case", hahn::DataTypeDef::U32)])
        .at(0, vec![hahn::Value::U32(0)]);
    let make = |_| {
        hahn::PointCloudView {
            positions: vec![[1., 2., 3.]; 3],
            fields: vec![hahn::PointField {
                name: "intensity".into(),
                numeric_type: hahn::NumericType::U8,
                data: vec![7; 3],
            }],
            ..Default::default()
        }
        .into()
    };
    let (_dir, app) = crate::memory::app(vec![topic], |builder| {
        builder.view(Echo(hahn::Kind::PointCloud, make))
    });
    let url = resolve(&app, &view_url("views", "echo", "echo", "")).await;
    let response = app
        .oneshot(Request::get(&url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = response.into_body().collect().await.unwrap().to_bytes();

    // A frame with 36 bytes of positions and 3 of intensity, then `complete`.
    let header_len = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    let payload_len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    let header: Value = serde_json::from_slice(&body[8..8 + header_len]).unwrap();
    let start = (8 + header_len).next_multiple_of(8);
    assert!(body[8 + header_len..start].iter().all(|b| *b == 0));
    let value = &header["value"];
    // Each blob is padded to the next boundary, whatever the order.
    assert_eq!(
        value["fields"][0]["data"]["$blob"],
        json!({"offset": 0, "length": 3})
    );
    assert_eq!(
        value["positions"]["$blob"],
        json!({"offset": 8, "length": 36})
    );
    assert_eq!(payload_len, 48);
    let payload = &body[start..start + payload_len];
    assert_eq!(payload[..3], [7; 3]);
    assert_eq!(payload[3..8], [0; 5]);
    assert_eq!(payload[8..12], 1f32.to_le_bytes());
    assert_eq!(payload[44..], [0; 4]);

    // A frame without a payload still ends on a boundary.
    let rest = &body[start + payload_len..];
    let complete_len = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
    assert_eq!(u32::from_le_bytes(rest[4..8].try_into().unwrap()), 0);
    assert_eq!(rest.len(), (8 + complete_len).next_multiple_of(8));
}

#[tokio::test]
async fn a_type_of_the_right_name_but_wrong_shape_is_not_offered_a_view() {
    use crate::memory::Topic;
    use hahn::DataTypeDef::{Bytes, String};
    let image = |name, schema_name, data| {
        Topic::new(
            name,
            schema_name,
            vec![("frame_id", String), ("data", data), ("format", String)],
        )
        .at(0, vec![])
    };
    let (_dir, app) = crate::memory::app(
        vec![
            image("right", "foxglove.CompressedImage", Bytes),
            image("other_name", "other.CompressedImage", Bytes),
            image("wrong_shape", "foxglove.CompressedImage", String),
        ],
        |builder| builder,
    );
    let (_, topics) = get(app, "/g/topics").await;
    let views = |i: usize| topics[i]["views"].as_array().unwrap().len();
    assert_eq!(topics[0]["views"][0]["id"], "image");
    assert_eq!(views(1), 0);
    assert_eq!(views(2), 0);
}

#[tokio::test]
async fn foxglove_calibration_is_read_under_either_spelling() {
    use crate::memory::{Topic, list};
    use hahn::{DataTypeDef as D, Value as V};
    let calibration = |name, schema_name, matrix, distortion| {
        let k = [400., 0., 320., 0., 400., 240., 0., 0., 1.]
            .map(V::F64)
            .to_vec();
        Topic::new(
            name,
            schema_name,
            vec![
                ("frame_id", D::String),
                ("width", D::U32),
                ("height", D::U32),
                ("distortion_model", D::String),
                (matrix, list(D::F64)),
                (distortion, list(D::F64)),
            ],
        )
        .at(
            0,
            vec![
                V::string("camera"),
                V::U32(640),
                V::U32(480),
                V::string("plumb_bob"),
                V::List(k),
                V::List(vec![]),
            ],
        )
    };
    let (_dir, app) = crate::memory::app(
        vec![
            // Protobuf capitalizes the matrices, and `foxglove_msgs` does not.
            calibration("protobuf", "foxglove.CameraCalibration", "K", "D"),
            calibration("ros", "foxglove_msgs/msg/CameraCalibration", "k", "d"),
        ],
        |builder| builder,
    );
    for topic in ["protobuf", "ros"] {
        let url = view_url("views/latest", topic, "camera_calibration", "&time_ns=0");
        let (status, events) = frames(&app, &url).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(events[0].0["value"]["intrinsics"][0], 400., "{topic}");
    }
}

#[tokio::test]
async fn values_carry_the_measurement_time_their_message_records() {
    use crate::memory::{Topic, structure};
    use hahn::{DataTypeDef as T, Value as V};
    let time = |nanos: &str| structure(vec![("sec", T::I32), (nanos, T::U32)]);
    let ros = Topic::new(
        "ros",
        "test/Echo",
        vec![
            ("case", T::U32),
            ("header", structure(vec![("stamp", time("nanosec"))])),
        ],
    );
    let foxglove = Topic::new(
        "foxglove",
        "test/Echo",
        vec![("case", T::U32), ("timestamp", time("nsec"))],
    );
    let stamp = |sec, nanos| V::Struct(vec![V::I32(sec), V::U32(nanos)]);
    let ros = ros
        .at(5, vec![V::U32(0), V::Struct(vec![stamp(1, 500)])])
        .at(6, vec![V::U32(1), V::Struct(vec![stamp(0, 0)])])
        .at(7, vec![V::U32(2), V::Struct(vec![stamp(-1, 0)])]);
    let foxglove = foxglove.at(5, vec![V::U32(0), stamp(2, 7)]);
    let (_dir, app) = crate::memory::app(vec![ros, foxglove], |builder| {
        builder.view(Echo(hahn::Kind::Pose, |_| {
            hahn::PoseView {
                frame_id: Some("map".into()),
                pose: hahn::Pose::default(),
            }
            .into()
        }))
    });
    let stamps = |topic: &'static str| {
        let app = app.clone();
        async move {
            let (_, events) = frames(&app, &view_url("views", topic, "echo", "")).await;
            events
                .iter()
                .filter(|(header, _)| header["type"] == "frame")
                .map(|(header, _)| {
                    assert_eq!(header["value"]["kind"], "pose");
                    (
                        header["time_ns"].clone(),
                        header["value"]["stamp_ns"].clone(),
                    )
                })
                .collect::<Vec<_>>()
        }
    };
    // The stamp is the message's own, not its recording time. Zero and invalid stamps
    // say nothing, and the value is still sent.
    assert_eq!(
        stamps("ros").await,
        vec![
            (json!("5"), json!("1000000500")),
            (json!("6"), Value::Null),
            (json!("7"), Value::Null),
        ]
    );
    assert_eq!(
        stamps("foxglove").await,
        vec![(json!("5"), json!("2000000007"))]
    );
}

#[tokio::test]
async fn images_suggest_the_calibration_their_names_share() {
    use crate::memory::{Topic, list};
    use hahn::DataTypeDef as D;
    let image = |name: &'static str| {
        Topic::new(
            name,
            "foxglove.CompressedImage",
            vec![
                ("frame_id", D::String),
                ("format", D::String),
                ("data", D::Bytes),
            ],
        )
    };
    let calibration = |name: &'static str| {
        Topic::new(
            name,
            "foxglove.CameraCalibration",
            vec![
                ("frame_id", D::String),
                ("width", D::U32),
                ("height", D::U32),
                ("K", list(D::F64)),
                ("D", list(D::F64)),
                ("distortion_model", D::String),
            ],
        )
    };
    let (_dir, app) = crate::memory::app(
        vec![
            image("/front/image_raw"),
            image("/front/image_rect/compressed"),
            calibration("/front/camera_info"),
            image("/left"),
            calibration("/left/calibration"),
            image("/twin"),
            calibration("/twin/a"),
            calibration("/twin/b"),
            image("/lonely/image"),
        ],
        |builder| builder,
    );
    let (_, topics) = get(app, "/g/topics").await;
    let view = |name: &str| {
        topics
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["topic"] == name)
            .unwrap()["views"][0]
            .clone()
    };
    let suggested = |name: &str| view(name)["calibration"]["topic"].clone();
    assert_eq!(suggested("/front/image_raw"), "/front/camera_info");
    assert_eq!(view("/front/image_raw")["rectified"], false);
    assert_eq!(
        suggested("/front/image_rect/compressed"),
        "/front/camera_info"
    );
    assert_eq!(view("/front/image_rect/compressed")["rectified"], true);
    assert_eq!(
        view("/front/image_raw")["calibration"]["view"],
        "camera_calibration"
    );
    // A Foxglove camera named by its image topic.
    assert_eq!(suggested("/left"), "/left/calibration");
    assert!(view("/left").get("rectified").is_none());
    // Two candidates, or none, suggest nothing.
    assert!(view("/twin").get("calibration").is_none());
    assert!(view("/lonely/image").get("calibration").is_none());
}
