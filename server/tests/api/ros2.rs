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
    assert_eq!(kind("/fix"), "geo");
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
    let feature = &events[0].0["value"]["features"][0];
    assert_eq!(feature["geometry"]["coordinates"], json!([139., 35., 40.]));
    assert_eq!(feature["properties"]["accuracy_m"], 3.);
    assert_eq!(events[1].0["value"]["features"][0]["properties"], json!({}));
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
    // Interpolated on /tf, and held at all times on /tf_static.
    let (_, body) = get(app, "/r/transforms?target=map&time_ns=15").await;
    assert_eq!(body["frames"]["lidar"]["translation"], json!([5., 0., 2.]));
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
