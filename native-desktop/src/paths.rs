//! Shared user-data path resolution for native-desktop host services
//! (logs, BRC-39 archive, call recordings, app browser storage, sidecar).
//!
//! Note: `durable.rs` keeps its own `ProjectDirs` path (`thin-shell/durable`)
//! untouched so existing user vaults remain accessible across upgrades.

use std::path::PathBuf;

/// Root user-data directory matching `electron/bridgeSidecar.ts`:
/// `HANDCASH_USER_DATA` if set, otherwise:
/// - Windows: `%APPDATA%\HandCashDesktopNative`
/// - Linux: `$XDG_CONFIG_HOME/HandCashDesktopNative` or `~/.config/HandCashDesktopNative`
pub fn user_data_dir() -> PathBuf {
    if let Ok(raw) = std::env::var("HANDCASH_USER_DATA") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let trimmed = appdata.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("HandCashDesktopNative");
            }
        }
    }

    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join("Library/Application Support/HandCashDesktopNative");
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            let trimmed = xdg.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("HandCashDesktopNative");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join(".config")
                    .join("HandCashDesktopNative");
            }
        }
    }

    if let Some(dirs) = directories::ProjectDirs::from("io", "handcash", "HandCashDesktopNative") {
        return dirs.config_dir().to_path_buf();
    }

    std::env::temp_dir().join("HandCashDesktopNative")
}

/// True when running from a packaged release bundle rather than Vite dev mode.
pub fn is_packaged() -> bool {
    if std::env::var_os("HANDCASH_UI_ROOT").is_some() {
        return true;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.join("app").join("index.html").is_file() {
                return true;
            }
        }
    }
    false
}
