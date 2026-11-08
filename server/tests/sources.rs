//! Rules about the server's own source files.

use std::path::Path;

/// Tests live in `tests/` and go through the public API: the HTTP API and the
/// crate's public items. A test inside `src/` could reach private items, and keep
/// passing while the behavior a user sees is broken.
#[test]
fn sources_hold_no_tests() {
    let mut found = Vec::new();
    visit(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut found,
    );
    assert!(
        found.is_empty(),
        "Move these tests to server/tests/, testing through the public API:\n{}",
        found.join("\n")
    );
}

fn visit(dir: &Path, found: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            visit(&path, found);
            continue;
        }
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (number, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.starts_with("#[cfg(test)]")
                || line.starts_with("#[test]")
                || line.starts_with("#[tokio::test")
            {
                found.push(format!("{}:{}: {line}", path.display(), number + 1));
            }
        }
    }
}
