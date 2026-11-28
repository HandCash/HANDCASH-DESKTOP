// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure-Rust P2P chat delivery (BRC-33 + BRC-78), file attachments (<= 8 MB),
//! chat slash-commands (`/pay`, `/tip`, `/request`), and call signaling (`handcash-call`).

use crate::messagebox::{build_messagebox_auth_headers, default_messagebox_base};
use crate::state::{now_ms, AppServices};
use base64::Engine as _;
use handcash_primitives::encoding::decode_hex;
use handcash_primitives::keys::{brc78_decrypt, brc78_encrypt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const CHAT_MESSAGE_BOX: &str = "handcash-chat";
pub const CALL_SIGNAL_BOX: &str = "handcash-call";
pub const MAX_CHAT_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub data_base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChatSlashCommand {
    Pay { amount_sats: u64, note: Option<String> },
    Tip { amount_sats: u64 },
    Request { amount_sats: u64, note: Option<String> },
}

/// Parse `/pay <sats> [note]`, `/tip <sats>`, or `/request <sats> [note]`.
pub fn parse_chat_command(raw: &str) -> Option<ChatSlashCommand> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let mut parts = trimmed.splitn(3, ' ');
    let verb = parts.next()?.to_ascii_lowercase();
    let amt_str = parts.next()?.trim();
    let amount_sats: u64 = amt_str.parse().ok()?;
    if amount_sats == 0 {
        return None;
    }
    let note = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    match verb.as_str() {
        "/pay" => Some(ChatSlashCommand::Pay { amount_sats, note }),
        "/tip" => Some(ChatSlashCommand::Tip { amount_sats }),
        "/request" => Some(ChatSlashCommand::Request { amount_sats, note }),
        _ => None,
    }
}

/// Validate and encode raw bytes into a `ChatAttachment` (enforces 8 MB limit).
pub fn encode_chat_attachment(
    filename: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<ChatAttachment, String> {
    if bytes.is_empty() {
        return Err("Cannot attach an empty file.".into());
    }
    if bytes.len() > MAX_CHAT_ATTACHMENT_BYTES {
        return Err(format!(
            "File exceeds the {} MB attachment limit.",
            MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    Ok(ChatAttachment {
        filename: filename.to_string(),
        mime_type: mime_type.to_string(),
        size_bytes: bytes.len(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Open native file picker and load an attachment (<= 8 MB).
pub fn pick_chat_attachment() -> Result<Option<ChatAttachment>, String> {
    let Some(path) = rfd::FileDialog::new().pick_file() else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read file: {e}"))?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment.bin")
        .to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    };
    encode_chat_attachment(&filename, mime, &bytes).map(Some)
}

/// Encrypt and send a BRC-33 chat envelope to a peer identity key.
pub async fn send_peer_chat_envelope(
    services: &AppServices,
    peer_identity_key: &str,
    text: &str,
    attachment: Option<&ChatAttachment>,
) -> Result<(), String> {
    let root = {
        let guard = services.session.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or("Wallet is locked.")?
            .deriver
            .root_key()
            .clone()
    };
    let peer_pk = decode_hex(peer_identity_key)
        .map_err(|_| "Peer identity key is not valid hex.".to_string())?;
    if peer_pk.len() != 33 {
        return Err("Peer identity key must be 33-byte compressed secp256k1.".into());
    }
    let payload = json!({
        "v": 1,
        "kind": "chat",
        "text": text,
        "attachment": attachment,
        "sentAt": now_ms(),
    });
    let payload_str = payload.to_string();
    let ct = brc78_encrypt(payload_str.as_bytes(), &root, peer_identity_key)
        .map_err(|e| format!("Chat encryption failed: {e}"))?;
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(&ct);
    let base = default_messagebox_base(services);
    let url = format!("{base}/sendMessage");
    let headers = build_messagebox_auth_headers(&root, "POST", CHAT_MESSAGE_BOX, now_ms())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).json(&json!({
        "recipient": peer_identity_key,
        "messageBox": CHAT_MESSAGE_BOX,
        "body": body_b64,
    }));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Chat delivery failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Messagebox returned HTTP {}", resp.status().as_u16()));
    }
    Ok(())
}

/// Decrypt an incoming BRC-78 chat payload.
pub fn decrypt_peer_chat_envelope(
    root: &handcash_primitives::keys::SecretKeyBytes,
    body_b64: &str,
) -> Result<Value, String> {
    let ct = base64::engine::general_purpose::STANDARD
        .decode(body_b64.trim())
        .map_err(|e| format!("Invalid base64 chat payload: {e}"))?;
    let pt = brc78_decrypt(&ct, root).map_err(|e| format!("Chat decrypt failed: {e}"))?;
    serde_json::from_slice(&pt).map_err(|e| format!("Invalid chat JSON: {e}"))
}

// ---------------------------------------------------------------------------
// Native Call Signaling & Live Call State (`CallDock` parity)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallSnapshot {
    pub state: String, // "idle" | "outgoing" | "incoming" | "active" | "ended"
    pub peer_id: String,
    pub peer_label: String,
    pub status_label: String,
    pub started_at_ms: i64,
    pub muted: bool,
    pub camera_on: bool,
    pub encrypted: bool,
}

impl Default for CallSnapshot {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            peer_id: String::new(),
            peer_label: String::new(),
            status_label: String::new(),
            started_at_ms: 0,
            muted: false,
            camera_on: false,
            encrypted: true,
        }
    }
}

static LIVE_CALL: OnceLock<Mutex<CallSnapshot>> = OnceLock::new();
static LAST_SCREENSHOT_VERSION: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn call_lock() -> &'static Mutex<CallSnapshot> {
    LIVE_CALL.get_or_init(|| Mutex::new(CallSnapshot::default()))
}

pub fn current_call_snapshot() -> CallSnapshot {
    call_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

pub fn start_outgoing_call(peer_id: &str, peer_label: &str) -> CallSnapshot {
    let mut g = call_lock().lock().unwrap_or_else(|e| e.into_inner());
    *g = CallSnapshot {
        state: "outgoing".into(),
        peer_id: peer_id.to_string(),
        peer_label: peer_label.to_string(),
        status_label: "Calling…".into(),
        started_at_ms: now_ms(),
        muted: false,
        camera_on: false,
        encrypted: true,
    };
    g.clone()
}

pub fn accept_live_call() -> CallSnapshot {
    let mut g = call_lock().lock().unwrap_or_else(|e| e.into_inner());
    g.state = "active".into();
    g.status_label = "Connected".into();
    g.started_at_ms = now_ms();
    g.clone()
}

pub fn toggle_call_mute() -> CallSnapshot {
    let mut g = call_lock().lock().unwrap_or_else(|e| e.into_inner());
    g.muted = !g.muted;
    g.clone()
}

pub fn toggle_call_camera() -> CallSnapshot {
    let mut g = call_lock().lock().unwrap_or_else(|e| e.into_inner());
    g.camera_on = !g.camera_on;
    g.clone()
}

pub fn hang_up_live_call() -> CallSnapshot {
    let mut g = call_lock().lock().unwrap_or_else(|e| e.into_inner());
    g.state = "ended".into();
    g.status_label = "Call ended".into();
    g.clone()
}

pub fn dismiss_live_call() -> CallSnapshot {
    let mut g = call_lock().lock().unwrap_or_else(|e| e.into_inner());
    *g = CallSnapshot::default();
    g.clone()
}

pub fn set_screenshot_toast(version: Option<String>) {
    let lock = LAST_SCREENSHOT_VERSION.get_or_init(|| Mutex::new(None));
    *lock.lock().unwrap_or_else(|e| e.into_inner()) = version;
}

pub fn current_screenshot_toast() -> Option<String> {
    let lock = LAST_SCREENSHOT_VERSION.get_or_init(|| Mutex::new(None));
    lock.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Send a BRC-33 call signal (`offer` | `answer` | `decline` | `hangup`).
pub async fn send_call_signal(
    services: &AppServices,
    peer_identity_key: &str,
    signal_kind: &str,
) -> Result<(), String> {
    let root = {
        let guard = services.session.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .ok_or("Wallet is locked.")?
            .deriver
            .root_key()
            .clone()
    };
    let base = default_messagebox_base(services);
    let url = format!("{base}/sendMessage");
    let headers = build_messagebox_auth_headers(&root, "POST", CALL_SIGNAL_BOX, now_ms())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).json(&json!({
        "recipient": peer_identity_key,
        "messageBox": CALL_SIGNAL_BOX,
        "body": json!({ "kind": signal_kind, "at": now_ms() }).to_string(),
    }));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| format!("Call signal failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Call signal rejected (HTTP {})", resp.status().as_u16()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use handcash_primitives::keys::SecretKeyBytes;

    #[test]
    fn slash_commands_parse_pay_tip_request() {
        assert_eq!(
            parse_chat_command("/pay 500 coffee"),
            Some(ChatSlashCommand::Pay { amount_sats: 500, note: Some("coffee".into()) })
        );
        assert_eq!(
            parse_chat_command("/tip 100"),
            Some(ChatSlashCommand::Tip { amount_sats: 100 })
        );
        assert_eq!(
            parse_chat_command("/request 2500 lunch"),
            Some(ChatSlashCommand::Request { amount_sats: 2500, note: Some("lunch".into()) })
        );
        assert_eq!(parse_chat_command("/pay 0"), None);
        assert_eq!(parse_chat_command("hello"), None);
    }

    #[test]
    fn attachment_enforces_size_limit_and_roundtrips_brc78_chat() {
        assert!(encode_chat_attachment("empty.txt", "text/plain", &[]).is_err());
        let big = vec![0u8; MAX_CHAT_ATTACHMENT_BYTES + 1];
        assert!(encode_chat_attachment("huge.bin", "application/octet-stream", &big).is_err());
        let ok = encode_chat_attachment("hi.txt", "text/plain", b"hello").unwrap();
        assert_eq!(ok.size_bytes, 5);

        let alice = SecretKeyBytes::random();
        let bob = SecretKeyBytes::random();
        let bob_pk = bob.public_key_hex().unwrap();
        let payload = json!({ "v": 1, "text": "secret hi" }).to_string();
        let ct = brc78_encrypt(payload.as_bytes(), &alice, &bob_pk).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&ct);
        let dec = decrypt_peer_chat_envelope(&bob, &b64).unwrap();
        assert_eq!(dec["text"], "secret hi");
    }

    #[test]
    fn call_lifecycle_transitions_cleanly() {
        let s = start_outgoing_call("02aa", "$alice");
        assert_eq!(s.state, "outgoing");
        let s = accept_live_call();
        assert_eq!(s.state, "active");
        let s = toggle_call_mute();
        assert!(s.muted);
        let s = hang_up_live_call();
        assert_eq!(s.state, "ended");
        let s = dismiss_live_call();
        assert_eq!(s.state, "idle");
    }
}
