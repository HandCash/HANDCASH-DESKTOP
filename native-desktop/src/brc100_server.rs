//! Pure-Rust BRC-100 HTTP/HTTPS bridge (`127.0.0.1:3321`, `127.0.0.1:2121`, plus
//! best-effort `[::1]`) and LAN device-peer server (`0.0.0.0:3340`).
//!
//! Direct in-process replacement for `electron/bridgeSidecar.ts`, `electron/httpServer.ts`,
//! and `electron/devicePeerServer.ts` — no Node runtime or sidecar process required.

use crate::bridge_protocol::{
    bridge_cors_headers, bridge_deadline_message, bridge_deadline_ms, bridge_error_reply,
    device_peer_cors_headers, device_peer_origin_allowed, health_json, is_spend_method_path,
    manifest_json, summarize_error_body, with_wallet_failure, BridgeReply,
};
use crate::host_log::HostLog;
use crate::http_wire::{read_http_request, write_http_response, HttpRequest, ParseError};
use crate::spend_ledger::{spend_request_key, SpendBegin, SpendLedger};
use crate::tls_cert;
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const BRC100_HTTP_PORT: u16 = 3321;
pub const BRC100_HTTPS_PORT: u16 = 2121;
pub const DEVICE_PEER_PORT: u16 = 3340;

const MAX_BRC100_BODY_BYTES: usize = 50 * 1024 * 1024;
const MAX_DEVICE_PEER_BODY_BYTES: usize = 2 * 1024 * 1024;
const RENDERER_READY_WAIT: Duration = Duration::from_secs(8);
const DEVICE_PEER_TIMEOUT: Duration = Duration::from_secs(30);
const DEVICE_PEER_SCAN_LOGIN_TIMEOUT: Duration = Duration::from_secs(100);

type PushFn = Arc<dyn Fn(&str, Value) + Send + Sync>;
type DirectHandlerFn = Arc<dyn Fn(&str, &str, &HashMap<String, String>, &str) -> BridgeReply + Send + Sync>;

#[derive(Clone, Debug, Default)]
struct BridgeStatusState {
    online: bool,
    http_url: String,
    https_url: String,
    device_peer_port: u16,
    device_peer_lan_urls: Vec<String>,
    device_peer_online: bool,
    error: Option<String>,
}

struct PendingBrc100 {
    tx: mpsc::Sender<Result<BridgeReply, String>>,
    method: String,
    path: String,
}

struct RunningServers {
    running: Arc<AtomicBool>,
    addrs: Vec<SocketAddr>,
    threads: Vec<thread::JoinHandle<()>>,
}

pub struct Brc100Bridge {
    user_data_dir: PathBuf,
    log: Arc<HostLog>,
    push: Mutex<Option<PushFn>>,
    direct_handler: Mutex<Option<DirectHandlerFn>>,
    status: Mutex<BridgeStatusState>,
    servers: Mutex<Option<RunningServers>>,
    renderer_ready: Mutex<bool>,
    renderer_ready_cv: Condvar,
    prompt_open: AtomicBool,
    next_brc100_id: AtomicU64,
    next_peer_id: AtomicU64,
    pending_brc100: Mutex<HashMap<u64, PendingBrc100>>,
    pending_peer: Mutex<HashMap<u64, mpsc::Sender<Result<BridgeReply, String>>>>,
    spend_ledger: SpendLedger,
}

impl Brc100Bridge {
    pub fn new(user_data_dir: PathBuf, log: Arc<HostLog>) -> Arc<Self> {
        Arc::new(Self {
            user_data_dir,
            log,
            push: Mutex::new(None),
            direct_handler: Mutex::new(None),
            status: Mutex::new(BridgeStatusState {
                device_peer_port: DEVICE_PEER_PORT,
                ..Default::default()
            }),
            servers: Mutex::new(None),
            renderer_ready: Mutex::new(false),
            renderer_ready_cv: Condvar::new(),
            prompt_open: AtomicBool::new(false),
            next_brc100_id: AtomicU64::new(1),
            next_peer_id: AtomicU64::new(1),
            pending_brc100: Mutex::new(HashMap::new()),
            pending_peer: Mutex::new(HashMap::new()),
            spend_ledger: SpendLedger::default(),
        })
    }

    pub fn set_push_handler<F>(&self, f: F)
    where
        F: Fn(&str, Value) + Send + Sync + 'static,
    {
        *self.push.lock().unwrap() = Some(Arc::new(f));
    }

    /// Install an in-process Rust BRC-100 request handler (used by the pure-Rust
    /// `handcash-native` desktop app so requests never round-trip through a WebView).
    pub fn set_direct_handler<F>(&self, f: F)
    where
        F: Fn(&str, &str, &HashMap<String, String>, &str) -> BridgeReply + Send + Sync + 'static,
    {
        *self.direct_handler.lock().unwrap() = Some(Arc::new(f));
    }

    fn emit(&self, channel: &str, payload: Value) {
        if let Some(cb) = self.push.lock().unwrap().clone() {
            cb(channel, payload);
        }
    }

    pub fn status_snapshot(&self) -> Value {
        let s = self.status.lock().unwrap();
        json!({
            "online": s.online,
            "httpUrl": s.http_url,
            "httpsUrl": s.https_url,
            "devicePeerPort": s.device_peer_port,
            "devicePeerLanUrls": s.device_peer_lan_urls,
            "devicePeerOnline": s.device_peer_online,
            "error": s.error,
        })
    }

    pub fn mark_renderer_ready(&self) {
        let mut ready = self.renderer_ready.lock().unwrap();
        let was_ready = *ready;
        *ready = true;
        self.renderer_ready_cv.notify_all();
        drop(ready);
        if !was_ready {
            self.emit("bridge-status", self.status_snapshot());
        }
    }

    pub fn set_prompt_open(&self, open: bool) {
        self.prompt_open.store(open, Ordering::Relaxed);
    }

    pub fn deliver_http_response(&self, payload: &Value) {
        let Some(request_id) = payload.get("request_id").and_then(|v| v.as_u64()) else {
            return;
        };
        let status = payload
            .get("status")
            .and_then(|v| v.as_u64())
            .and_then(|s| u16::try_from(s).ok())
            .unwrap_or(200);
        let body = match payload.get("body") {
            Some(Value::String(s)) => s.clone(),
            Some(other) if !other.is_null() => other.to_string(),
            _ => String::new(),
        };
        let reply = BridgeReply { status, body };
        self.spend_ledger.settle(request_id, reply.clone());
        let pending = self.pending_brc100.lock().unwrap().remove(&request_id);
        match pending {
            Some(entry) => {
                let _ = entry.tx.send(Ok(reply));
            }
            None => {
                self.log.append(
                    "warn",
                    "brc100",
                    &format!(
                        "[HTTP] late renderer reply request_id={request_id} status={status} — HTTP call already answered"
                    ),
                );
            }
        }
    }

    pub fn deliver_device_peer_response(&self, payload: &Value) {
        let Some(request_id) = payload.get("request_id").and_then(|v| v.as_u64()) else {
            return;
        };
        let status = payload
            .get("status")
            .and_then(|v| v.as_u64())
            .and_then(|s| u16::try_from(s).ok())
            .unwrap_or(200);
        let body = match payload.get("body") {
            Some(Value::String(s)) => s.clone(),
            Some(other) if !other.is_null() => other.to_string(),
            _ => String::new(),
        };
        if let Some(tx) = self.pending_peer.lock().unwrap().remove(&request_id) {
            let _ = tx.send(Ok(BridgeReply { status, body }));
        }
    }

    pub fn start_if_needed(self: &Arc<Self>) {
        self.start_with_ports(BRC100_HTTP_PORT, BRC100_HTTPS_PORT, DEVICE_PEER_PORT, true);
    }

    pub fn start_with_ports(
        self: &Arc<Self>,
        http_port: u16,
        https_port: u16,
        peer_port: u16,
        bind_ipv6: bool,
    ) {
        {
            if self.servers.lock().unwrap().is_some() {
                return;
            }
        }

        let tls_config = match tls_cert::load_or_create_cert(&self.user_data_dir)
            .and_then(|m| tls_cert::build_server_config(&m.cert_der, &m.key_der))
        {
            Ok(cfg) => cfg,
            Err(e) => {
                let msg = format!("TLS certificate error: {e}");
                self.log.append("error", "brc100", &msg);
                let mut s = self.status.lock().unwrap();
                s.online = false;
                s.error = Some(msg);
                drop(s);
                self.emit("bridge-status", self.status_snapshot());
                return;
            }
        };

        let https_v4 = match TcpListener::bind(("127.0.0.1", https_port)) {
            Ok(l) => l,
            Err(e) => {
                let msg = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("BRC-100 port {https_port} is already in use")
                } else {
                    format!("BRC-100 HTTPS bind failed: {e}")
                };
                self.log.append("error", "brc100", &msg);
                let mut s = self.status.lock().unwrap();
                s.online = false;
                s.error = Some(msg);
                drop(s);
                self.emit("bridge-status", self.status_snapshot());
                return;
            }
        };
        let actual_https_port = https_v4.local_addr().map(|a| a.port()).unwrap_or(https_port);

        let http_v4 = match TcpListener::bind(("127.0.0.1", http_port)) {
            Ok(l) => l,
            Err(e) => {
                let msg = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("BRC-100 port {http_port} is already in use")
                } else {
                    format!("BRC-100 HTTP bind failed: {e}")
                };
                self.log.append("error", "brc100", &msg);
                let mut s = self.status.lock().unwrap();
                s.online = false;
                s.error = Some(msg);
                drop(s);
                self.emit("bridge-status", self.status_snapshot());
                return;
            }
        };
        let actual_http_port = http_v4.local_addr().map(|a| a.port()).unwrap_or(http_port);

        let running = Arc::new(AtomicBool::new(true));
        let mut addrs = Vec::new();
        let mut threads = Vec::new();

        // Spawn IPv4 HTTPS + HTTP listeners.
        self.spawn_brc100_listener(https_v4, Some(Arc::clone(&tls_config)), &running, &mut addrs, &mut threads);
        self.spawn_brc100_listener(http_v4, None, &running, &mut addrs, &mut threads);

        self.log.append(
            "info",
            "brc100",
            &format!("BRC-100 HTTPS on https://127.0.0.1:{actual_https_port}"),
        );
        self.log.append(
            "info",
            "brc100",
            &format!("BRC-100 HTTP on http://127.0.0.1:{actual_http_port}"),
        );

        // Best-effort IPv6 loopback listeners (::1) for SDKs resolving `localhost` → ::1.
        if bind_ipv6 {
            for (port, tls) in [
                (actual_https_port, Some(Arc::clone(&tls_config))),
                (actual_http_port, None),
            ] {
                match TcpListener::bind(("::1", port)) {
                    Ok(l) => {
                        self.spawn_brc100_listener(l, tls, &running, &mut addrs, &mut threads);
                        self.log
                            .append("info", "brc100", &format!("BRC-100 also on [::1]:{port}"));
                    }
                    Err(e) => {
                        self.log.append(
                            "warn",
                            "brc100",
                            &format!("BRC-100 [::1]:{port} unavailable ({e})"),
                        );
                    }
                }
            }
        }

        // LAN device-peer listener on 0.0.0.0:3340 (best-effort; never blocks BRC-100).
        let (peer_online, actual_peer_port, lan_urls) = match TcpListener::bind(("0.0.0.0", peer_port)) {
            Ok(listener) => {
                let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(peer_port);
                let urls: Vec<String> = list_lan_ipv4_addresses()
                    .into_iter()
                    .map(|ip| format!("http://{ip}:{bound_port}"))
                    .collect();
                self.spawn_device_peer_listener(listener, &running, &mut addrs, &mut threads);
                self.log.append(
                    "info",
                    "device-peer",
                    &format!("listening on 0.0.0.0:{bound_port} ({} LAN addr)", urls.len()),
                );
                (true, bound_port, urls)
            }
            Err(e) => {
                self.log
                    .append("warn", "device-peer", &format!("Device peer server failed: {e}"));
                (false, peer_port, vec![])
            }
        };

        *self.servers.lock().unwrap() = Some(RunningServers {
            running,
            addrs,
            threads,
        });

        {
            let mut s = self.status.lock().unwrap();
            s.online = true;
            s.http_url = format!("http://127.0.0.1:{actual_http_port}");
            s.https_url = format!("https://127.0.0.1:{actual_https_port}");
            s.device_peer_port = actual_peer_port;
            s.device_peer_lan_urls = lan_urls;
            s.device_peer_online = peer_online;
            s.error = None;
        }
        self.emit("bridge-status", self.status_snapshot());
    }

    pub fn stop(&self) {
        self.prompt_open.store(false, Ordering::Relaxed);
        self.fail_all_pending("WALLET_BRIDGE_UNAVAILABLE: HTTP server shutting down");
        if let Some(srv) = self.servers.lock().unwrap().take() {
            srv.running.store(false, Ordering::Relaxed);
            for addr in &srv.addrs {
                let wake = match addr.ip() {
                    IpAddr::V4(v4) if v4.is_unspecified() => {
                        SocketAddr::from(([127, 0, 0, 1], addr.port()))
                    }
                    _ => *addr,
                };
                let _ = TcpStream::connect_timeout(&wake, Duration::from_millis(100));
            }
            for handle in srv.threads {
                let _ = handle.join();
            }
        }
        {
            let mut s = self.status.lock().unwrap();
            s.online = false;
            s.device_peer_online = false;
            s.device_peer_lan_urls.clear();
        }
        self.emit("bridge-status", self.status_snapshot());
    }

    fn fail_all_pending(&self, reason: &str) {
        self.spend_ledger.lose_all(bridge_error_reply(
            &format!(
                "WALLET_BRIDGE_PENDING: the wallet stopped ({reason}) while a spend was in it — it may have completed; reconcile before retrying"
            ),
            "",
        ));
        let mut brc = self.pending_brc100.lock().unwrap();
        for (_, entry) in brc.drain() {
            let msg = if is_spend_method_path(&entry.path) {
                format!(
                    "WALLET_BRIDGE_PENDING: {} {} was in the wallet when it stopped ({reason}) — it may have completed; reconcile before retrying",
                    entry.method, entry.path
                )
            } else {
                reason.to_string()
            };
            let _ = entry.tx.send(Err(msg));
        }
        let mut peer = self.pending_peer.lock().unwrap();
        for (_, tx) in peer.drain() {
            let _ = tx.send(Err("DEVICE_PEER_SHUTDOWN".into()));
        }
    }

    fn wait_renderer_ready(&self) -> Result<(), String> {
        let mut ready = self.renderer_ready.lock().unwrap();
        if *ready {
            return Ok(());
        }
        let deadline = Instant::now() + RENDERER_READY_WAIT;
        while !*ready {
            let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
                return Err(
                    "WALLET_BRIDGE_UNAVAILABLE: wallet window is still loading (renderer-not-ready)"
                        .into(),
                );
            };
            let (guard, timeout_res) = self.renderer_ready_cv.wait_timeout(ready, rem).unwrap();
            ready = guard;
            if timeout_res.timed_out() && !*ready {
                return Err(
                    "WALLET_BRIDGE_UNAVAILABLE: wallet window is still loading (renderer-not-ready)"
                        .into(),
                );
            }
        }
        Ok(())
    }

    fn spawn_brc100_listener(
        self: &Arc<Self>,
        listener: TcpListener,
        tls: Option<Arc<ServerConfig>>,
        running: &Arc<AtomicBool>,
        addrs: &mut Vec<SocketAddr>,
        threads: &mut Vec<thread::JoinHandle<()>>,
    ) {
        if let Ok(addr) = listener.local_addr() {
            addrs.push(addr);
        }
        let _ = listener.set_nonblocking(true);
        let run_flag = Arc::clone(running);
        let this = Arc::clone(self);
        let handle = thread::spawn(move || {
            while run_flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let bridge = Arc::clone(&this);
                        let tls_cfg = tls.clone();
                        thread::spawn(move || {
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                            if let Some(cfg) = tls_cfg {
                                let Ok(conn) = ServerConnection::new(cfg) else {
                                    return;
                                };
                                let mut tls_stream = StreamOwned::new(conn, stream);
                                bridge.handle_brc100_stream(&mut tls_stream);
                            } else {
                                let mut plain = stream;
                                bridge.handle_brc100_stream(&mut plain);
                            }
                        });
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

    fn spawn_device_peer_listener(
        self: &Arc<Self>,
        listener: TcpListener,
        running: &Arc<AtomicBool>,
        addrs: &mut Vec<SocketAddr>,
        threads: &mut Vec<thread::JoinHandle<()>>,
    ) {
        if let Ok(addr) = listener.local_addr() {
            addrs.push(addr);
        }
        let _ = listener.set_nonblocking(true);
        let run_flag = Arc::clone(running);
        let this = Arc::clone(self);
        let handle = thread::spawn(move || {
            while run_flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let bridge = Arc::clone(&this);
                        thread::spawn(move || {
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                            bridge.handle_device_peer_stream(&mut stream);
                        });
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

    fn handle_brc100_stream<S: Read + Write>(&self, stream: &mut S) {
        let cors = bridge_cors_headers();
        let req = match read_http_request(&mut *stream, MAX_BRC100_BODY_BYTES) {
            Ok(r) => r,
            Err(ParseError::Eof) => return,
            Err(ParseError::BodyTooLarge) => {
                let body = with_wallet_failure(
                    413,
                    r#"{"status":"error","code":"BODY_TOO_LARGE","description":"Request body too large"}"#,
                    "",
                );
                let _ = write_http_response(stream, 413, "application/json", &cors, body.as_bytes());
                return;
            }
            Err(ParseError::BadRequest(msg)) => {
                let body = with_wallet_failure(
                    400,
                    &json!({ "status": "error", "code": "BAD_REQUEST", "description": msg }).to_string(),
                    "",
                );
                let _ = write_http_response(stream, 400, "application/json", &cors, body.as_bytes());
                return;
            }
        };

        self.log
            .append("info", "brc100", &format!("[HTTP] {} {}", req.method, req.path));

        if req.method == "OPTIONS" {
            let _ = write_http_response(stream, 200, "text/plain; charset=utf-8", &cors, b"OK");
            return;
        }
        if req.method == "GET" && req.path == "/manifest.json" {
            let body = manifest_json();
            let _ = write_http_response(stream, 200, "application/json", &cors, body.as_bytes());
            return;
        }
        if req.method == "GET" && req.path == "/health" {
            let body = health_json();
            let _ = write_http_response(stream, 200, "application/json", &cors, body.as_bytes());
            return;
        }

        let reply = self.dispatch_brc100_request(&req);
        let final_body = with_wallet_failure(reply.status, &reply.body, &req.path);
        let _ = write_http_response(
            stream,
            reply.status,
            "application/json",
            &cors,
            final_body.as_bytes(),
        );
    }

    fn dispatch_brc100_request(&self, req: &HttpRequest) -> BridgeReply {
        let request_id = self.next_brc100_id.fetch_add(1, Ordering::Relaxed);
        let body_str = String::from_utf8_lossy(&req.body).into_owned();
        let is_spend_post = req.method == "POST" && is_spend_method_path(&req.path);

        if is_spend_post {
            let origin = req
                .headers
                .get("origin")
                .or_else(|| req.headers.get("originator"))
                .map(String::as_str);
            let key = spend_request_key(origin, &req.path, &body_str);
            match self.spend_ledger.begin(key, request_id) {
                SpendBegin::Replay(reply) => {
                    self.log.append(
                        "warn",
                        "brc100",
                        &format!(
                            "[HTTP] request_id={request_id} {} {} repeats a spend that already ran — answering with that run, not paying again",
                            req.method, req.path
                        ),
                    );
                    return reply;
                }
                SpendBegin::Join { waiter_id, key, rx } => {
                    self.log.append(
                        "warn",
                        "brc100",
                        &format!(
                            "[HTTP] request_id={request_id} {} {} repeats a spend still in the wallet — waiting on that run, not paying again",
                            req.method, req.path
                        ),
                    );
                    let deadline = Duration::from_millis(bridge_deadline_ms(&req.path));
                    return match rx.recv_timeout(deadline) {
                        Ok(reply) => reply,
                        Err(_) => {
                            self.spend_ledger.leave_waiter(&key, waiter_id);
                            let msg = bridge_deadline_message(&req.method, &req.path);
                            self.log
                                .append("warn", "brc100", &format!("[HTTP] bridge error: {msg}"));
                            bridge_error_reply(&msg, &req.path)
                        }
                    };
                }
                SpendBegin::Dispatch => {}
            }
        }

        if let Some(handler) = self.direct_handler.lock().unwrap().clone() {
            let reply = handler(&req.method, &req.path, &req.headers, &body_str);
            self.spend_ledger.settle(request_id, reply.clone());
            self.spend_ledger.done(request_id);
            if reply.status >= 400 {
                self.log.append(
                    "warn",
                    "brc100",
                    &format!(
                        "[HTTP] ← native request_id={request_id} {} {} error: {}",
                        req.method,
                        req.path,
                        summarize_error_body(&reply.body)
                    ),
                );
            }
            return reply;
        }

        if let Err(msg) = self.wait_renderer_ready() {
            self.spend_ledger.done(request_id);
            self.log
                .append("warn", "brc100", &format!("[HTTP] bridge error: {msg}"));
            return bridge_error_reply(&msg, &req.path);
        }

        let (tx, rx) = mpsc::channel();
        self.pending_brc100.lock().unwrap().insert(
            request_id,
            PendingBrc100 {
                tx,
                method: req.method.clone(),
                path: req.path.clone(),
            },
        );

        self.log.append(
            "info",
            "brc100",
            &format!(
                "[HTTP] → renderer request_id={request_id} {} {}",
                req.method, req.path
            ),
        );

        let headers_val: serde_json::Map<String, Value> = req
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        self.emit(
            "http-request",
            json!({
                "method": req.method,
                "path": req.path,
                "headers": Value::Object(headers_val),
                "body": body_str,
                "request_id": request_id,
            }),
        );

        let deadline = Duration::from_millis(bridge_deadline_ms(&req.path));
        let mut held_for_prompt = false;
        let outcome = loop {
            match rx.recv_timeout(deadline) {
                Ok(res) => break res,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self.prompt_open.load(Ordering::Relaxed) {
                        if !held_for_prompt {
                            held_for_prompt = true;
                            self.log.append(
                                "info",
                                "brc100",
                                &format!(
                                    "[HTTP] request_id={request_id} {} deadline held — a permission prompt is open",
                                    req.path
                                ),
                            );
                        }
                        continue;
                    }
                    self.pending_brc100.lock().unwrap().remove(&request_id);
                    self.spend_ledger.orphan(request_id);
                    self.emit(
                        "http-request-cancelled",
                        json!({ "request_id": request_id, "reason": "WALLET_BRIDGE_TIMEOUT" }),
                    );
                    break Err(bridge_deadline_message(&req.method, &req.path));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.pending_brc100.lock().unwrap().remove(&request_id);
                    self.spend_ledger.orphan(request_id);
                    break Err("WALLET_BRIDGE_UNAVAILABLE: bridge channel closed".into());
                }
            }
        };

        match outcome {
            Ok(reply) => {
                self.log.append(
                    "info",
                    "brc100",
                    &format!("[HTTP] ← renderer request_id={request_id} status={}", reply.status),
                );
                if reply.status >= 400 {
                    self.log.append(
                        "warn",
                        "brc100",
                        &format!(
                            "[HTTP] ← renderer request_id={request_id} {} {} error: {}",
                            req.method,
                            req.path,
                            summarize_error_body(&reply.body)
                        ),
                    );
                }
                self.spend_ledger.done(request_id);
                reply
            }
            Err(msg) => {
                self.log
                    .append("warn", "brc100", &format!("[HTTP] bridge error: {msg}"));
                bridge_error_reply(&msg, &req.path)
            }
        }
    }

    fn handle_device_peer_stream(&self, stream: &mut TcpStream) {
        let req = match read_http_request(&mut *stream, MAX_DEVICE_PEER_BODY_BYTES) {
            Ok(r) => r,
            Err(ParseError::Eof) => return,
            Err(ParseError::BodyTooLarge) => {
                let _ = write_http_response(
                    stream,
                    413,
                    "application/json",
                    &[],
                    br#"{"status":"error","code":"BODY_TOO_LARGE","description":"Request body too large"}"#,
                );
                return;
            }
            Err(ParseError::BadRequest(msg)) => {
                let body = json!({ "status": "error", "code": "BAD_REQUEST", "description": msg })
                    .to_string();
                let _ = write_http_response(stream, 400, "application/json", &[], body.as_bytes());
                return;
            }
        };

        let origin = req.headers.get("origin").map(String::as_str);
        if !device_peer_origin_allowed(origin) {
            self.log.append(
                "warn",
                "device-peer",
                &format!("refused origin {}", origin.unwrap_or("")),
            );
            let _ = write_http_response(
                stream,
                403,
                "application/json",
                &[],
                br#"{"status":"error","code":"ORIGIN_REFUSED","description":"Not a HandCash app"}"#,
            );
            return;
        }

        let cors_owned = device_peer_cors_headers(origin);
        let cors_refs: Vec<(&str, &str)> = cors_owned
            .iter()
            .map(|(k, v)| (*k, v.as_str()))
            .collect();

        if req.method == "OPTIONS" {
            let _ = write_http_response(stream, 200, "text/plain; charset=utf-8", &cors_refs, b"OK");
            return;
        }

        if !req.path.starts_with("/handcash-device/v1/") {
            let _ = write_http_response(
                stream,
                404,
                "application/json",
                &cors_refs,
                br#"{"status":"error","description":"Not a device-peer route"}"#,
            );
            return;
        }

        if let Err(msg) = self.wait_renderer_ready() {
            let body = json!({
                "status": "error",
                "code": "DEVICE_PEER_UNAVAILABLE",
                "description": msg,
            })
            .to_string();
            let _ =
                write_http_response(stream, 503, "application/json", &cors_refs, body.as_bytes());
            return;
        }

        let request_id = self.next_peer_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending_peer.lock().unwrap().insert(request_id, tx);

        let headers_val: serde_json::Map<String, Value> = req
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        let body_str = String::from_utf8_lossy(&req.body).into_owned();
        self.emit(
            "device-peer-http-request",
            json!({
                "method": req.method,
                "path": req.path,
                "headers": Value::Object(headers_val),
                "body": body_str,
                "request_id": request_id,
            }),
        );

        let timeout = if req.path.ends_with("/scan-login/vault") {
            DEVICE_PEER_SCAN_LOGIN_TIMEOUT
        } else {
            DEVICE_PEER_TIMEOUT
        };

        match rx.recv_timeout(timeout) {
            Ok(Ok(reply)) => {
                let _ = write_http_response(
                    stream,
                    reply.status,
                    "application/json",
                    &cors_refs,
                    reply.body.as_bytes(),
                );
            }
            Ok(Err(msg)) => {
                let body = json!({
                    "status": "error",
                    "code": "DEVICE_PEER_UNAVAILABLE",
                    "description": msg,
                })
                .to_string();
                let _ = write_http_response(
                    stream,
                    503,
                    "application/json",
                    &cors_refs,
                    body.as_bytes(),
                );
            }
            Err(_) => {
                self.pending_peer.lock().unwrap().remove(&request_id);
                let body = json!({
                    "status": "error",
                    "code": "DEVICE_PEER_UNAVAILABLE",
                    "description": "DEVICE_PEER_TIMEOUT",
                })
                .to_string();
                let _ = write_http_response(
                    stream,
                    503,
                    "application/json",
                    &cors_refs,
                    body.as_bytes(),
                );
            }
        }
    }
}

pub fn list_lan_ipv4_addresses() -> Vec<String> {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return vec![];
    };
    let mut out = Vec::new();
    for iface in ifaces {
        if iface.is_loopback() {
            continue;
        }
        if let IpAddr::V4(v4) = iface.ip() {
            if !v4.is_link_local() && !v4.is_unspecified() {
                let s = v4.to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::{ClientConfig, ClientConnection, RootCertStore};
    use rustls_pki_types::{CertificateDer, ServerName};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn raw_http_request(addr: &str, req: &str) -> String {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn brc100_http_https_and_device_peer_end_to_end() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-brc100-srv-{stamp}"));
        let log = HostLog::open(dir.join("logs"));
        let bridge = Brc100Bridge::new(dir.clone(), log);

        let bridge_for_push = Arc::clone(&bridge);
        bridge.set_push_handler(move |channel, payload| {
            if channel == "http-request" {
                let req_id = payload["request_id"].as_u64().unwrap();
                let path = payload["path"].as_str().unwrap_or("");
                let resp_body = json!({ "echoPath": path }).to_string();
                bridge_for_push.deliver_http_response(&json!({
                    "request_id": req_id,
                    "status": 200,
                    "body": resp_body,
                }));
            } else if channel == "device-peer-http-request" {
                let req_id = payload["request_id"].as_u64().unwrap();
                bridge_for_push.deliver_device_peer_response(&json!({
                    "request_id": req_id,
                    "status": 200,
                    "body": r#"{"peer":"ok"}"#,
                }));
            }
        });

        bridge.start_with_ports(0, 0, 0, false);
        bridge.mark_renderer_ready();

        let status = bridge.status_snapshot();
        assert_eq!(status["online"], Value::Bool(true));
        let http_addr = status["httpUrl"]
            .as_str()
            .unwrap()
            .trim_start_matches("http://");
        let https_addr = status["httpsUrl"]
            .as_str()
            .unwrap()
            .trim_start_matches("https://");
        let peer_port = status["devicePeerPort"].as_u64().unwrap();
        let peer_addr = format!("127.0.0.1:{peer_port}");

        // 1. /health over HTTP
        let health = raw_http_request(
            http_addr,
            "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        assert!(health.contains("200 OK"), "{health}");
        assert!(health.contains("handcash-brc100"), "{health}");
        assert!(health.contains("Access-Control-Allow-Private-Network: true"), "{health}");

        // 2. /manifest.json over real TLS (HTTPS)
        let mat = tls_cert::load_or_create_cert(&dir).unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(mat.cert_der)).unwrap();
        let client_cfg = Arc::new(
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let tcp = TcpStream::connect(https_addr).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let conn = ClientConnection::new(client_cfg, ServerName::try_from("localhost").unwrap()).unwrap();
        let mut tls = StreamOwned::new(conn, tcp);
        tls.write_all(b"GET /manifest.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut tls_out = String::new();
        let _ = tls.read_to_string(&mut tls_out);
        assert!(tls_out.contains("200 OK"), "{tls_out}");
        assert!(tls_out.contains("HandCash Desktop"), "{tls_out}");

        // 3. Renderer round-trip for /getVersion
        let ver = raw_http_request(
            http_addr,
            "POST /getVersion HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        assert!(ver.contains("200 OK"), "{ver}");
        assert!(ver.contains(r#""echoPath":"/getVersion""#), "{ver}");

        // 4. Device-peer refuses foreign browser Origin with 403 ORIGIN_REFUSED.
        let refused = raw_http_request(
            &peer_addr,
            "POST /handcash-device/v1/ping HTTP/1.1\r\nHost: localhost\r\nOrigin: https://evil.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        assert!(refused.contains("403 Forbidden"), "{refused}");
        assert!(refused.contains("ORIGIN_REFUSED"), "{refused}");

        // 5. Device-peer allows HandCash origin and forwards to renderer.
        let allowed = raw_http_request(
            &peer_addr,
            "POST /handcash-device/v1/ping HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:5173\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        assert!(allowed.contains("200 OK"), "{allowed}");
        assert!(allowed.contains(r#"{"peer":"ok"}"#), "{allowed}");

        bridge.stop();
        let _ = std::fs::remove_dir_all(dir);
    }
}
