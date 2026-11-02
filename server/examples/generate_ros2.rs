mod support;

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "ros2.mcap".into());
    support::ros2::write_ros2_fixture(std::path::Path::new(&path))?;
    println!("Created {path}");
    Ok(())
}
