mod support;

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "acme.mcap".into());
    let path = std::path::Path::new(&path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    support::ros2::write_acme_fixture(path, false)?;
    let log = path.with_extension("acmelog");
    support::acme_log::write_acme_log(&log)?;
    println!(
        "Created {}: {} acme_msgs/msg/Pose2D on /acme_pose, acme_msgs/msg/Link2D on /acme_link",
        path.display(),
        support::ros2::ACME_COUNT
    );
    println!("Created {}: /speed and /battery", log.display());
    Ok(())
}
