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

