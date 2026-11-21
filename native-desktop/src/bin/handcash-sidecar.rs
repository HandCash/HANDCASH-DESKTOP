//! Headless Mac host services. The Swift WebView owns custody and UI IPC;
//! this process owns only BRC-100 transport or the packaged static UI server.
#![allow(dead_code)]
#[path = "../brc100_server.rs"] mod brc100_server;
#[path = "../bridge_protocol.rs"] mod bridge_protocol;
#[path = "../device_auth.rs"] mod device_auth;
#[path = "../host_log.rs"] mod host_log;
#[path = "../http_wire.rs"] mod http_wire;
#[path = "../paths.rs"] mod paths;
#[path = "../spend_ledger.rs"] mod spend_ledger;
#[path = "../tls_cert.rs"] mod tls_cert;
#[path = "../ui_server.rs"] mod ui_server;

use brc100_server::Brc100Bridge;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::Arc;

// HTTP bodies may contain BEEF; allow JSON escaping overhead, but never grow
// an unbounded line buffer on a broken or compromised host connection.
const MAX_FRAME_BYTES: u64 = 128 * 1024 * 1024;

fn emit(mut out: impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut out, value)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn stdout(value: &Value) {
    if emit(io::stdout().lock(), value).is_err() {
        // The host has gone away. Do not leave trusted listeners orphaned.
        std::process::exit(1);
    }
}

fn read_frame(input: &mut impl BufRead) -> io::Result<Option<Value>> {
    read_frame_bounded(input, MAX_FRAME_BYTES)
}

fn read_frame_bounded(input: &mut impl BufRead, limit: u64) -> io::Result<Option<Value>> {
    let mut line = Vec::new();
    let count = std::io::Read::take(&mut *input, limit + 1).read_until(b'\n', &mut line)?;
    if count == 0 { return Ok(None); }
    if count as u64 > limit || line.last() != Some(&b'\n') {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "sidecar frame exceeds limit or is truncated"));
    }
    let value: Value = serde_json::from_slice(&line)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid sidecar JSON"))?;
    validate(&value)?;
    Ok(Some(value))
}

fn validate(value: &Value) -> io::Result<()> {
    let valid = value["v"] == 1 && match value["type"].as_str() {
        Some("shutdown" | "renderer-ready") => true,
        Some("from-renderer") => match value["channel"].as_str() {
            Some("http-response" | "device-peer-http-response") => value["payload"].is_object(),
            Some("bridge:prompt-open") => value["payload"].is_boolean(),
            _ => false,
        },
        _ => false,
    };
    if valid { Ok(()) } else {
        Err(io::Error::new(io::ErrorKind::InvalidData, "unsupported sidecar frame"))
    }
}

fn dispatch(bridge: &Brc100Bridge, msg: &Value) -> bool {
    match msg["type"].as_str() {
        Some("shutdown") => return false,
        Some("renderer-ready") => bridge.mark_renderer_ready(),
        Some("from-renderer") => match msg["channel"].as_str() {
            Some("http-response") => bridge.deliver_http_response(&msg["payload"]),
            Some("device-peer-http-response") => bridge.deliver_device_peer_response(&msg["payload"]),
            Some("bridge:prompt-open") => bridge.set_prompt_open(msg["payload"] == true),
            _ => {}
        },
        _ => {}
    }
    true
}

fn run() -> Result<(), String> {
    let ui_mode = match std::env::args().nth(1).as_deref() {
        None => false,
        Some("--ui") => true,
        _ => return Err("unknown sidecar mode".into()),
    };
    let log = host_log::HostLog::open_default();
    if ui_mode {
        let root = ui_server::PackagedUiServer::discover_dist_root()
            .ok_or("packaged UI root missing")?;
        let mut server = ui_server::PackagedUiServer::start(root, log)?;
        stdout(&json!({"v":1,"type":"ready","origin":ui_server::UI_ORIGIN}));
        let result = consume(&mut io::stdin().lock(), |_| true);
        server.stop();
        return result;
    }
    let bridge = Brc100Bridge::new(paths::user_data_dir(), log);
    bridge.set_push_handler(|channel, payload| {
        stdout(&json!({"v":1,"type":"to-renderer","channel":channel,"payload":payload}));
    });
    let signal_bridge = Arc::clone(&bridge);
    ctrlc::set_handler(move || {
        signal_bridge.stop();
        std::process::exit(0);
    }).map_err(|e| e.to_string())?;
    bridge.start_if_needed();
    let mut status = bridge.status_snapshot();
    if status["online"] != true {
        bridge.stop();
        return Err(status["error"].as_str().unwrap_or("bridge startup failed").to_string());
    }
    status["v"] = json!(1);
    status["type"] = json!("ready");
    stdout(&status);
    let result = consume(&mut io::stdin().lock(), |msg| dispatch(&bridge, msg));
    bridge.stop();
    result
}

fn consume(input: &mut impl BufRead, mut handle: impl FnMut(&Value) -> bool) -> Result<(), String> {
    while let Some(msg) = read_frame(input).map_err(|e| e.to_string())? {
        if msg["type"] == "shutdown" || !handle(&msg) { break; }
    }
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        stdout(&json!({"v":1,"type":"fatal","message":message}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_host_frames_and_stops_at_shutdown() {
        let frames = b"{\"v\":1,\"type\":\"renderer-ready\"}\n{\"v\":1,\"type\":\"from-renderer\",\"channel\":\"http-response\",\"payload\":{\"request_id\":1,\"status\":200,\"body\":\"ok\"}}\n{\"v\":1,\"type\":\"shutdown\"}\nnot read\n";
        let mut seen = 0;
        consume(&mut &frames[..], |_| { seen += 1; true }).unwrap();
        assert_eq!(seen, 2);
    }
    #[test]
    fn rejects_bad_versions_channels_json_and_truncated_frames() {
        for raw in [
            "{\"v\":2,\"type\":\"renderer-ready\"}\n",
            "{\"v\":1,\"type\":\"from-renderer\",\"channel\":\"sign\"}\n",
            "{\"v\":1,\"type\":\"from-renderer\",\"channel\":\"bridge:prompt-open\",\"payload\":{}}\n",
            "bad\n", "{\"v\":1,\"type\":\"shutdown\"}",
        ] { assert!(read_frame(&mut raw.as_bytes()).is_err()); }
        assert!(read_frame(&mut &b""[..]).unwrap().is_none());
    }
    #[test]
    fn rejects_oversized_frames_without_reading_the_remaining_stream() {
        let bytes = b"01234567890123456789\n";
        let mut input = &bytes[..];
        assert!(read_frame_bounded(&mut input, 8).is_err());
        assert_eq!(input.len(), bytes.len() - 9);
    }
    #[test]
    fn output_is_one_versioned_json_line() {
        let mut out = Vec::new();
        let value = json!({"v":1,"type":"to-renderer","channel":"http-request","payload":{"body":"a\nb"}});
        emit(&mut out, &value).unwrap();
        assert_eq!(out.iter().filter(|&&b| b == b'\n').count(), 1);
        assert_eq!(serde_json::from_slice::<Value>(&out).unwrap(), value);
    }
}
