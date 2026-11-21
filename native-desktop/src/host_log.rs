//! Rotating host log file (`<userData>/logs/main.log`) backing `getLogInfo`,
//! `readLogs`, `openLogs`, and `uploadLogs` on `window.handcash`.

use crate::log_privacy::LogScrubber;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MIN_READ_BYTES: usize = 4_096;
const DEFAULT_READ_BYTES: usize = 256_000;
const MAX_READ_BYTES: usize = 1_048_576;

pub struct HostLog {
    dir: PathBuf,
    file: PathBuf,
    old_file: PathBuf,
    lock: Mutex<()>,
    scrubber: LogScrubber,
}

impl HostLog {
    pub fn open_default() -> Arc<Self> {
        let dir = crate::paths::user_data_dir().join("logs");
        Self::open(dir)
    }

    pub fn open(dir: PathBuf) -> Arc<Self> {
        let _ = fs::create_dir_all(&dir);
        #[cfg(unix)]
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        let file = dir.join("main.log");
        let old_file = dir.join("main.old.log");
        let log = Arc::new(Self {
            dir,
            file,
            old_file,
            lock: Mutex::new(()),
            scrubber: LogScrubber::new_random(),
        });
        log.append("info", "shell", "handcash-shell log initialized");
        log
    }

    pub fn append(&self, level: &str, source: &str, message: &str) {
        let scrubbed = self.scrubber.scrub(message);
        let line = format!(
            "[{}] [{}] [{}] {}\n",
            format_utc_now(),
            level,
            source,
            scrubbed
        );
        eprint!("{line}");
        let Ok(_guard) = self.lock.lock() else {
            return;
        };
        let _ = fs::create_dir_all(&self.dir);
        if let Ok(meta) = fs::metadata(&self.file) {
            if meta.len() >= MAX_LOG_FILE_BYTES {
                let _ = fs::remove_file(&self.old_file);
                let _ = fs::rename(&self.file, &self.old_file);
            }
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.file) {
            #[cfg(unix)]
            let _ = fs::set_permissions(&self.file, fs::Permissions::from_mode(0o600));
            let _ = f.write_all(line.as_bytes());
        }
    }

    pub fn get_log_info(&self) -> Value {
        json!({
            "file": self.file.to_string_lossy(),
            "dir": self.dir.to_string_lossy(),
        })
    }

    pub fn read_logs(&self, requested_max_bytes: Option<u64>) -> Value {
        let max_bytes = requested_max_bytes
            .and_then(|v| usize::try_from(v).ok())
            .map(|v| v.clamp(MIN_READ_BYTES, MAX_READ_BYTES))
            .unwrap_or(DEFAULT_READ_BYTES);
        let _guard = self.lock.lock().ok();
        match fs::read(&self.file) {
            Ok(buf) => {
                let truncated = buf.len() > max_bytes;
                let slice = if truncated {
                    &buf[buf.len() - max_bytes..]
                } else {
                    &buf[..]
                };
                let text = String::from_utf8_lossy(slice).into_owned();
                json!({
                    "ok": true,
                    "text": text,
                    "bytes": slice.len(),
                    "truncated": truncated,
                })
            }
            Err(e) => json!({
                "ok": false,
                "error": e.to_string(),
            }),
        }
    }

    pub fn open_logs(&self) -> Value {
        let target = if self.dir.exists() {
            &self.dir
        } else {
            &self.file
        };
        match open::that(target) {
            Ok(()) => json!({
                "ok": true,
                "file": self.file.to_string_lossy(),
            }),
            Err(e) => json!({
                "ok": false,
                "error": e.to_string(),
            }),
        }
    }

    /// Matches `electron/main.ts`: never expose an unredacted raw-file uploader over IPC.
    pub fn upload_logs_denied() -> Value {
        json!({
            "ok": false,
            "error": "Use Send logs in Settings",
        })
    }
}

fn format_utc_now() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let days = (total_secs / 86_400) as i64;
    let sod = total_secs % 86_400;
    let h = sod / 3_600;
    let m = (sod % 3_600) / 60;
    let s = sod % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Howard Hinnant's civil-from-days algorithm (UTC Gregorian calendar).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_and_read_logs_round_trip() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-host-log-{stamp}"));
        let log = HostLog::open(dir.clone());
        log.append("info", "sidecar", "bridge listening");
        let info = log.get_log_info();
        assert!(info["file"].as_str().unwrap().ends_with("main.log"));
        let res = log.read_logs(Some(8_192));
        assert_eq!(res["ok"], Value::Bool(true));
        assert!(res["text"].as_str().unwrap().contains("bridge listening"));
        assert_eq!(res["truncated"], Value::Bool(false));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_logs_truncates_to_clamped_tail() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-host-log-trunc-{stamp}"));
        let log = HostLog::open(dir.clone());
        let big = "hello ".repeat(1_000);
        log.append("info", "test", &big);
        // Requests below 4096 clamp to 4096.
        let res = log.read_logs(Some(100));
        assert_eq!(res["ok"], Value::Bool(true));
        assert_eq!(res["truncated"], Value::Bool(true));
        assert_eq!(res["bytes"], json!(4_096));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn upload_logs_stays_denied() {
        let res = HostLog::upload_logs_denied();
        assert_eq!(res["ok"], Value::Bool(false));
        assert_eq!(res["error"], json!("Use Send logs in Settings"));
    }

    #[test]
    fn append_scrubs_sensitive_values_before_writing() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-host-log-privacy-{stamp}"));
        let log = HostLog::open(dir.clone());
        let txid = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
        log.append(
            "info",
            "brc100",
            &format!("paying $alice 12500 sat txid={txid} addr 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"),
        );
        let text = log.read_logs(Some(8_192))["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!text.contains("alice"));
        assert!(!text.contains("12500"));
        assert!(!text.contains(&txid[..8]));
        assert!(!text.contains("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
        assert!(text.contains("[amt] sat"));
        assert!(text.contains("[address]"));
        let _ = fs::remove_dir_all(dir);
    }
}
