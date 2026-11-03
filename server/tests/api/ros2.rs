//! The standard ROS 2 types, read like their Foxglove counterparts.

use crate::common::*;

fn ros2_app() -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    support::ros2::write_ros2_fixture(&dir.path().join("ros2.mcap")).unwrap();
    let app = hahn::router(dir.path()).unwrap();
    (dir, app)
}

#[tokio::test]
async fn ros2_topics_declare_the_same_kinds_as_foxglove_ones() {
    let (_dir, app) = ros2_app();
    let (_, topics) = get(app, "/g/topics").await;
    let kind = |name: &str| {
        let topic = topics
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["topic"] == name);
        topic.unwrap()["views"][0]["kind"].clone()
    };
    assert_eq!(kind("/camera/compressed"), "image");
    assert_eq!(kind("/camera/image"), "image");
    assert_eq!(kind("/camera/info"), "camera_calibration");
    assert_eq!(kind("/lidar"), "pointcloud");
    assert_eq!(kind("/odom"), "pose");
    assert_eq!(kind("/pose"), "pose");
    assert_eq!(kind("/pose_covariance"), "pose");
    assert_eq!(kind("/fix"), "geo_location");
}

#[tokio::test]
async fn ros2_compressed_image_reads_the_encoded_format() {
    let (_dir, app) = ros2_app();
    let (_, events) = frames(
        &app,
        &view_url("views", "/camera/compressed", "ros_image", ""),
    )
    .await;
    assert_eq!(events[0].0["value"]["format"], "jpeg");
    assert_eq!(events[0].0["value"]["frame_id"], "camera");
    assert_eq!(&events[0].1[..3], &[1, 2, 3]);
    assert_eq!(events[1].0["value"]["format"], "png");
    assert!(
        events[2].0["error"]
            .as_str()
            .unwrap()
            .contains("compressedDepth")
    );
}

#[tokio::test]
async fn ros2_raw_image_rejects_multibyte_big_endian_pixels() {
    let (_dir, app) = ros2_app();
    let (_, events) = frames(
        &app,
        &view_url("views", "/camera/image", "ros_raw_image", ""),
    )
    .await;
    let value = &events[0].0["value"];
    assert_eq!(value["frame_id"], "camera");
    assert_eq!(value["encoding"], "rgb8");
    assert_eq!(value["step"], 8);
    assert_eq!(&events[0].1[..8], &[255, 0, 0, 0, 255, 0, 9, 9]);
    // Single bytes have no byte order, whatever the flag says.
    assert_eq!(events[1].0["value"]["encoding"], "mono8");
    assert!(
        events[2].0["error"]
            .as_str()
            .unwrap()
            .contains("Big-endian")
    );
}

#[tokio::test]
async fn ros2_camera_info_uses_lower_case_fields() {
    let (_dir, app) = ros2_app();
    let (_, events) = frames(
        &app,
        &view_url("views", "/camera/info", "ros_camera_calibration", ""),
    )
    .await;
    let value = &events[0].0["value"];
    assert_eq!(value["frame_id"], "camera");
    assert_eq!(value["width"], 640.);
    assert_eq!(value["height"], 480.);
    assert_eq!(
        value["intrinsics"],
        json!([400., 0., 320., 0., 400., 240., 0., 0., 1.])
    );
    assert_eq!(value["distortion"], json!([0.1]));
    assert_eq!(value["distortion_model"], "plumb_bob");
    assert!(
        events[1].0["error"]
            .as_str()
            .unwrap()
            .contains("camera matrix")
    );
}

#[tokio::test]
async fn ros2_point_cloud_handles_padding_and_its_own_type_numbers() {
    let (_dir, app) = ros2_app();
    let (_, events) = frames(&app, &view_url("views", "/lidar", "ros_pointcloud", "")).await;
    let (header, payload) = &events[0];
    let value = &header["value"];
    assert_eq!(value["frame_id"], "lidar");
    // The second point has no position.
    assert_eq!(value["count"], 3);
    let blob = |reference: &Value| {
        let blob = &reference["$blob"];
        let offset = blob["offset"].as_u64().unwrap() as usize;
        &payload[offset..offset + blob["length"].as_u64().unwrap() as usize]
    };
    let positions: Vec<f32> = blob(&value["positions"])
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    assert_eq!(positions, [1., 0., 0., 3., 20., 0., 4., 30., 0.]);
    let fields = value["fields"].as_array().unwrap();
    // A field of several values does not fit a column of one value per point.
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0]["name"], "signed");
    assert_eq!(fields[0]["type"], "i8");
    assert_eq!(blob(&fields[0]["data"]), [0xff; 3]);
    assert_eq!(fields[1]["name"], "unsigned");
    assert_eq!(fields[1]["type"], "u8");
    assert_eq!(blob(&fields[1]["data"]), [0xfe; 3]);
    assert!(events[1].0["error"].as_str().unwrap().contains("row step"));
    assert!(
        events[2].0["error"]
            .as_str()
            .unwrap()
            .contains("Big-endian")
    );
}

#[tokio::test]
async fn ros2_poses_unwrap_their_covariance() {
    let (_dir, app) = ros2_app();
    let position = async |topic: &str, view: &str| {
        let (_, events) = frames(&app, &view_url("views", topic, view, "")).await;
        assert_eq!(events[0].0["value"]["frame_id"], "map");
        // The header stamp is the measurement time.
        assert_eq!(events[0].0["value"]["stamp_ns"], "1");
        events[0].0["value"]["pose"]["position"].clone()
    };
    assert_eq!(position("/odom", "ros_odometry").await, json!([2., 3., 4.]));
    assert_eq!(position("/pose", "ros_pose").await, json!([5., 6., 7.]));
    assert_eq!(
        position("/pose_covariance", "ros_pose").await,
        json!([8., 9., 10.])
    );
}

#[tokio::test]
async fn ros2_location_needs_a_fix_and_a_known_covariance() {
    let (_dir, app) = ros2_app();
    let (_, events) = frames(&app, &view_url("views", "/fix", "ros_location", "")).await;
    let location = &events[0].0["value"];
    assert_eq!(location["kind"], "geo_location");
    assert_eq!(location["position"], json!([139., 35.]));
    assert_eq!(location["altitude"], 40.);
    assert_eq!(location["accuracy_m"], 3.);
    // An unknown covariance holds no accuracy.
    assert!(events[1].0["value"].get("accuracy_m").is_none());
    assert!(
        events[2].0["error"]
            .as_str()
            .unwrap()
            .contains("No satellite fix")
    );
    assert!(
        events[3].0["error"]
            .as_str()
            .unwrap()
            .contains("Invalid location")
    );
}

#[tokio::test]
async fn ros2_transforms_join_the_frame_graph() {
    let (_dir, app) = ros2_app();
    let (_, frames) = get(app.clone(), "/r/frames").await;
    let frames = frames.to_string();
    assert!(frames.contains("lidar") && frames.contains("base"));
    // /tf_static holds at all times, /tf changes.
    let (_, body) = get(app.clone(), "/r/transforms/static").await;
    assert_eq!(body["transforms"][0]["child"], "lidar");
    assert_eq!(body["transforms"][0]["translation"], json!([0., 0., 2.]));
    // Each sample keeps the stamp of its own header.
    let (_, body) = get(app, "/r/transforms/dynamic?start_ns=0&end_ns=100").await;
    let stamps: Vec<_> = body["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sample| sample["stamp_ns"].clone())
        .collect();
    assert_eq!(stamps, vec![json!("10"), json!("20")]);
}

#[tokio::test]
async fn ros2_compressed_image_format_names_the_encoded_part() {
    use crate::memory::{Topic, structure};
    use hahn::{DataTypeDef as D, Value as V};
    let mut topic = Topic::new(
        "image",
        "sensor_msgs/msg/CompressedImage",
        vec![
            ("header", structure(vec![("frame_id", D::String)])),
            ("format", D::String),
            ("data", D::Bytes),
        ],
    );
    for (time, format) in ["jpeg", "mono8; png compressed ", ""].iter().enumerate() {
        topic = topic.at(
            time as u64,
            vec![
                V::Struct(vec![V::string("camera")]),
                V::string(*format),
                V::Bytes([1u8].as_slice().into()),
            ],
        );
    }
    let (_dir, app) = crate::memory::app(vec![topic], |builder| builder);
    let (_, events) = frames(&app, &view_url("views", "image", "ros_image", "")).await;
    assert_eq!(events[0].0["value"]["format"], "jpeg");
    assert_eq!(events[1].0["value"]["format"], "png");
    let error = events[2].0["error"].as_str().unwrap();
    assert!(error.contains("no name"), "{error}");
}

/// Shapes of the standard messages, as an in-memory recording holds them.
mod shapes {
    use crate::memory::{list, structure};
    use hahn::{DataTypeDef as D, Value as V};

    pub fn vector() -> D {
        structure(vec![("x", D::F64), ("y", D::F64), ("z", D::F64)])
    }
    pub fn quaternion() -> D {
        structure(vec![
            ("x", D::F64),
            ("y", D::F64),
            ("z", D::F64),
            ("w", D::F64),
        ])
    }
    pub fn pose() -> D {
        structure(vec![("position", vector()), ("orientation", quaternion())])
    }
    pub fn header() -> D {
        let time = structure(vec![("sec", D::I32), ("nanosec", D::U32)]);
        structure(vec![("stamp", time), ("frame_id", D::String)])
    }
    pub fn poses() -> D {
        list(pose())
    }
    pub fn stamped_poses() -> D {
        list(structure(vec![("header", header()), ("pose", pose())]))
    }
    pub fn header_value(sec: i32, frame: &str) -> V {
        V::Struct(vec![
            V::Struct(vec![V::I32(sec), V::U32(0)]),
            V::string(frame),
        ])
    }
    pub fn vector_value(x: f64) -> V {
        V::Struct(vec![V::F64(x), V::F64(0.), V::F64(0.)])
    }
    pub fn pose_value(x: f64) -> V {
        let still = V::Struct(vec![V::F64(0.), V::F64(0.), V::F64(0.), V::F64(1.)]);
        V::Struct(vec![vector_value(x), still])
    }
}

#[tokio::test]
async fn ros2_points_pose_arrays_and_paths_are_views() {
    use crate::memory::Topic;
    use hahn::Value as V;
    use shapes::*;
    let point = Topic::new(
        "point",
        "geometry_msgs/msg/PointStamped",
        vec![("header", header()), ("point", vector())],
    )
    .at(1, vec![header_value(3, "map"), vector_value(2.)]);
    let particles = Topic::new(
        "particles",
        "geometry_msgs/msg/PoseArray",
        vec![("header", header()), ("poses", poses())],
    )
    .at(
        1,
        vec![
            header_value(3, "map"),
            V::List(vec![pose_value(1.), pose_value(f64::NAN), pose_value(2.)]),
        ],
    );
    let stamped = |x: f64| V::Struct(vec![header_value(0, "map"), pose_value(x)]);
    let route = Topic::new(
        "route",
        "nav_msgs/msg/Path",
        vec![("header", header()), ("poses", stamped_poses())],
    )
    .at(
        1,
        vec![
            header_value(3, "map"),
            V::List(vec![stamped(1.), stamped(2.)]),
        ],
    )
    .at(
        2,
        vec![
            header_value(3, "map"),
            V::List(vec![stamped(1.), stamped(f64::NAN)]),
        ],
    );
    let (_dir, app) = crate::memory::app(vec![point, particles, route], |builder| builder);
    let values = |topic: &'static str, view: &'static str| {
        let app = app.clone();
        async move {
            let (status, events) = frames(&app, &view_url("views", topic, view, "")).await;
            assert_eq!(status, StatusCode::OK);
            events
                .into_iter()
                .map(|(header, _)| header)
                .collect::<Vec<_>>()
        }
    };
    let point = values("point", "ros_position").await;
    assert_eq!(
        point[0]["value"],
        json!({"kind": "position", "frame_id": "map", "position": [2., 0., 0.], "stamp_ns": "3000000000"})
    );
    // A pose that is not finite is left out of an unordered set alone, and counted.
    let particles = values("particles", "ros_poses").await;
    let value = &particles[0]["value"];
    assert!(particles[0]["error"].is_null(), "{}", particles[0]);
    assert_eq!(value["kind"], "poses");
    assert_eq!(value["omitted"], 1);
    let xs: Vec<_> = value["poses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pose| pose["position"][0].clone())
        .collect();
    assert_eq!(xs, vec![json!(1.), json!(2.)]);
    // In a path it would reshape the route, so the whole message fails.
    let route = values("route", "ros_path").await;
    assert_eq!(route[0]["value"]["kind"], "path");
    assert_eq!(
        route[0]["value"]["poses"][1]["position"],
        json!([2., 0., 0.])
    );
    assert!(route[1]["error"].is_string());
}

#[tokio::test]
async fn foxglove_poses_in_frame_are_paths_and_a_pose_in_frame_a_pose() {
    use crate::memory::Topic;
    use hahn::{DataTypeDef as D, Value as V};
    use shapes::*;
    let time = crate::memory::structure(vec![("sec", D::U32), ("nsec", D::U32)]);
    let stamp = V::Struct(vec![V::U32(5), V::U32(0)]);
    let pose = Topic::new(
        "pose",
        "foxglove.PoseInFrame",
        vec![
            ("timestamp", time.clone()),
            ("frame_id", D::String),
            ("pose", shapes::pose()),
        ],
    )
    .at(1, vec![stamp.clone(), V::string("map"), pose_value(4.)]);
    let route = Topic::new(
        "route",
        "foxglove.PosesInFrame",
        vec![
            ("timestamp", time),
            ("frame_id", D::String),
            ("poses", poses()),
        ],
    )
    .at(
        1,
        vec![
            stamp,
            V::string("map"),
            V::List(vec![pose_value(1.), pose_value(2.)]),
        ],
    );
    let (_dir, app) = crate::memory::app(vec![pose, route], |builder| builder);
    let (_, events) = frames(&app, &view_url("views", "pose", "pose_in_frame", "")).await;
    assert_eq!(events[0].0["value"]["kind"], "pose");
    assert_eq!(
        events[0].0["value"]["pose"]["position"],
        json!([4., 0., 0.])
    );
    assert_eq!(events[0].0["value"]["stamp_ns"], "5000000000");
    let (_, events) = frames(&app, &view_url("views", "route", "path", "")).await;
    assert_eq!(events[0].0["value"]["kind"], "path");
    assert_eq!(events[0].0["value"]["poses"].as_array().unwrap().len(), 2);
}
