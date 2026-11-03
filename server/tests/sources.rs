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
