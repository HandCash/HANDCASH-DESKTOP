use std::fs;
use std::path::Path;

fn main() {
    let pkg_path = Path::new("../package.json");
    println!("cargo:rerun-if-changed=../package.json");
    let version = fs::read_to_string(pkg_path)
        .ok()
        .and_then(|raw| extract_version(&raw))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=HANDCASH_PACKAGE_VERSION={version}");
}

fn extract_version(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"version\"") {
            let after_colon = rest.trim_start().strip_prefix(':')?.trim();
            let quoted = after_colon.trim_end_matches(',').trim();
            if quoted.starts_with('"') && quoted.ends_with('"') && quoted.len() >= 2 {
                return Some(quoted[1..quoted.len() - 1].to_string());
            }
        }
    }
    None
}
