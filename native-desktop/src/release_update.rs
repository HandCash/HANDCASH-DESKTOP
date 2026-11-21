//! Portable release downloads only: never replace an executable or touch wallet data.
use crate::durable::DurableStore;
use serde_json::{json, Value};
use std::{io::Read, sync::{Arc, Mutex}, thread, time::Duration};

const KEY: &str = "handcash.update.mode";
const LIMIT: u64 = 2 * 1024 * 1024;
const PREFIX: &str = "https://github.com/HandCash/HANDCASH-DESKTOP/releases/download/";
type Push = Arc<dyn Fn(Value) + Send + Sync>;
type Fetch = Arc<dyn Fn() -> Result<Value, String> + Send + Sync>;
struct State { status: Value, pending: Option<String>, checking: bool, generation: u64 }
pub struct ReleaseUpdater {
    state: Mutex<State>, push: Mutex<Option<Push>>, store: Arc<DurableStore>,
    started: std::sync::atomic::AtomicBool,
    fetch: Fetch, os: String, arch: String,
}
fn version(s: &str) -> Option<[u64; 3]> {
    let s = s.trim().strip_prefix('v').unwrap_or(s.trim());
    let mut parts = s.splitn(2, '-');
    let numbers = parts.next()?;
    if let Some(suffix) = parts.next() {
        if suffix.is_empty() || !suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') { return None; }
    }
    let values: Vec<_> = numbers.split('.').collect();
    if values.len() != 3 || values.iter().any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit())) { return None; }
    Some([values[0].parse().ok()?, values[1].parse().ok()?, values[2].parse().ok()?])
}
fn select(releases: &Value, current: &str, os: &str, arch: &str) -> Option<(String, String)> {
    let current = version(current)?;
    let mut best: Option<([u64;3], String, String)> = None;
    for release in releases.as_array()? {
        if release["draft"] == true { continue; }
        let Some(tag) = release["tag_name"].as_str() else { continue };
        let tag = tag.trim();
        let v = tag.strip_prefix('v').unwrap_or(tag);
        let Some(parsed) = version(v) else { continue };
        if parsed <= current || best.as_ref().is_some_and(|b| parsed <= b.0) { continue; }
        let name = format!("HandCash-{v}-{arch}-{os}.zip");
        let Some(assets) = release["assets"].as_array() else { continue };
        for asset in assets {
            let Some(url) = asset["browser_download_url"].as_str() else { continue };
            // Exact repository, tag and asset; no arbitrary redirects from release metadata.
            if asset["name"] == name && url == format!("{PREFIX}{tag}/{name}") {
                best = Some((parsed, v.into(), url.into())); break;
            }
        }
    }
    best.map(|(_, v, u)| (v, u))
}
fn read_json(reader: impl Read) -> Result<Value, String> {
    let mut bytes = Vec::new();
    reader.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| "Release response could not be read")?;
    if bytes.len() as u64 > LIMIT { return Err("Release response too large".into()); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid release response")?;
    if !value.is_array() { return Err("Invalid release response".into()); }
    Ok(value)
}
fn fetch() -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true).redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25)).connect_timeout(Duration::from_secs(10))
        .user_agent("HandCash-Desktop").build().map_err(|_| "Update client unavailable")?;
    let response = client.get("https://api.github.com/repos/HandCash/HANDCASH-DESKTOP/releases?per_page=20")
        .header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28")
        .send().map_err(|_| "Update check failed or timed out")?;
    if !response.status().is_success() { return Err(format!("GitHub release check failed ({})", response.status().as_u16())); }
    read_json(response)
}
impl ReleaseUpdater {
    pub fn new(store: Arc<DurableStore>, current: &str, platform: &str) -> Arc<Self> {
        let mode = store.get(KEY).filter(|m| m == "manual" || m == "none").unwrap_or("default".into());
        Arc::new(Self {
            state: Mutex::new(State { status: json!({"phase":"idle","mode":mode,"currentVersion":current,
                "availableVersion":null,"percent":null,"error":null,"canInstall":false}),
                pending: None, checking: false, generation: 0 }),
            push: Mutex::new(None), store, fetch: Arc::new(fetch),
            started: std::sync::atomic::AtomicBool::new(false),
            os: if platform == "win32" { "win" } else { "linux" }.into(),
            arch: if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }.into(),
        })
    }
    pub fn set_push(&self, push: impl Fn(Value) + Send + Sync + 'static) { *self.push.lock().unwrap() = Some(Arc::new(push)); }
    fn publish(&self, status: Value) -> Value {
        // Serialize delivery and skip snapshots superseded before publication.
        // The handler only queues a host event; it must not reenter this updater.
        let push = self.push.lock().unwrap();
        if self.status() == status {
            if let Some(push) = push.as_ref() { push(status.clone()); }
        }
        status
    }
    pub fn status(&self) -> Value { self.state.lock().unwrap().status.clone() }
    pub fn mode(&self, mode: &str) -> Result<Value, String> {
        if !["default", "manual", "none"].contains(&mode) { return Err("Invalid update mode".into()); }
        let mut s = self.state.lock().unwrap();
        if !self.store.set(KEY, mode, false) { return Err("Update mode could not be saved".into()); }
        s.generation += 1;
        s.status["mode"] = json!(mode);
        s.pending = None;
        s.status["phase"] = json!("idle");
        s.status["availableVersion"] = Value::Null;
        s.status["canInstall"] = json!(false);
        s.status["error"] = Value::Null;
        let status = s.status.clone(); drop(s);
        Ok(self.publish(status))
    }
    pub fn check(&self, auto: bool) -> Value {
        let mut s = self.state.lock().unwrap();
        if s.checking || (auto && s.status["mode"] != "default") { return s.status.clone(); }
        if s.status["mode"] == "none" {
            s.status["phase"] = json!("error"); s.status["error"] = json!("Updates are off.");
            let status = s.status.clone(); drop(s); return self.publish(status);
        }
        s.checking = true;
        s.pending = None;
        s.status["phase"] = json!("checking");
        s.status["error"] = Value::Null;
        s.status["canInstall"] = json!(false);
        s.status["availableVersion"] = Value::Null;
        let generation = s.generation;
        let status = s.status.clone(); drop(s); self.publish(status);
        // No wallet/storage lock, or updater mutex, is held during HTTP.
        let result = (self.fetch)();
        let mut s = self.state.lock().unwrap();
        s.checking = false;
        if generation != s.generation { return s.status.clone(); }
        match result {
            Ok(releases) => {
                let pending = select(&releases, s.status["currentVersion"].as_str().unwrap_or(""), &self.os, &self.arch);
                s.status["phase"] = json!(if pending.is_some() { "available" } else { "not-available" });
                s.status["canInstall"] = json!(pending.is_some());
                s.status["availableVersion"] = pending.as_ref().map(|p| json!(p.0)).unwrap_or(Value::Null);
                s.pending = pending.map(|p| p.1);
            }
            Err(error) => {
                s.status["phase"] = json!(if auto { "idle" } else { "error" });
                s.status["error"] = if auto { Value::Null } else { json!(error) };
            }
        }
        let status = s.status.clone(); drop(s); self.publish(status)
    }
    pub fn download(&self) -> Value {
        let s = self.state.lock().unwrap();
        let generation = s.generation;
        let url = if s.status["mode"] == "none" { None } else { s.pending.clone() };
        drop(s);
        let result = if let Some(url) = url { open::that(url).map_err(|_| "Download could not be opened.".to_string()) }
            else { Err("Check for updates first.".into()) };
        let mut s = self.state.lock().unwrap();
        if generation != s.generation { return s.status.clone(); }
        s.status["error"] = json!(result.err().unwrap_or("Download opened — unzip it over this install, then reopen HandCash.".into()));
        let status = s.status.clone(); drop(s); self.publish(status)
    }
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, std::sync::atomic::Ordering::AcqRel) { return; }
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(4));
            loop {
                let Some(updater) = weak.upgrade() else { break };
                updater.check(true); drop(updater);
                thread::sleep(Duration::from_secs(4 * 60 * 60));
            }
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn versions_are_numeric_and_bounded() {
        assert!(version("1.10.0") > version("1.9.99"));
        for bad in ["1.2", "1.2.3/", "1.2.3-", "18446744073709551616.0.0"] { assert_eq!(version(bad), None); }
        assert_eq!(version("v1.2.3-beta.1"), Some([1,2,3]));
    }
    #[test] fn selects_only_repository_and_native_asset() {
        let url = format!("{PREFIX}v1.10.0/HandCash-1.10.0-arm64-linux.zip");
        let releases = json!([{"tag_name":"v1.10.0","assets":[{"name":"HandCash-1.10.0-arm64-linux.zip","browser_download_url":url}]}]);
        assert_eq!(select(&releases,"1.9.0","linux","arm64"), Some(("1.10.0".into(),url)));
        assert_eq!(select(&releases,"1.9.0","linux","x64"), None);
        assert_eq!(select(&releases,"1.10.0","linux","arm64"), None);
        let mut bad = releases;
        bad[0]["assets"][0]["browser_download_url"] = json!("https://evil.example/update.zip");
        assert_eq!(select(&bad,"1.9.0","linux","arm64"), None);
    }
    fn fixture(label: &str, fetch: Fetch) -> (std::path::PathBuf, Arc<ReleaseUpdater>) {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("hc-updater-{label}-{stamp}"));
        let mut updater = ReleaseUpdater::new(DurableStore::open(path.clone()).unwrap(), "1.0.0", "linux");
        Arc::get_mut(&mut updater).unwrap().fetch = fetch;
        (path, updater)
    }
    #[test] fn reports_failure_without_staying_checking() {
        let (path, updater) = fixture("failure", Arc::new(|| Err("Update check failed or timed out".into())));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&seen);
        updater.set_push(move |s| captured.lock().unwrap().push(s["phase"].clone()));
        assert_eq!(updater.check(false)["phase"], "error");
        assert_eq!(*seen.lock().unwrap(), vec![json!("checking"), json!("error")]);
        assert_eq!(updater.check(true)["phase"], "idle");
        assert_eq!(updater.status()["error"], Value::Null);
        drop(updater); std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn mode_is_durable_and_invalid_mode_is_rejected() {
        let (path, updater) = fixture("mode", Arc::new(|| panic!("disabled updater must not fetch")));
        assert!(updater.mode("invalid").is_err());
        updater.mode("none").unwrap();
        assert_eq!(updater.check(false)["error"], "Updates are off.");
        assert_eq!(updater.check(true)["mode"], "none");
        let restored = ReleaseUpdater::new(DurableStore::open(path.clone()).unwrap(), "1.0.0", "linux");
        assert_eq!(restored.status()["mode"], "none");
        drop(restored); drop(updater); std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn disabling_during_http_discards_late_result_and_deduplicates() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let (path, updater) = fixture("late", Arc::new(move || {
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(json!([]))
        }));
        let worker = Arc::clone(&updater);
        let handle = thread::spawn(move || worker.check(false));
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(updater.check(false)["phase"], "checking");
        updater.mode("none").unwrap();
        release_tx.send(()).unwrap();
        let result = handle.join().unwrap();
        assert_eq!(result["phase"], "idle");
        assert_eq!(result["mode"], "none");
        assert_eq!(result["canInstall"], false);
        drop(updater); std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn available_release_is_projected_without_downloading() {
        let (path, mut updater) = fixture("available", Arc::new(|| Ok(json!([
            {"tag_name":null}, {"tag_name":"v1.2.0","draft":true},
            {"tag_name":"v1.1.0","assets":[{"name":"HandCash-1.1.0-arm64-linux.zip",
             "browser_download_url":format!("{PREFIX}v1.1.0/HandCash-1.1.0-arm64-linux.zip")}]}
        ]))));
        Arc::get_mut(&mut updater).unwrap().arch = "arm64".into();
        let result = updater.check(false);
        assert_eq!(result["phase"], "available");
        assert_eq!(result["availableVersion"], "1.1.0");
        updater.mode("none").unwrap();
        assert!(updater.state.lock().unwrap().pending.is_none());
        drop(updater); std::fs::remove_dir_all(path).unwrap();
    }
    #[test] fn bounds_and_validates_response() {
        assert!(read_json(&b"[]"[..]).is_ok());
        assert!(read_json(&b"{}"[..]).is_err());
        assert!(read_json(&b"["[..]).is_err());
        assert!(read_json(std::io::repeat(b' ').take(LIMIT+1)).is_err());
    }
}
