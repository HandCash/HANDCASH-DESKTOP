//! Omarchy desktop theme reader + live watcher (`getOmarchyTheme` / `onOmarchyTheme`).
//!
//! Parity with `electron/omarchyTheme.ts`:
//! Reads `~/.local/state/omarchy/current/theme/colors.toml` and `theme.name`
//! on Linux. Plain Linux / Windows returns `{ ok: true, detected: false }`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

fn default_state_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").ok()?;
        let trimmed = home.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(PathBuf::from(trimmed).join(".local/state/omarchy/current"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

pub fn read_omarchy_theme() -> Value {
    let Some(state_dir) = default_state_dir() else {
        return json!({ "ok": true, "detected": false });
    };
    read_omarchy_theme_from(&state_dir)
}

pub fn read_omarchy_theme_from(state_dir: &Path) -> Value {
    let colors_file = state_dir.join("theme").join("colors.toml");
    if !colors_file.exists() {
        return json!({ "ok": true, "detected": false });
    }
    let raw = match fs::read_to_string(&colors_file) {
        Ok(s) => s,
        Err(e) => {
            return json!({
                "ok": false,
                "error": e.to_string(),
            })
        }
    };
    let map = parse_toml_colors(&raw);
    let mut name = "Omarchy".to_string();
    let name_file = state_dir.join("theme.name");
    if let Ok(text) = fs::read_to_string(&name_file) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            name = trimmed.to_string();
        }
    }
    let mode = if map.get("mode").map(|s| s.as_str()) == Some("light") {
        "light"
    } else {
        "dark"
    };
    let bg_default = if mode == "light" { "#fafbfa" } else { "#1a1b26" };
    let background = require_hex(&map, "background", bg_default);
    json!({
        "ok": true,
        "detected": true,
        "colors": {
            "mode": mode,
            "name": name,
            "background": background,
            "darkBackground": require_hex(&map, "dark_background", &background),
            "darkerBackground": require_hex(&map, "darker_background", &background),
            "lighterBackground": require_hex(&map, "lighter_background", &background),
            "foreground": require_hex(&map, "foreground", if mode == "light" { "#1a1f1a" } else { "#a9b1d6" }),
            "darkForeground": require_hex(&map, "dark_foreground", "#6e7687"),
            "lightForeground": require_hex(&map, "light_foreground", if mode == "light" { "#403e3c" } else { "#a9b1d6" }),
            "brightForeground": require_hex(&map, "bright_foreground", if mode == "light" { "#1a1f1a" } else { "#c0caf5" }),
            "accent": require_hex(&map, "accent", if mode == "light" { "#0c8f3e" } else { "#57ff97" }),
            "muted": require_hex(&map, "muted", "#414868"),
            "selection": require_hex(&map, "selection", "#292e42"),
            "red": require_hex(&map, "red", "#f87171"),
            "green": require_hex(&map, "green", if mode == "light" { "#40a02b" } else { "#9ece6a" }),
        }
    })
}

/// Starts a lightweight background watcher when Omarchy's state directory exists,
/// emitting new snapshots via `on_change` whenever `colors.toml` or `theme.name` changes.
pub fn start_watcher<F>(on_change: F)
where
    F: Fn(Value) + Send + 'static,
{
    let Some(state_dir) = default_state_dir() else {
        return;
    };
    if !state_dir.exists() {
        return;
    }
    thread::spawn(move || {
        let mut last = read_omarchy_theme_from(&state_dir);
        loop {
            thread::sleep(Duration::from_millis(500));
            let next = read_omarchy_theme_from(&state_dir);
            if next != last {
                last = next.clone();
                on_change(next);
            }
        }
    });
}

fn parse_toml_colors(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some((k, rest)) = trimmed.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if key.is_empty()
            || !key
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            continue;
        }
        let val = rest.trim();
        if val.len() >= 2 && val.starts_with('"') && val.ends_with('"') {
            let inner = &val[1..val.len() - 1];
            if !inner.contains('"') {
                out.insert(key.to_string(), inner.to_string());
            }
        }
    }
    out
}

fn require_hex(map: &HashMap<String, String>, key: &str, fallback: &str) -> String {
    if let Some(raw) = map.get(key) {
        let v = raw.trim();
        if is_valid_hex(v) {
            return v.to_string();
        }
    }
    fallback.to_string()
}

fn is_valid_hex(v: &str) -> bool {
    let Some(hex) = v.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn detects_and_parses_omarchy_colors_toml() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-omarchy-{stamp}"));
        let theme = dir.join("theme");
        fs::create_dir_all(&theme).unwrap();
        fs::write(dir.join("theme.name"), "Tokyo Night\n").unwrap();
        fs::write(
            theme.join("colors.toml"),
            r##"
mode = "dark"
background = "#1a1b26"
darker_background = "#16161e"
foreground = "#c0caf5"
accent = "#7aa2f7"
red = "not-a-hex"
"##,
        )
        .unwrap();

        let snap = read_omarchy_theme_from(&dir);
        assert_eq!(snap["ok"], Value::Bool(true));
        assert_eq!(snap["detected"], Value::Bool(true));
        assert_eq!(snap["colors"]["name"], json!("Tokyo Night"));
        assert_eq!(snap["colors"]["mode"], json!("dark"));
        assert_eq!(snap["colors"]["background"], json!("#1a1b26"));
        assert_eq!(snap["colors"]["darkerBackground"], json!("#16161e"));
        assert_eq!(snap["colors"]["accent"], json!("#7aa2f7"));
        // Invalid hex falls back safely.
        assert_eq!(snap["colors"]["red"], json!("#f87171"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_colors_toml_reports_not_detected() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-omarchy-missing-{stamp}"));
        let snap = read_omarchy_theme_from(&dir);
        assert_eq!(snap, json!({ "ok": true, "detected": false }));
    }
}
