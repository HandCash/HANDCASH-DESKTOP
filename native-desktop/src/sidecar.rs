//! Spawns `bridgeSidecar.js` and speaks the same stdio JSON protocol as Mac Swift.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

pub struct BridgeSidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    status: Mutex<SidecarStatus>,
}

#[derive(Clone, Debug, Default)]
pub struct SidecarStatus {
    pub online: bool,
    pub http_url: String,
    pub https_url: String,
    pub device_peer_lan_urls: Vec<String>,
    pub device_peer_online: bool,
    pub last_error: Option<String>,
}

impl BridgeSidecar {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            status: Mutex::new(SidecarStatus::default()),
        })
    }

    pub fn status_snapshot(&self) -> Value {
        let s = self.status.lock().unwrap();
        json!({
            "online": s.online,
            "httpUrl": s.http_url,
            "httpsUrl": s.https_url,
            "devicePeerPort": 3340,
            "devicePeerLanUrls": s.device_peer_lan_urls,
            "devicePeerOnline": s.device_peer_online,
            "lastError": s.last_error,
        })
    }

    pub fn start_if_needed<F>(self: &Arc<Self>, on_line: F)
    where
        F: Fn(Value) + Send + 'static,
    {
        {
            let child = self.child.lock().unwrap();
            if child.is_some() {
                return;
            }
        }
        let node = resolve_node();
        let script = resolve_sidecar_script();
        let (Some(node), Some(script)) = (node, script) else {
            let mut s = self.status.lock().unwrap();
            s.online = false;
            s.last_error = Some("bridge sidecar or node not found".into());
            return;
        };

        let mut cmd = Command::new(&node);
        cmd.arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Ok(data) = std::env::var("HANDCASH_USER_DATA") {
            cmd.env("HANDCASH_USER_DATA", data);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let mut s = self.status.lock().unwrap();
                s.online = false;
                s.last_error = Some(format!("spawn sidecar: {e}"));
                return;
            }
        };

        let stdout = child.stdout.take().expect("stdout");
        let stdin = child.stdin.take().expect("stdin");
        *self.stdin.lock().unwrap() = Some(stdin);
        *self.child.lock().unwrap() = Some(child);

        let this = Arc::clone(self);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(obj) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                this.handle_out(&obj);
                on_line(obj);
            }
            let mut s = this.status.lock().unwrap();
            s.online = false;
            if s.last_error.is_none() {
                s.last_error = Some("sidecar exited".into());
            }
        });
    }

    fn handle_out(&self, obj: &Value) {
        let ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let mut s = self.status.lock().unwrap();
        match ty {
            "ready" => {
                s.http_url = obj
                    .get("httpUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                s.https_url = obj
                    .get("httpsUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                s.device_peer_lan_urls = obj
                    .get("devicePeerLanUrls")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                s.device_peer_online = obj
                    .get("devicePeerOnline")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                s.online = true;
                s.last_error = None;
            }
            "fatal" => {
                s.online = false;
                s.last_error = obj
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(|m| m.to_string());
            }
            "log" => {
                let level = obj.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                let message = obj.get("message").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("[bridge-sidecar {level}] {message}");
            }
            _ => {}
        }
    }

    pub fn write_line(&self, obj: Value) {
        if let Some(stdin) = self.stdin.lock().unwrap().as_mut() {
            let mut line = obj.to_string();
            line.push('\n');
            let _ = stdin.write_all(line.as_bytes());
            let _ = stdin.flush();
        }
    }

    pub fn notify_renderer_ready(&self) {
        self.write_line(json!({"v": 1, "type": "renderer-ready"}));
    }

    pub fn send_from_renderer(&self, channel: &str, payload: Value) {
        self.write_line(json!({
            "v": 1,
            "type": "from-renderer",
            "channel": channel,
            "payload": payload,
        }));
    }

    pub fn stop(&self) {
        self.write_line(json!({"v": 1, "type": "shutdown"}));
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.wait();
        }
        *self.stdin.lock().unwrap() = None;
        let mut s = self.status.lock().unwrap();
        s.online = false;
    }
}

fn resolve_node() -> Option<String> {
    if let Ok(env) = std::env::var("HANDCASH_NODE") {
        if PathBuf::from(&env).exists() {
            return Some(env);
        }
    }
    if let Some(dir) = current_exe_dir() {
        #[cfg(windows)]
        {
            let bundled = dir.join("node.exe");
            if bundled.is_file() {
                return Some(bundled.to_string_lossy().into_owned());
            }
        }
        let bundled = dir.join("node");
        if bundled.is_file() {
            return Some(bundled.to_string_lossy().into_owned());
        }
    }
    which("node")
}

fn resolve_sidecar_script() -> Option<String> {
    if let Ok(env) = std::env::var("HANDCASH_BRIDGE_SIDECAR") {
        if PathBuf::from(&env).exists() {
            return Some(env);
        }
    }
    if let Some(dir) = current_exe_dir() {
        for name in ["bridgeSidecar.cjs", "bridgeSidecar.js"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        let nested = dir.join("resources").join("bridgeSidecar.cjs");
        if nested.is_file() {
            return Some(nested.to_string_lossy().into_owned());
        }
    }
    None
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            let with_exe = dir.join(format!("{bin}.exe"));
            if with_exe.is_file() {
                return Some(with_exe.to_string_lossy().into_owned());
            }
        }
    }
    None
}
