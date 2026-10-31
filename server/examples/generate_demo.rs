mod support;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| "demo.mcap".into());
    let count = args
        .next()
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(30_000);
    // Timestamps shifted later, to generate the segments of a split recording.
    let offset_ns = args.next().map(|s| s.parse()).transpose()?.unwrap_or(0);
    support::write_fixture_at(std::path::Path::new(&path), count, true, None, offset_ns)?;
    println!("Created {path}: {count} samples per topic");
    Ok(())
}
