//! File-backed durable store + loopback sync HTTP for storageGetSync/SetSync.

use crate::durable_cache::DurableCache;
use crate::seal;
use directories::ProjectDirs;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
#[allow(unused_imports)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

const VAULT_KEY: &str = "handcash.brc100.vault.v1";
const VAULT_PREFIX: &str = "handcash.brc100.vault";
const VAULT_SEAL_STATUS_KEY: &str = "handcash.brc100.vaultSealStatus";
const HASHED_PREFIX: &str = "h-";
const KEY_SIDECAR: &str = ".key";
const TMP_SUFFIX: &str = ".tmp";
const MAX_PLAIN_NAME: usize = 200;

pub struct DurableStore {
    dir: PathBuf,
    cache: Mutex<DurableCache>,
    vault_open_error: Mutex<Option<String>>,
}

impl DurableStore {
    pub fn open_default() -> Result<Arc<Self>, String> {
        let dirs = ProjectDirs::from("io", "handcash", "HandCashDesktopNative")
            .ok_or_else(|| "could not resolve user data dir".to_string())?;
        let dir = dirs.config_dir().join("thin-shell").join("durable");
        Self::open(dir)
    }

    pub fn open(dir: PathBuf) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        Ok(Arc::new(Self {
            dir,
            cache: Mutex::new(DurableCache::default()),
            vault_open_error: Mutex::new(None),
        }))
    }

    pub fn vault_open_error(&self) -> Option<String> {
        self.vault_open_error.lock().ok()?.clone()
    }

    pub fn safe_storage_available(&self) -> bool {
        seal::is_available()
    }

    pub fn get(&self, key: &str) -> Option<String> {
        if key.is_empty() {
            return None;
        }
        if let Ok(cache) = self.cache.lock() {
            if let Some(held) = cache.get(key) {
                return held.clone();
            }
        }
        let raw = self.read_file(key)?;
        match self.open_if_vault(key, &raw) {
            Ok(plain) => {
                if key == VAULT_KEY {
                    if let Ok(mut e) = self.vault_open_error.lock() {
                        *e = None;
                    }
                }
                if let Ok(mut cache) = self.cache.lock() {
                    cache.insert(key.to_string(), Some(plain.clone()));
                }
                Some(plain)
            }
            Err(msg) => {
                if key == VAULT_KEY {
                    if let Ok(mut e) = self.vault_open_error.lock() {
                        *e = Some(msg);
                    }
                }
                if let Ok(mut cache) = self.cache.lock() {
                    cache.insert(key.to_string(), None);
                }
                None
            }
        }
    }

    pub fn set(&self, key: &str, value: &str, allow_vault_identity_replace: bool) -> bool {
        if key.is_empty() {
            return false;
        }
        if value.is_empty() {
            return self.remove(key);
        }
        if key == VAULT_KEY {
            if let Some(previous) = self.get(key) {
                if previous != value && !vault_replace_allowed(&previous, value, allow_vault_identity_replace)
                {
                    return false;
                }
            }
        } else if !key.starts_with(VAULT_PREFIX) {
            if let Ok(cache) = self.cache.lock() {
                if let Some(Some(existing)) = cache.get(key) {
                    if existing == value {
                        return true;
                    }
                }
            }
        }
        let to_store = self.seal_if_vault(key, value);
        let ok = self.put(key, &to_store, Some(value));
        if ok && key == VAULT_KEY {
            if let Ok(mut e) = self.vault_open_error.lock() {
                *e = None;
            }
            let status = if seal::is_sealed(&to_store) {
                "sealed"
            } else {
                "unsealed"
            };
            let _ = self.put(VAULT_SEAL_STATUS_KEY, status, Some(status));
        }
        ok
    }

    pub fn remove(&self, key: &str) -> bool {
        if key.is_empty() {
            return false;
        }
        let url = self.file_path(key);
        let side = self.sidecar_path(key);
        let _ = fs::remove_file(url);
        let _ = fs::remove_file(side);
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(key.to_string(), None);
        }
        true
    }

    pub fn keys(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return vec![];
        };
        let mut out = Vec::new();
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.ends_with(TMP_SUFFIX) || name.ends_with(KEY_SIDECAR) {
                continue;
            }
            if name.starts_with(HASHED_PREFIX) {
                let side = self.dir.join(format!("{name}{KEY_SIDECAR}"));
                if let Ok(k) = fs::read_to_string(side) {
                    out.push(k);
                }
            } else {
                out.push(name);
            }
        }
        out
    }

    pub fn wipe_all(&self) -> usize {
        let keys: Vec<_> = self.keys();
        let mut n = 0;
        for k in keys {
            if self.remove(&k) {
                n += 1;
            }
        }
        n
    }

    fn seal_if_vault(&self, key: &str, value: &str) -> String {
        if !key.starts_with(VAULT_PREFIX) || seal::is_sealed(value) {
            return value.to_string();
        }
        if !seal::is_available() {
            return value.to_string();
        }
        match seal::seal(value) {
            Ok(sealed) => match seal::unseal(&sealed) {
                Ok(plain) if plain == value => sealed,
                _ => value.to_string(),
            },
            Err(_) => value.to_string(),
        }
    }

    fn open_if_vault(&self, key: &str, raw: &str) -> Result<String, String> {
        if seal::is_sealed(raw) {
            let _ = key;
            seal::unseal(raw)
        } else {
            Ok(raw.to_string())
        }
    }

    fn put(&self, key: &str, stored: &str, cache_plain: Option<&str>) -> bool {
        let path = self.file_path(key);
        let tmp = PathBuf::from(format!("{}{TMP_SUFFIX}", path.display()));
        if fs::write(&tmp, stored).is_err() {
            return false;
        }
        #[cfg(unix)]
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        if fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&tmp);
            return false;
        }
        // Vault keys get a full read-back check; non-vault caches already have atomic rename.
        if key.starts_with(VAULT_PREFIX) {
            match fs::read_to_string(&path) {
                Ok(got) if got == stored => {}
                _ => return false,
            }
        }
        if key.len() > MAX_PLAIN_NAME || !is_plain_name(key) {
            let side = self.sidecar_path(key);
            let _ = fs::write(side, key);
        }
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                key.to_string(),
                cache_plain.map(|s| s.to_string()).filter(|s| !s.is_empty()),
            );
        }
        true
    }

    fn read_file(&self, key: &str) -> Option<String> {
        fs::read_to_string(self.file_path(key)).ok()
    }

    fn file_path(&self, key: &str) -> PathBuf {
        if key.len() <= MAX_PLAIN_NAME && is_plain_name(key) {
            self.dir.join(key)
        } else {
            let mut h = Sha256::new();
            h.update(key.as_bytes());
            self.dir
                .join(format!("{HASHED_PREFIX}{}", hex::encode(h.finalize())))
        }
    }

    fn sidecar_path(&self, key: &str) -> PathBuf {
        PathBuf::from(format!("{}{KEY_SIDECAR}", self.file_path(key).display()))
    }
}

fn is_plain_name(key: &str) -> bool {
    !key.is_empty()
        && !key.contains('/')
        && !key.contains('\\')
        && !key.contains("..")
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// Same identity may update (fingerprint, password rewrap); only a new identity needs allow.
fn vault_replace_allowed(previous: &str, next: &str, allow: bool) -> bool {
    let (Some(before), Some(after)) = (identity_key(previous), identity_key(next)) else {
        eprintln!("[DurableStore] vault guard parse failed — refusing write");
        return false;
    };
    if before.is_empty() || after.is_empty() || before == after {
        return true;
    }
    if !allow {
        eprintln!(
            "[DurableStore] blocked vault identity overwrite {} → {}",
            before.chars().take(12).collect::<String>(),
            after.chars().take(12).collect::<String>()
        );
        return false;
    }
    eprintln!("[DurableStore] allowing vault identity replace (recovery)");
    true
}

fn identity_key(json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(json).ok()?;
    match v.get("identityKey") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) | None => Some(String::new()),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Loopback-only sync HTTP for the renderer (sync XHR). Origin and per-launch token must match.
pub fn start_sync_server(
    store: Arc<DurableStore>,
    ui_origin: String,
) -> Result<(String, String, thread::JoinHandle<()>), String> {
    // Pick an ephemeral port, then hand it to tiny_http (keeps API portable).
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    let server =
        tiny_http::Server::http(format!("127.0.0.1:{port}")).map_err(|e| e.to_string())?;
    let base = format!("http://127.0.0.1:{port}");
    let mut token_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token = hex::encode(token_bytes);
    let expected_token = token.clone();
    let origin = ui_origin;
    let handle = thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let req_origin = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Origin"))
                .map(|h| h.value.as_str().to_string());
            let allowed = req_origin.as_deref() == Some(origin.as_str());
            if !allowed {
                let _ = request.respond(
                    tiny_http::Response::from_string("{\"error\":\"origin\"}").with_status_code(403),
                );
                continue;
            }
            // The page's sync XHR is cross-origin (UI origin → loopback port) and
            // carries JSON plus X-HandCash-Token, so WebKit preflights it. A 404
            // here failed every storeGet/storeSet, the renderer's probe fell back
            // to the WebView's ~5MB origin storage, and this store stayed empty.
            if *request.method() == tiny_http::Method::Options {
                let mut response = tiny_http::Response::empty(tiny_http::StatusCode(204));
                for (name, value) in [
                    ("Access-Control-Allow-Origin", origin.as_str()),
                    ("Access-Control-Allow-Methods", "POST"),
                    (
                        "Access-Control-Allow-Headers",
                        "Content-Type, X-HandCash-Origin, X-HandCash-Token",
                    ),
                    ("Access-Control-Max-Age", "600"),
                ] {
                    if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
                        response.add_header(h);
                    }
                }
                let _ = request.respond(response);
                continue;
            }
            if request.url() != "/op" || *request.method() != tiny_http::Method::Post {
                let _ = request.respond(
                    tiny_http::Response::from_string("{\"error\":\"not found\"}").with_status_code(404),
                );
                continue;
            }
            let req_token = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("X-HandCash-Token"))
                .map(|h| h.value.as_str());
            let token_ok = req_token
                .map(|t| constant_time_eq(t.as_bytes(), expected_token.as_bytes()))
                .unwrap_or(false);
            if !token_ok {
                let _ = request.respond(
                    tiny_http::Response::from_string("{\"error\":\"unauthorized\"}")
                        .with_status_code(401),
                );
                continue;
            }
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            let reply = handle_op(&store, &body);
            let mut response = tiny_http::Response::from_string(reply);
            if let Ok(h) = tiny_http::Header::from_bytes(
                &b"Access-Control-Allow-Origin"[..],
                origin.as_bytes(),
            ) {
                response.add_header(h);
            }
            if let Ok(h) =
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
            {
                response.add_header(h);
            }
            let _ = request.respond(response);
        }
    });
    Ok((base, token, handle))
}

fn handle_op(store: &DurableStore, body: &str) -> String {
    let Ok(msg) = serde_json::from_str::<Value>(body) else {
        return json!({"error": "bad json"}).to_string();
    };
    let op = msg.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let key = msg.get("key").and_then(|v| v.as_str()).unwrap_or("");
    match op {
        "get" => json!({"value": store.get(key)}).to_string(),
        "set" => {
            let value = msg.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let allow = msg.get("allow").and_then(|v| v.as_bool()).unwrap_or(false);
            json!({"ok": store.set(key, value, allow)}).to_string()
        }
        "remove" => json!({"ok": store.remove(key)}).to_string(),
        "keys" => json!({"keys": store.keys()}).to_string(),
        _ => json!({"error": "unknown op"}).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn get_set_remove_round_trip() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-durable-{stamp}"));
        let store = DurableStore::open(dir.clone()).expect("open");
        assert!(store.set("plain.key", "value", false));
        assert_eq!(store.get("plain.key").as_deref(), Some("value"));
        assert!(store.remove("plain.key"));
        assert_eq!(store.get("plain.key"), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn uncached_large_values_still_round_trip_update_and_remove() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-durable-large-{stamp}"));
        let store = DurableStore::open(dir.clone()).expect("open");
        assert!(store.set("journal", "old", false));
        let large = "x".repeat(2 * 1024 * 1024);
        assert!(store.set("journal", &large, false));
        assert!(store.cache.lock().unwrap().get("journal").is_none());
        assert_eq!(store.get("journal").as_deref(), Some(large.as_str()));
        assert!(store.cache.lock().unwrap().get("journal").is_none());
        let reopened = DurableStore::open(dir.clone()).expect("reopen");
        assert_eq!(reopened.get("journal").as_deref(), Some(large.as_str()));
        assert!(store.set("journal", "new", false));
        assert_eq!(store.get("journal").as_deref(), Some("new"));
        for i in 0..128 {
            assert!(store.set(&format!("small-{i}"), "value", false));
        }
        assert!(store.cache.lock().unwrap().get("journal").is_none());
        assert_eq!(store.get("journal").as_deref(), Some("new"));
        assert!(store.remove("journal"));
        assert_eq!(store.get("journal"), None);
        let _ = fs::remove_dir_all(dir);
    }

    fn raw_http(base: &str, request: &str) -> String {
        use std::io::Write;
        let addr = base.trim_start_matches("http://");
        let mut stream = std::net::TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = stream.read_to_string(&mut out);
        out
    }

    #[test]
    fn sync_server_answers_the_page_preflight_then_stores() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-durable-cors-{stamp}"));
        let store = DurableStore::open(dir.clone()).expect("open");
        let ui = "http://localhost:5173";
        let (base, token, _thread) =
            start_sync_server(Arc::clone(&store), ui.to_string()).expect("server");

        let preflight = raw_http(
            &base,
            &format!(
                "OPTIONS /op HTTP/1.1\r\nHost: x\r\nOrigin: {ui}\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type,x-handcash-origin,x-handcash-token\r\nConnection: close\r\n\r\n"
            ),
        );
        let head = preflight.to_ascii_lowercase();
        assert!(head.starts_with("http/1.1 204"), "{preflight}");
        assert!(head.contains(&format!("access-control-allow-origin: {ui}")), "{preflight}");
        assert!(head.contains("x-handcash-token"), "{preflight}");

        let body = r#"{"op":"set","key":"plain.key","value":"v"}"#;
        let missing_token = raw_http(
            &base,
            &format!(
                "POST /op HTTP/1.1\r\nHost: x\r\nOrigin: {ui}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        );
        assert!(missing_token.starts_with("HTTP/1.1 401"), "{missing_token}");

        let set = raw_http(
            &base,
            &format!(
                "POST /op HTTP/1.1\r\nHost: x\r\nOrigin: {ui}\r\nX-HandCash-Origin: {ui}\r\nX-HandCash-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        );
        assert!(set.contains(r#"{"ok":true}"#), "{set}");
        assert_eq!(store.get("plain.key").as_deref(), Some("v"));

        let foreign = raw_http(
            &base,
            "OPTIONS /op HTTP/1.1\r\nHost: x\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n",
        );
        assert!(foreign.starts_with("HTTP/1.1 403"), "{foreign}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn same_identity_vault_may_update_without_allow() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-durable-vault-{stamp}"));
        let store = DurableStore::open(dir.clone()).expect("open");
        let a = r#"{"identityKey":"03aaa","ciphertext":"one"}"#;
        let a2 = r#"{"identityKey":"03aaa","ciphertext":"two"}"#;
        let b = r#"{"identityKey":"03bbb","ciphertext":"other"}"#;
        assert!(store.set(VAULT_KEY, a, false), "first vault write");
        assert!(
            store.set(VAULT_KEY, a2, false),
            "same identity may update (fingerprint enroll)"
        );
        assert_eq!(store.get(VAULT_KEY).as_deref(), Some(a2));
        assert!(
            !store.set(VAULT_KEY, b, false),
            "other identity refused without allow"
        );
        assert!(store.set(VAULT_KEY, b, true), "recovery may replace identity");
        assert_eq!(store.get(VAULT_KEY).as_deref(), Some(b));
        let _ = fs::remove_dir_all(dir);
    }
}
