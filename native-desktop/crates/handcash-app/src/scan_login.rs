// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure-Rust scan-to-sign-in receiver (`/handcash-device/v1/scan-login/*`) and
//! BRC-33 messagebox relay (`scan-login`). Wire-compatible with
//! `src/wallet/scanLogin/{payload.ts, receiver.ts, relay.ts}` and
//! `src/wallet/deviceTransfer/vaultTransfer.ts`.

use crate::messagebox::{build_messagebox_auth_headers, default_messagebox_base};
use crate::state::{AppServices, SessionSummary};
use base64::Engine as _;
use handcash_primitives::encoding::{decode_hex, encode_hex, hmac_sha256, sha256};
use handcash_primitives::keys::{brc78_decrypt, sign_ecdsa_compact, SecretKeyBytes, VaultMaster};
use handcash_shell::bridge_protocol::BridgeReply;
use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

pub const SCAN_LOGIN_KIND: &str = "handcash-scan-login";
pub const SCAN_LOGIN_TTL_MS: i64 = 10 * 60_000;
pub const SCAN_LOGIN_BOX: &str = "scan-login";
pub const RELAY_POLL_MS: u64 = 1_500;
pub const PAIRING_CODE_LENGTH: usize = 6;
pub const PAIRING_MAX_ATTEMPTS: usize = 3;
pub const PAIRING_CODE_TTL_MS: i64 = 2 * 60_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanLoginPayload {
    pub kind: String,
    pub v: u8,
    pub urls: Vec<String>,
    pub login_key: String,
    pub secret: String,
    pub label: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTransferMaster {
    pub derivation: Option<String>,
    pub key_hex: String,
    pub entropy_length: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTransfer {
    pub v: u8,
    pub kind: String,
    pub master: VaultTransferMaster,
    pub enrollment: Option<Value>,
    pub accounts: Option<Value>,
    pub sent_at: Option<i64>,
}

impl VaultTransfer {
    pub fn to_vault_master(&self) -> Result<VaultMaster, String> {
        let clean = self.master.key_hex.trim();
        let clean = clean
            .strip_prefix("0x")
            .or_else(|| clean.strip_prefix("0X"))
            .unwrap_or(clean);
        let sk = SecretKeyBytes::from_hex(clean).map_err(|e| e.to_string())?;
        let key_hex = sk.to_hex().to_string();
        if self.master.derivation.as_deref() == Some("brc-157") {
            let entropy_length = self.master.entropy_length.unwrap_or(32);
            if !matches!(entropy_length, 16 | 20 | 24 | 28 | 32) {
                return Err("The approving device sent an invalid vault".into());
            }
            Ok(VaultMaster::Brc157 {
                key_hex,
                entropy_length,
            })
        } else {
            Ok(VaultMaster::Brc42 { key_hex })
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanLoginEndReason {
    Refused,
    Expired,
    Locked,
}

impl ScanLoginEndReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Refused => "refused",
            Self::Expired => "expired",
            Self::Locked => "locked",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScanLoginPhase {
    Idle,
    Scan {
        qr_text: String,
        expires_at: i64,
    },
    ScanComparing {
        code: String,
        approver_label: String,
    },
    ScanConfirmed {
        approver_label: String,
    },
    Restoring,
    Installed {
        summary: SessionSummary,
        wrap_password: String,
    },
    Ended {
        reason: ScanLoginEndReason,
    },
    Error {
        message: String,
    },
}

impl ScanLoginPhase {
    pub const fn state_attr(&self) -> &'static str {
        match self {
            Self::Idle | Self::Scan { .. } | Self::Error { .. } => "scan",
            Self::ScanComparing { .. } => "scan-comparing",
            Self::ScanConfirmed { .. } => "scan-confirmed",
            Self::Restoring | Self::Installed { .. } => "restoring",
            Self::Ended { .. } => "ended",
        }
    }
}

struct ScanLoginSession {
    id: u64,
    payload: ScanLoginPayload,
    key: SecretKeyBytes,
    approver_key: Option<String>,
    approver_label: String,
    done: bool,
    code: Option<String>,
    code_expires_at: i64,
    attempts: usize,
    confirmed: bool,
    used_nonces: HashSet<String>,
}

pub struct ScanLoginManager {
    inner: Mutex<Option<ScanLoginSession>>,
    next_id: std::sync::atomic::AtomicU64,
    phase_tx: watch::Sender<ScanLoginPhase>,
}

impl Default for ScanLoginManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ScanLoginManager {
    pub fn new() -> Self {
        let (phase_tx, _) = watch::channel(ScanLoginPhase::Idle);
        Self {
            inner: Mutex::new(None),
            next_id: std::sync::atomic::AtomicU64::new(1),
            phase_tx,
        }
    }

    pub fn current_phase(&self) -> ScanLoginPhase {
        self.phase_tx.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<ScanLoginPhase> {
        self.phase_tx.subscribe()
    }

    /// Start a new scan-to-sign-in session (replacing any previous one).
    /// Returns `(session_id, payload, qr_text)`.
    pub fn start_session(&self, urls: Vec<String>, label: String) -> (u64, ScanLoginPayload, String) {
        self.start_session_at(urls, label, now_ms())
    }

    pub fn start_session_at(
        &self,
        urls: Vec<String>,
        label: String,
        now: i64,
    ) -> (u64, ScanLoginPayload, String) {
        let key = SecretKeyBytes::random();
        let login_key = key
            .public_key_hex()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let secret = encode_hex(SecretKeyBytes::random().as_bytes());
        let clean_urls: Vec<String> = urls
            .into_iter()
            .map(|u| u.trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty())
            .take(4)
            .collect();
        let payload = ScanLoginPayload {
            kind: SCAN_LOGIN_KIND.to_string(),
            v: 1,
            urls: clean_urls,
            login_key,
            secret,
            label,
            expires_at: now + SCAN_LOGIN_TTL_MS,
        };
        let qr_text = serde_json::to_string(&payload).unwrap_or_default();
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let session = ScanLoginSession {
            id,
            payload: payload.clone(),
            key,
            approver_key: None,
            approver_label: "your other device".to_string(),
            done: false,
            code: None,
            code_expires_at: 0,
            attempts: 0,
            confirmed: false,
            used_nonces: HashSet::new(),
        };
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(session);
        }
        self.phase_tx.send_replace(ScanLoginPhase::Scan {
            qr_text: qr_text.clone(),
            expires_at: payload.expires_at,
        });
        (id, payload, qr_text)
    }

    pub fn end_session(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
        self.phase_tx.send_replace(ScanLoginPhase::Idle);
    }

    pub fn active_session_key_if(&self, session_id: u64) -> Option<(SecretKeyBytes, i64)> {
        let guard = self.inner.lock().ok()?;
        let s = guard.as_ref()?;
        if s.id != session_id || s.done {
            return None;
        }
        Some((s.key.clone(), s.payload.expires_at))
    }

    pub fn expire_if_active(&self, session_id: u64) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(ref mut s) = *guard {
                if s.id == session_id && !s.done {
                    s.done = true;
                    self.phase_tx.send_replace(ScanLoginPhase::Ended {
                        reason: ScanLoginEndReason::Expired,
                    });
                }
            }
        }
    }

    pub fn is_session_active(&self, session_id: u64) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.id == session_id && !s.done))
            .unwrap_or(false)
    }
}

pub fn format_comparison_code(code: &str) -> String {
    let digits: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() == 6 {
        format!("{} {}", &digits[..3], &digits[3..])
    } else {
        code.to_string()
    }
}

pub fn is_scan_login_path(path: &str) -> bool {
    let clean = path.trim_end_matches('/');
    matches!(
        clean,
        "/handcash-device/v1/scan-login/hello"
            | "/handcash-device/v1/scan-login/confirm"
            | "/handcash-device/v1/scan-login/vault"
            | "/handcash-device/v1/scan-login/refuse"
    )
}

pub fn scan_login_proof(secret_hex: &str, step: &str, subject: &str) -> Option<String> {
    let key = decode_hex(secret_hex).ok()?;
    let msg = format!("handcash-scan-login\n{step}\n{subject}");
    Some(encode_hex(&hmac_sha256(&key, msg.as_bytes())))
}

pub fn pairing_confirm_proof(
    secret_hex: &str,
    approver_key: &str,
    nonce: &str,
    code: &str,
) -> Option<String> {
    let key = decode_hex(secret_hex).ok()?;
    let msg = format!(
        "handcash-scan-login\nconfirm\n{}\n{nonce}\n{code}",
        approver_key.to_ascii_lowercase()
    );
    Some(encode_hex(&hmac_sha256(&key, msg.as_bytes())))
}

pub fn pairing_receipt_text(login_key: &str, approver_key: &str, sealed_hash: &str) -> String {
    format!("handcash-scan-login\ninstalled\n{login_key}\n{approver_key}\n{sealed_hash}")
}

pub fn sha256_hex(text: &str) -> String {
    encode_hex(&sha256(text.as_bytes()))
}

pub fn proof_matches(expected: &str, given: Option<&str>) -> bool {
    let Some(given) = given else {
        return false;
    };
    let eb = expected.as_bytes();
    let gb = given.as_bytes();
    if eb.len() != gb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in eb.iter().zip(gb.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn is_compressed_pubkey_hex(s: &str) -> bool {
    s.len() == 66
        && (s.starts_with("02") || s.starts_with("03"))
        && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_nonce_hex(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Uniform 6-digit pairing code (rejection sampling, no modulo bias).
pub fn fresh_pairing_code() -> String {
    let limit = u32::MAX - (u32::MAX % 10);
    let mut out = String::with_capacity(PAIRING_CODE_LENGTH);
    while out.len() < PAIRING_CODE_LENGTH {
        let bytes = SecretKeyBytes::random();
        for chunk in bytes.as_bytes().as_chunks::<4>().0 {
            if out.len() >= PAIRING_CODE_LENGTH {
                break;
            }
            let val = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if val >= limit {
                continue;
            }
            out.push((b'0' + (val % 10) as u8) as char);
        }
    }
    out
}

pub fn open_vault_transfer(sealed_b64: &str, login_key: &SecretKeyBytes) -> Result<VaultTransfer, String> {
    let ct = base64::engine::general_purpose::STANDARD
        .decode(sealed_b64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    let plain = brc78_decrypt(&ct, login_key).map_err(|e| format!("decrypt failed: {e}"))?;
    let transfer: VaultTransfer =
        serde_json::from_slice(&plain).map_err(|e| format!("invalid vault json: {e}"))?;
    if transfer.v != 1
        || transfer.kind != "handcash-brc250-vault"
        || transfer.master.key_hex.trim().is_empty()
    {
        return Err("The approving device sent an invalid vault".into());
    }
    // Validate key format eagerly
    let _ = transfer.to_vault_master()?;
    Ok(transfer)
}

fn reply(status: u16, body: Value) -> BridgeReply {
    BridgeReply {
        status,
        body: body.to_string(),
    }
}

pub fn handle_scan_login_request(
    services: &AppServices,
    method: &str,
    path: &str,
    body_str: &str,
) -> BridgeReply {
    handle_scan_login_request_at(services, method, path, body_str, now_ms())
}

pub fn handle_scan_login_request_at(
    services: &AppServices,
    method: &str,
    path: &str,
    body_str: &str,
    now: i64,
) -> BridgeReply {
    if !method.eq_ignore_ascii_case("POST") {
        return reply(405, json!({ "error": "method-not-allowed" }));
    }
    let body: Value = match serde_json::from_str::<Value>(if body_str.trim().is_empty() { "{}" } else { body_str }) {
        Ok(v) if v.is_object() => v,
        _ => return reply(400, json!({ "error": "invalid-body" })),
    };
    let approver_key = body
        .get("approverKey")
        .and_then(Value::as_str)
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if !is_compressed_pubkey_hex(&approver_key) {
        return reply(400, json!({ "error": "invalid-body" }));
    }

    let step = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");

    // For `vault`, we decrypt & validate under the lock, then release the lock while
    // installing the vault durably so we never hold the session mutex across disk I/O.
    let vault_install_ctx: Option<(VaultTransfer, SecretKeyBytes, String, String, String, i64)> = {
        let Ok(mut guard) = services.scan_login.inner.lock() else {
            return reply(503, json!({ "error": "setup-failed" }));
        };
        let Some(live) = guard.as_mut() else {
            return reply(404, json!({ "error": "no-scan-login" }));
        };
        if live.done || live.payload.expires_at <= now {
            return reply(404, json!({ "error": "no-scan-login" }));
        }
        let secret = live.payload.secret.clone();
        let login_key = live.payload.login_key.clone();

        if step == "hello" {
            let expected = scan_login_proof(&secret, "hello", &approver_key);
            if !expected
                .as_deref()
                .is_some_and(|e| proof_matches(e, body.get("proof").and_then(Value::as_str)))
            {
                return reply(401, json!({ "error": "bad-proof" }));
            }
            if let Some(ref existing) = live.approver_key {
                if existing != &approver_key {
                    return reply(409, json!({ "error": "already-paired" }));
                }
            } else {
                let code = fresh_pairing_code();
                let approver_label = body
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.chars().take(60).collect::<String>())
                    .unwrap_or_else(|| "Your other device".to_string());
                live.approver_key = Some(approver_key);
                live.approver_label = approver_label.clone();
                live.code = Some(code.clone());
                live.code_expires_at = now + PAIRING_CODE_TTL_MS;
                services.scan_login.phase_tx.send_replace(ScanLoginPhase::ScanComparing {
                    code,
                    approver_label,
                });
            }
            return reply(
                200,
                json!({
                    "ok": true,
                    "loginKey": login_key,
                    "label": live.payload.label,
                    "codeLength": PAIRING_CODE_LENGTH,
                    "receiptVersion": 1,
                }),
            );
        }

        if live.approver_key.as_deref() != Some(approver_key.as_str()) {
            return reply(409, json!({ "error": "not-paired" }));
        }

        if step == "confirm" {
            let nonce = body.get("nonce").and_then(Value::as_str).unwrap_or("");
            if !is_nonce_hex(nonce) {
                return reply(400, json!({ "error": "invalid-body" }));
            }
            if live.used_nonces.contains(nonce) || live.confirmed {
                return reply(409, json!({ "error": "replayed" }));
            }
            if live.code_expires_at <= now {
                live.done = true;
                services.scan_login.phase_tx.send_replace(ScanLoginPhase::Ended {
                    reason: ScanLoginEndReason::Expired,
                });
                return reply(410, json!({ "error": "code-expired" }));
            }
            live.used_nonces.insert(nonce.to_string());
            let expected = live
                .code
                .as_deref()
                .and_then(|c| pairing_confirm_proof(&secret, &approver_key, nonce, c));
            if !expected
                .as_deref()
                .is_some_and(|e| proof_matches(e, body.get("proof").and_then(Value::as_str)))
            {
                live.attempts += 1;
                if live.attempts >= PAIRING_MAX_ATTEMPTS {
                    live.done = true;
                    services.scan_login.phase_tx.send_replace(ScanLoginPhase::Ended {
                        reason: ScanLoginEndReason::Locked,
                    });
                    return reply(423, json!({ "error": "locked", "attemptsLeft": 0 }));
                }
                return reply(
                    401,
                    json!({
                        "error": "wrong-code",
                        "attemptsLeft": PAIRING_MAX_ATTEMPTS - live.attempts,
                    }),
                );
            }
            live.confirmed = true;
            live.code = None;
            let approver_label = live.approver_label.clone();
            services.scan_login.phase_tx.send_replace(ScanLoginPhase::ScanConfirmed {
                approver_label,
            });
            return reply(200, json!({ "ok": true }));
        }

        if step == "refuse" {
            let expected = scan_login_proof(&secret, "refuse", &approver_key);
            if !expected
                .as_deref()
                .is_some_and(|e| proof_matches(e, body.get("proof").and_then(Value::as_str)))
            {
                return reply(401, json!({ "error": "bad-proof" }));
            }
            live.done = true;
            services.scan_login.phase_tx.send_replace(ScanLoginPhase::Ended {
                reason: ScanLoginEndReason::Refused,
            });
            return reply(200, json!({ "ok": true }));
        }

        if step == "vault" {
            if !live.confirmed {
                return reply(403, json!({ "error": "not-confirmed" }));
            }
            let sealed = body
                .get("sealedVault")
                .and_then(Value::as_str)
                .unwrap_or("");
            let sealed_hash = sha256_hex(sealed);
            let expected = scan_login_proof(&secret, "vault", &sealed_hash);
            if sealed.is_empty()
                || !expected
                    .as_deref()
                    .is_some_and(|e| proof_matches(e, body.get("proof").and_then(Value::as_str)))
            {
                return reply(401, json!({ "error": "bad-proof" }));
            }
            let transfer = match open_vault_transfer(sealed, &live.key) {
                Ok(t) => t,
                Err(_) => return reply(400, json!({ "error": "bad-vault" })),
            };
            live.done = true;
            services.scan_login.phase_tx.send_replace(ScanLoginPhase::Restoring);
            Some((
                transfer,
                live.key.clone(),
                login_key,
                approver_key,
                sealed_hash,
                live.payload.expires_at,
            ))
        } else {
            return reply(404, json!({ "error": "not-found" }));
        }
    };

    let Some((transfer, key, login_key, approver_key, sealed_hash, expires_at)) = vault_install_ctx
    else {
        return reply(404, json!({ "error": "not-found" }));
    };

    match services.install_scan_login_vault(&transfer) {
        Ok((summary, wrap_password)) => {
            if now_ms() >= expires_at {
                services.scan_login.phase_tx.send_replace(ScanLoginPhase::Ended {
                    reason: ScanLoginEndReason::Expired,
                });
                return reply(410, json!({ "error": "no-scan-login" }));
            }
            let receipt = pairing_receipt_text(&login_key, &approver_key, &sealed_hash);
            let Ok(sig_bytes) = sign_ecdsa_compact(&key, receipt.as_bytes()) else {
                services.scan_login.phase_tx.send_replace(ScanLoginPhase::Error {
                    message: "Could not sign installation receipt.".into(),
                });
                return reply(503, json!({ "error": "setup-failed" }));
            };
            let signature = encode_hex(&sig_bytes);
            services.scan_login.phase_tx.send_replace(ScanLoginPhase::Installed {
                summary,
                wrap_password,
            });
            reply(200, json!({ "ok": true, "signature": signature }))
        }
        Err(err) => {
            services
                .scan_login
                .phase_tx
                .send_replace(ScanLoginPhase::Error { message: err });
            reply(503, json!({ "error": "setup-failed" }))
        }
    }
}

/// Build `X-HandCash-*` signed request headers matching `src/wallet/identityRequestAuth.ts`.
fn signed_identity_request_headers(
    root: &SecretKeyBytes,
    scope: &str,
    method: &str,
    url_path: &str,
    content_type: &str,
    body_bytes: &[u8],
    timestamp_ms: i64,
) -> Result<Vec<(&'static str, String)>, String> {
    let ik = root.public_key_hex().map_err(|e| e.to_string())?.to_ascii_lowercase();
    let body_hash = encode_hex(&sha256(body_bytes));
    let nonce = encode_hex(&SecretKeyBytes::random().as_bytes()[..16]);
    let bound = json!([
        ["content-type", content_type],
        ["content-disposition", ""],
        ["x-handcash-recipient", ""],
        ["x-brc33-recipient", ""],
        ["x-handcash-filename", ""],
        ["x-brc33-filename", ""],
        ["x-handcash-exported-at", ""],
        ["x-handcash-spendable-sats", ""],
        ["x-handcash-action-count", ""],
        ["if-match", ""],
    ]);
    let text = json!([
        "HandCash-request-v1",
        scope,
        method.to_ascii_uppercase(),
        url_path,
        timestamp_ms,
        nonce,
        body_hash,
        bound,
    ])
    .to_string();
    let sig = sign_ecdsa_compact(root, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(vec![
        ("X-HandCash-Identity", ik),
        ("X-HandCash-Timestamp", timestamp_ms.to_string()),
        ("X-HandCash-Nonce", nonce),
        ("X-HandCash-Request-Signature", encode_hex(&sig)),
    ])
}

async fn relay_post(
    client: &reqwest::Client,
    base_url: &str,
    key: &SecretKeyBytes,
    method: &str,
    route: &str,
    payload: Value,
) -> Result<Value, String> {
    let url = format!("{base_url}/{route}");
    let url_path = url
        .find("/v1/messagebox/")
        .map(|i| &url[i..])
        .unwrap_or("/v1/messagebox/listMessages");
    let ts = now_ms();
    let body_str = payload.to_string();
    let mb_headers = build_messagebox_auth_headers(key, method, SCAN_LOGIN_BOX, ts)?;
    let id_headers = signed_identity_request_headers(
        key,
        "messagebox",
        "POST",
        url_path,
        "application/json",
        body_str.as_bytes(),
        ts,
    )?;
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");
    for (k, v) in mb_headers {
        req = req.header(k, v);
    }
    for (k, v) in id_headers {
        req = req.header(k, v);
    }
    let resp = req
        .body(body_str)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let val = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(format!("relay-{route}-{}", status.as_u16()));
    }
    Ok(val)
}

/// Poll the BRC-33 messagebox (`scan-login`) while `session_id` remains active.
/// Works both inside an existing Tokio runtime and from a plain UI thread (winit/Blitz/aeon-native).
pub fn spawn_scan_login_relay(services: Arc<AppServices>, session_id: u64) {
    let base_url = default_messagebox_base(&services);
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(run_scan_login_relay(services, session_id, base_url));
    } else {
        let _ = std::thread::Builder::new()
            .name("scan-login-relay".into())
            .spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(run_scan_login_relay(services, session_id, base_url));
                }
            });
    }
}

async fn run_scan_login_relay(services: Arc<AppServices>, session_id: u64, base_url: String) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    else {
        return;
    };
    loop {
        let Some((key, expires_at)) = services.scan_login.active_session_key_if(session_id)
        else {
            return;
        };
        if now_ms() >= expires_at {
            services.scan_login.expire_if_active(session_id);
            return;
        }
        match relay_post(
            &client,
            &base_url,
            &key,
            "listMessages",
            "listMessages",
            json!({ "messageBox": SCAN_LOGIN_BOX }),
        )
        .await
        {
            Ok(list) => {
                if let Some(messages) = list.get("messages").and_then(Value::as_array) {
                    let mut handled: Vec<String> = Vec::new();
                    for m in messages {
                        let Some(msg_id) = m.get("messageId").and_then(Value::as_str) else {
                            continue;
                        };
                        handled.push(msg_id.to_string());
                        let Some(sender) = m
                            .get("sender")
                            .and_then(Value::as_str)
                            .map(|s| s.to_ascii_lowercase())
                        else {
                            continue;
                        };
                        let mut req = match m.get("body") {
                            Some(Value::String(raw_body)) => {
                                match serde_json::from_str::<Value>(raw_body) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                }
                            }
                            Some(Value::Object(_)) => m.get("body").cloned().unwrap(),
                            _ => continue,
                        };
                        if req.get("t").and_then(Value::as_str) != Some("req") {
                            continue;
                        }
                        let Some(id) =
                            req.get("id").and_then(Value::as_str).map(ToString::to_string)
                        else {
                            continue;
                        };
                        let Some(step) =
                            req.get("step").and_then(Value::as_str).map(ToString::to_string)
                        else {
                            continue;
                        };
                        if let Some(obj) = req.as_object_mut() {
                            obj.remove("t");
                            obj.remove("id");
                            obj.remove("step");
                            obj.insert("approverKey".into(), Value::String(sender.clone()));
                        }
                        let out = handle_scan_login_request(
                            &services,
                            "POST",
                            &format!("/handcash-device/v1/scan-login/{step}"),
                            &req.to_string(),
                        );
                        let out_body: Value =
                            serde_json::from_str(&out.body).unwrap_or_else(|_| json!({}));
                        let reply_envelope = json!({
                            "t": "res",
                            "id": id,
                            "status": out.status,
                            "body": out_body,
                        });
                        if let Err(err) = relay_post(
                            &client,
                            &base_url,
                            &key,
                            "sendMessage",
                            "sendMessage",
                            json!({
                                "messageBox": SCAN_LOGIN_BOX,
                                "message": {
                                    "recipient": sender,
                                    "messageBox": SCAN_LOGIN_BOX,
                                    "body": reply_envelope.to_string(),
                                }
                            }),
                        )
                        .await
                        {
                            services.host_log.append(
                                "warn",
                                "scan-login",
                                &format!("relay reply failed ({step}): {err}"),
                            );
                        }
                    }
                    if !handled.is_empty() {
                        let _ = relay_post(
                            &client,
                            &base_url,
                            &key,
                            "acknowledgeMessage",
                            "acknowledgeMessage",
                            json!({
                                "messageBox": SCAN_LOGIN_BOX,
                                "messageIds": handled,
                            }),
                        )
                        .await;
                    }
                }
            }
            Err(err) => {
                services.host_log.append(
                    "warn",
                    "scan-login",
                    &format!("relay poll failed: {err}"),
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(RELAY_POLL_MS)).await;
    }
}

/// Render a QR code as an SVG `data:image/svg+xml;base64,...` URI (for Blitz `img src`).
pub fn render_qr_svg_data_uri(data: &str) -> String {
    match QrCode::with_error_correction_level(data.as_bytes(), EcLevel::M) {
        Ok(code) => {
            let svg_str = code
                .render::<svg::Color>()
                .min_dimensions(200, 200)
                .dark_color(svg::Color("#000000"))
                .light_color(svg::Color("#ffffff"))
                .quiet_zone(true)
                .build();
            let b64 = base64::engine::general_purpose::STANDARD.encode(svg_str.as_bytes());
            format!("data:image/svg+xml;base64,{b64}")
        }
        Err(_) => String::new(),
    }
}

/// Render a QR code as straight-alpha RGBA8 pixels (`aeon-image` for `aeon-native`, `None` on Blitz).
pub fn render_qr_image_attr(
    data: &str,
    target_px: u32,
) -> Option<dioxus::dioxus_core::AttributeValue> {
    #[cfg(feature = "aeon")]
    {
        let code = QrCode::with_error_correction_level(data.as_bytes(), EcLevel::M).ok()?;
        let w = code.width();
        let quiet = 2usize;
        let total = w + quiet * 2;
        let scale = ((target_px as usize) / total).max(2);
        let dim = total * scale;
        let mut rgba = vec![255u8; dim * dim * 4];
        let colors = code.to_colors();
        for my in 0..w {
            for mx in 0..w {
                if colors[my * w + mx] == qrcode::Color::Dark {
                    let py0 = (my + quiet) * scale;
                    let px0 = (mx + quiet) * scale;
                    for dy in 0..scale {
                        let row_off = (py0 + dy) * dim;
                        for dx in 0..scale {
                            let idx = (row_off + px0 + dx) * 4;
                            rgba[idx] = 0;
                            rgba[idx + 1] = 0;
                            rgba[idx + 2] = 0;
                            rgba[idx + 3] = 255;
                        }
                    }
                }
            }
        }
        let pixels = aeon_native::ImagePixels::rgba8(dim as u32, dim as u32, rgba).ok()?;
        Some(aeon_native::ImageAttr::new(pixels).into_attr_value())
    }
    #[cfg(not(feature = "aeon"))]
    {
        let _ = (data, target_px);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use handcash_primitives::keys::brc78_encrypt;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("hc-scan-login-{tag}-{nanos}"))
    }

    #[test]
    fn full_scan_login_handshake_installs_vault_and_signs_receipt() {
        let svc = AppServices::open_in(temp_dir("full"), false).unwrap();
        let (_id, payload, qr_text) = svc
            .scan_login
            .start_session(vec!["http://192.168.1.20:3340".into()], "Linux PC".into());
        assert!(qr_text.contains(SCAN_LOGIN_KIND));
        assert!(!render_qr_svg_data_uri(&qr_text).is_empty());

        let approver = SecretKeyBytes::random();
        let approver_ik = approver.public_key_hex().unwrap().to_ascii_lowercase();

        // 1. hello
        let hello_proof = scan_login_proof(&payload.secret, "hello", &approver_ik).unwrap();
        let r = handle_scan_login_request(
            &svc,
            "POST",
            "/handcash-device/v1/scan-login/hello",
            &json!({ "approverKey": approver_ik, "label": "My Phone", "proof": hello_proof })
                .to_string(),
        );
        assert_eq!(r.status, 200);
        let shown_code = match svc.scan_login.current_phase() {
            ScanLoginPhase::ScanComparing { code, approver_label } => {
                assert_eq!(approver_label, "My Phone");
                assert_eq!(code.len(), PAIRING_CODE_LENGTH);
                code
            }
            other => panic!("expected ScanComparing, got {other:?}"),
        };

        // 2. vault before confirm is rejected (403)
        let r_early = handle_scan_login_request(
            &svc,
            "POST",
            "/handcash-device/v1/scan-login/vault",
            &json!({ "approverKey": approver_ik, "sealedVault": "abc", "proof": "00" }).to_string(),
        );
        assert_eq!(r_early.status, 403);

        // 3. wrong confirm code returns 401 with 2 attempts left
        let wrong = if shown_code == "000000" { "111111" } else { "000000" };
        let n1 = encode_hex(&SecretKeyBytes::random().as_bytes()[..16]);
        let bad_proof = pairing_confirm_proof(&payload.secret, &approver_ik, &n1, wrong).unwrap();
        let r_bad = handle_scan_login_request(
            &svc,
            "POST",
            "/handcash-device/v1/scan-login/confirm",
            &json!({ "approverKey": approver_ik, "nonce": n1, "proof": bad_proof }).to_string(),
        );
        assert_eq!(r_bad.status, 401);

        // 4. correct confirm code returns 200
        let n2 = encode_hex(&SecretKeyBytes::random().as_bytes()[..16]);
        let good_proof =
            pairing_confirm_proof(&payload.secret, &approver_ik, &n2, &shown_code).unwrap();
        let r_ok = handle_scan_login_request(
            &svc,
            "POST",
            "/handcash-device/v1/scan-login/confirm",
            &json!({ "approverKey": approver_ik, "nonce": n2, "proof": good_proof }).to_string(),
        );
        assert_eq!(r_ok.status, 200);

        // 5. send BRC-78 encrypted vault with approver holding account 0
        let vault_root = SecretKeyBytes::random();
        let vault_master_ik = vault_root.public_key_hex().unwrap().to_ascii_lowercase();
        let transfer_json = json!({
            "v": 1,
            "kind": "handcash-brc250-vault",
            "master": { "derivation": "brc-42", "keyHex": vault_root.to_hex().to_string() },
            "enrollment": null,
            "accounts": {
                "version": 1,
                "masterIdentityKey": vault_master_ik,
                "activeIndex": 0,
                "accounts": [{ "index": 0, "name": "Primary", "identityKey": vault_master_ik, "holding": { "kind": "here", "seq": 1 } }]
            },
            "sentAt": now_ms(),
        });
        let sealed_ct =
            brc78_encrypt(transfer_json.to_string().as_bytes(), &approver, &payload.login_key)
                .unwrap();
        let sealed_b64 = base64::engine::general_purpose::STANDARD.encode(&sealed_ct);
        let vault_proof =
            scan_login_proof(&payload.secret, "vault", &sha256_hex(&sealed_b64)).unwrap();
        let r_vault = handle_scan_login_request(
            &svc,
            "POST",
            "/handcash-device/v1/scan-login/vault",
            &json!({
                "approverKey": approver_ik,
                "sealedVault": sealed_b64,
                "proof": vault_proof,
            })
            .to_string(),
        );
        assert_eq!(r_vault.status, 200, "vault reply: {}", r_vault.body);
        let body: Value = serde_json::from_str(&r_vault.body).unwrap();
        assert_eq!(body.get("ok").and_then(Value::as_bool), Some(true));
        let sig = body.get("signature").and_then(Value::as_str).unwrap();
        assert_eq!(sig.len(), 128);

        // Approver's account 0 must stay held elsewhere; this device holds account 1.
        let active = svc.current_session_summary().unwrap();
        assert_eq!(active.account_index, 1);
        let accounts = svc.list_vault_accounts();
        assert_eq!(accounts.len(), 2);
        assert!(!accounts[0].held_here);
        assert!(accounts[1].held_here);
    }
}
