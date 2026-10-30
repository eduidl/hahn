mod support;

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "visual.mcap".into());
    support::write_visual_fixture(std::path::Path::new(&path))?;
    println!(
        "Created {path}: {} messages per topic",
        support::VISUAL_COUNT
    );
    Ok(())
}
