mod support;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| "demo.mcap".into());
    let count = args
        .next()
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(30_000);
    support::write_fixture(std::path::Path::new(&path), count, true)?;
    println!("Created {path}: {count} samples per topic");
    Ok(())
}
