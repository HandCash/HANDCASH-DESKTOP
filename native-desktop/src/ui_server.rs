//! Built-in packaged UI static HTTP server (`http://localhost:5173`).
//!
//! Direct Rust replacement for `electron/packagedUiServer.ts` and `electron/uiSidecar.ts`:
//! - Serves `app/` (Vite `dist/`) on `127.0.0.1:5173` and best-effort `[::1]:5173`
//!   so IndexedDB and remittance history stay on the `http://localhost:5173` origin.
//! - Refuses to start if another process already owns `:5173` (never kills an existing owner).
//! - Path-traversal guard + SPA fallback to `index.html`.

use crate::host_log::HostLog;
use crate::http_wire::{read_http_request, write_http_response};
use std::fs;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub const UI_PORT: u16 = 5173;
pub const UI_ORIGIN: &str = "http://localhost:5173";

pub struct PackagedUiServer {
    running: Arc<AtomicBool>,
    addrs: Vec<SocketAddr>,
    threads: Vec<thread::JoinHandle<()>>,
}

impl PackagedUiServer {
    /// Locate the packaged UI root (`HANDCASH_UI_ROOT` or `<exe_dir>/app`) if present.
    pub fn discover_dist_root() -> Option<PathBuf> {
        if let Ok(raw) = std::env::var("HANDCASH_UI_ROOT") {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                let p = PathBuf::from(trimmed);
                if p.join("index.html").is_file() {
                    return Some(p);
                }
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let beside = dir.join("app");
                if beside.join("index.html").is_file() {
                    return Some(beside);
                }
            }
        }
        None
    }

    pub fn start(dist_root: PathBuf, log: Arc<HostLog>) -> Result<Self, String> {
        Self::start_on_port(dist_root, UI_PORT, true, log)
    }

    pub fn start_on_port(
        dist_root: PathBuf,
        port: u16,
        try_ipv6: bool,
        log: Arc<HostLog>,
    ) -> Result<Self, String> {
        let root = fs::canonicalize(&dist_root)
            .map_err(|_| format!("packaged UI missing index.html under {}", dist_root.display()))?;
        if !root.join("index.html").is_file() {
            return Err(format!("packaged UI missing index.html under {}", root.display()));
        }

        let v4 = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!(
                    "Refusing to load the wallet: another process owns trusted UI port {port}."
                )
            } else {
                format!("bind 127.0.0.1:{port}: {e}")
            }
        })?;
        let bound_port = v4.local_addr().map(|a| a.port()).unwrap_or(port);

        let mut listeners = vec![v4];
        if try_ipv6 {
            match TcpListener::bind(("::1", bound_port)) {
                Ok(v6) => listeners.push(v6),
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        return Err(format!(
                            "Refusing to load the wallet: another process owns trusted UI port {bound_port}."
                        ));
                    }
                    log.append(
                        "warn",
                        "ui-server",
                        &format!("IPv6 loopback unavailable ({e}); bound IPv4 only"),
                    );
                }
            }
        }

        let running = Arc::new(AtomicBool::new(true));
        let mut addrs = Vec::with_capacity(listeners.len());
        let mut threads = Vec::with_capacity(listeners.len());

        for listener in listeners {
            if let Ok(addr) = listener.local_addr() {
                addrs.push(addr);
            }
            let _ = listener.set_nonblocking(true);
            let run_flag = Arc::clone(&running);
            let root_dir = root.clone();
            let handle = thread::spawn(move || {
                while run_flag.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let dir = root_dir.clone();
                            thread::spawn(move || handle_ui_connection(stream, &dir));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(15));
                        }
                        Err(_) => {
                            if !run_flag.load(Ordering::Relaxed) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(25));
                        }
                    }
                }
            });
            threads.push(handle);
        }

        log.append(
            "info",
            "ui-server",
            &format!(
                "Packaged UI on http://localhost:{bound_port} ({} loopback listener{})",
                addrs.len(),
                if addrs.len() == 1 { "" } else { "s" }
            ),
        );

        Ok(Self {
            running,
            addrs,
            threads,
        })
    }

    #[cfg(test)]
    pub fn addrs(&self) -> &[SocketAddr] {
        &self.addrs
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        for addr in &self.addrs {
            let _ = TcpStream::connect_timeout(addr, Duration::from_millis(100));
        }
        for handle in self.threads.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for PackagedUiServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn handle_ui_connection(mut stream: TcpStream, root: &Path) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

    let Ok(req) = read_http_request(&mut stream, 64 * 1024) else {
        return;
    };
    if req.method != "GET" && req.method != "HEAD" {
        let _ = write_http_response(
            &mut stream,
            405,
            "text/plain; charset=utf-8",
            &[("Allow", "GET, HEAD")],
            b"Method Not Allowed",
        );
        return;
    }

    let decoded = percent_decode(&req.path);
    let target = resolve_asset_path(root, &decoded).unwrap_or_else(|| root.join("index.html"));
    match fs::read(&target) {
        Ok(bytes) => {
            let mime = mime_for_path(&target);
            let cache = if target.ends_with("index.html") {
                "no-cache"
            } else {
                "public, max-age=3600"
            };
            let body: &[u8] = if req.method == "HEAD" { &[] } else { &bytes };
            let _ = write_http_response(&mut stream, 200, mime, &[("Cache-Control", cache)], body);
        }
        Err(_) => {
            let _ = write_http_response(&mut stream, 404, "text/plain; charset=utf-8", &[], b"Not Found");
        }
    }
}

fn resolve_asset_path(root: &Path, req_path: &str) -> Option<PathBuf> {
    let trimmed = req_path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some(root.join("index.html"));
    }
    let mut candidate = root.to_path_buf();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(seg) => candidate.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if !candidate.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(&candidate).ok()?;
    if canonical.starts_with(root) {
        Some(canonical)
    } else {
        None
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") | Some("cjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn http_get(addr: SocketAddr, path: &str) -> String {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes())
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn serves_static_assets_spa_fallback_and_blocks_traversal() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-ui-srv-{stamp}"));
        let dist = dir.join("app");
        fs::create_dir_all(dist.join("assets")).unwrap();
        fs::write(dist.join("index.html"), "<html>wallet</html>").unwrap();
        fs::write(dist.join("assets/app.js"), "console.log('ok')").unwrap();
        fs::write(dir.join("secret.txt"), "top-secret").unwrap();

        let log = HostLog::open(dir.join("logs"));
        let mut server = PackagedUiServer::start_on_port(dist, 0, false, log).unwrap();
        let addr = server.addrs()[0];

        let root_res = http_get(addr, "/");
        assert!(root_res.contains("200 OK"));
        assert!(root_res.contains("text/html"));
        assert!(root_res.contains("<html>wallet</html>"));

        let js_res = http_get(addr, "/assets/app.js");
        assert!(js_res.contains("application/javascript"));
        assert!(js_res.contains("console.log('ok')"));

        // SPA fallback on unknown route.
        let spa_res = http_get(addr, "/wallet/settings");
        assert!(spa_res.contains("<html>wallet</html>"));

        // Traversal falls back to index.html, never serves ../secret.txt.
        let trav_res = http_get(addr, "/%2e%2e/secret.txt");
        assert!(!trav_res.contains("top-secret"));
        assert!(trav_res.contains("<html>wallet</html>"));

        server.stop();
        let _ = fs::remove_dir_all(dir);
    }
}
