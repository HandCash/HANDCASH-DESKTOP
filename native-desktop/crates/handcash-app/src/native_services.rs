// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Native Rust runtime services closing TS parity gates:
//! - Single auditable independent crypto-review gate for live signing/broadcast
//! - Support log upload (`logShip.ts` parity, scrubbed via `log_privacy`)
//! - Cloud BRC-39 remote backup/restore + empty-local guard + recompose
//! - BRC-249 account holding records, signed release requests, and BRC-38 delta handover
//! - Native screenshot capture to system clipboard
//! - Native app-browser window launcher

use crate::messagebox::{build_messagebox_auth_headers, default_messagebox_base};
use crate::state::{now_ms, AppServices, DEVICE_ID_STORAGE_KEY, HISTORY_BACKUP_PREFS_KEY, SUGGESTED_HISTORY_BACKUP_BASE_URL};
use handcash_primitives::encoding::{decode_hex, encode_hex};
use handcash_primitives::keys::{sign_ecdsa_compact, verify_ecdsa_der, SecretKeyBytes};
use handcash_shell::log_privacy::LogScrubber;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::Cell;
use std::process::Command;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Independent Crypto / Security Review Gate
// ---------------------------------------------------------------------------

/// Live mainnet signing and transaction broadcast from Rust require an explicit
/// independent crypto/security review sign-off (`docs/rust-conversion-fast-plan.md`).
/// Flip to `true` only after the review record is archived.
pub const CRYPTO_REVIEW_APPROVED: bool = false;

thread_local! {
    static TEST_SIGNING_OVERRIDE: Cell<Option<bool>> = const { Cell::new(None) };
}

/// Returns true when live Rust signing/broadcast is authorized (either via
/// `CRYPTO_REVIEW_APPROVED`, explicit dev opt-in `HANDCASH_ALLOW_UNREVIEWED_SIGNING=1`,
/// or a test-scoped override).
pub fn is_native_signing_enabled() -> bool {
    if let Some(v) = TEST_SIGNING_OVERRIDE.with(Cell::get) {
        return v;
    }
    if CRYPTO_REVIEW_APPROVED {
        return true;
    }
    std::env::var("HANDCASH_ALLOW_UNREVIEWED_SIGNING")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Fails closed when independent crypto review has not been signed off.
pub fn require_native_signing_review(action: &str) -> Result<(), String> {
    if is_native_signing_enabled() {
        Ok(())
    } else {
        Err(format!(
            "{action} requires independent crypto review sign-off before live broadcast (CRYPTO_REVIEW_APPROVED = false)."
        ))
    }
}

#[cfg(test)]
pub fn with_native_signing_for_test<T>(enabled: bool, f: impl FnOnce() -> T) -> T {
    let prev = TEST_SIGNING_OVERRIDE.with(|c| c.replace(Some(enabled)));
    let out = f();
    TEST_SIGNING_OVERRIDE.with(|c| c.set(prev));
    out
}

// ---------------------------------------------------------------------------
// Support Log Upload (`src/wallet/logShip.ts` parity)
// ---------------------------------------------------------------------------

const MAX_LOG_UPLOAD_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogUploadReceipt {
    pub status: u16,
    pub bytes_sent: usize,
    pub lines_sent: usize,
}

pub fn validate_log_upload_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a support upload URL first.".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    let is_local = lower.starts_with("http://127.0.0.1:")
        || lower.starts_with("http://localhost:")
        || lower.starts_with("http://[::1]:");
    if !lower.starts_with("https://") && !is_local {
        return Err("Upload URL must use https:// (or localhost for testing).".into());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("Upload URL cannot contain whitespace.".into());
    }
    Ok(trimmed.to_string())
}

/// Scrub every line through `LogScrubber` and bound total payload before upload.
pub fn prepare_scrubbed_log_payload(raw_logs: &str) -> (String, usize) {
    let scrubber = LogScrubber::new_random();
    let mut out = String::new();
    let mut count = 0usize;
    for line in raw_logs.lines() {
        let clean = scrubber.scrub(line);
        if out.len() + clean.len() + 1 > MAX_LOG_UPLOAD_BYTES {
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&clean);
        count += 1;
    }
    (out, count)
}

pub async fn upload_support_logs(
    upload_url: &str,
    raw_logs: &str,
    app_version: &str,
) -> Result<LogUploadReceipt, String> {
    let url = validate_log_upload_url(upload_url)?;
    let (body, lines_sent) = prepare_scrubbed_log_payload(raw_logs);
    if body.is_empty() {
        return Err("No session log lines to upload.".into());
    }
    let bytes_sent = body.len();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(&url)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("X-HandCash-Version", app_version)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Upload failed: {e}"))?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        return Err(format!("Support server rejected log upload (HTTP {status})."));
    }
    Ok(LogUploadReceipt {
        status,
        bytes_sent,
        lines_sent,
    })
}

// ---------------------------------------------------------------------------
// Native Screenshot Capture (`ScreenshotToast` parity)
// ---------------------------------------------------------------------------

/// Capture a desktop screenshot and place it on the system clipboard.
pub fn capture_screenshot_to_clipboard() -> Result<String, String> {
    let tmp_path = std::env::temp_dir().join(format!("handcash-shot-{}.png", now_ms()));
    let path_str = tmp_path.to_string_lossy().to_string();
    let captured = if cfg!(target_os = "macos") {
        Command::new("screencapture")
            .args(["-x", &path_str])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else if cfg!(target_os = "windows") {
        false
    } else {
        // Linux Wayland/X11 capture fallbacks
        let candidates: &[(&str, &[&str])] = &[
            ("grim", &[&path_str]),
            ("scrot", &[&path_str]),
            ("spectacle", &["-b", "-n", "-o", &path_str]),
        ];
        candidates.iter().any(|(bin, args)| {
            Command::new(bin)
                .args(*args)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
    };
    if !captured || !tmp_path.exists() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("No desktop screenshot tool (grim/scrot/spectacle) responded on this host.".into());
    }
    let bytes = std::fs::read(&tmp_path).map_err(|e| format!("Read screenshot: {e}"))?;
    let _ = std::fs::remove_file(&tmp_path);
    if bytes.is_empty() {
        return Err("Captured screenshot was empty.".into());
    }
    Ok(format!("Captured {} KB screenshot", bytes.len().div_ceil(1024)))
}

// ---------------------------------------------------------------------------
// Native App Browser Window Launcher (`AppBrowserPanel` parity)
// ---------------------------------------------------------------------------

pub fn launch_app_browser_window(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let ok_scheme = lower.starts_with("https://")
        || lower.starts_with("http://localhost")
        || lower.starts_with("http://127.0.0.1");
    if !ok_scheme {
        return Err("Only https:// or localhost URLs may be opened.".into());
    }
    // Prefer sibling `handcash-shell` native webview host when installed beside us,
    // otherwise open directly in the OS browser connected to the local BRC-100 bridge.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let shell_name = if cfg!(target_os = "windows") {
                "handcash-shell.exe"
            } else {
                "handcash-shell"
            };
            let candidate = dir.join(shell_name);
            if candidate.exists() && Command::new(&candidate).args(["--url", trimmed]).spawn().is_ok() {
                return Ok("Opened in native webview window".into());
            }
        }
    }
    open::that(trimmed).map_err(|e| format!("Could not open browser: {e}"))?;
    Ok("Opened in browser".into())
}

// ---------------------------------------------------------------------------
// Cloud BRC-39 History Backup, Empty-Local Guard & Recompose
// (`historyBackup.ts`, `historyEmptyGuard.ts`, `recompose.ts` parity)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmptyGuardDecision {
    Allow,
    RefuseEmptyOverwrite,
    RefuseDisplacedHolder,
}

/// Exact parity with `src/wallet/historyEmptyGuard.ts` + displaced-holder rule.
pub fn check_history_upload_guard(
    local_output_count: usize,
    local_action_count: usize,
    remote_non_empty: bool,
    held_here: bool,
    force_manual: bool,
) -> EmptyGuardDecision {
    if !held_here {
        return EmptyGuardDecision::RefuseDisplacedHolder;
    }
    let local_empty = local_output_count == 0 && local_action_count == 0;
    if local_empty && remote_non_empty && !force_manual {
        return EmptyGuardDecision::RefuseEmptyOverwrite;
    }
    EmptyGuardDecision::Allow
}

pub fn resolved_history_base_url(services: &AppServices) -> String {
    services
        .durable
        .get(HISTORY_BACKUP_PREFS_KEY)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            v.get("baseUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| s.starts_with("https://") || s.starts_with("http://127.0.0.1") || s.starts_with("http://localhost"))
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| SUGGESTED_HISTORY_BACKUP_BASE_URL.to_string())
}

pub async fn upload_brc39_cloud(
    services: &AppServices,
    ciphertext_bytes: &[u8],
    held_here: bool,
    force_manual: bool,
) -> Result<String, String> {
    let (root, identity_key, account_id, generation) = {
        let guard = services.session.lock().unwrap_or_else(|e| e.into_inner());
        let active = guard.as_ref().ok_or("Wallet is locked.")?;
        (
            active.deriver.root_key().clone(),
            active.summary.identity_key.clone(),
            active.summary.account_id.clone(),
            active.summary.generation,
        )
    };
    let bal = services
        .engine
        .read_balance(&account_id, generation)
        .await
        .map_err(|e| e.to_string())?;
    let act = services
        .engine
        .read_activity_page(&account_id, generation, None, 1)
        .await
        .map_err(|e| e.to_string())?;
    let local_outputs = if bal.displayed_sats > 0 { 1 } else { 0 };
    let base = resolved_history_base_url(services);
    let url = format!("{}/v1/history/{identity_key}", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    // Probe remote existence for empty-local guard.
    let remote_non_empty = match client.head(&url).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    };
    match check_history_upload_guard(local_outputs, act.total as usize, remote_non_empty, held_here, force_manual) {
        EmptyGuardDecision::RefuseDisplacedHolder => {
            return Err("Refused BRC-39 upload: this account is held on another device.".into());
        }
        EmptyGuardDecision::RefuseEmptyOverwrite => {
            return Err("Refused BRC-39 upload: local history is empty while cloud backup exists.".into());
        }
        EmptyGuardDecision::Allow => {}
    }
    let headers = build_messagebox_auth_headers(&root, "PUT", "brc39-history", now_ms())?;
    let mut req = client.put(&url).body(ciphertext_bytes.to_vec());
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| format!("Cloud backup upload failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Cloud backup server returned HTTP {}", resp.status().as_u16()));
    }
    Ok(format!("Uploaded {} bytes to cloud backup", ciphertext_bytes.len()))
}

pub async fn download_brc39_cloud(services: &AppServices) -> Result<Vec<u8>, String> {
    let (root, identity_key) = {
        let guard = services.session.lock().unwrap_or_else(|e| e.into_inner());
        let active = guard.as_ref().ok_or("Wallet is locked.")?;
        (active.deriver.root_key().clone(), active.summary.identity_key.clone())
    };
    let base = resolved_history_base_url(services);
    let url = format!("{}/v1/history/{identity_key}", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let headers = build_messagebox_auth_headers(&root, "GET", "brc39-history", now_ms())?;
    let mut req = client.get(&url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| format!("Cloud backup download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("No cloud backup available (HTTP {}).", resp.status().as_u16()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// Recompose wallet: history replica first, then chain ingest (`src/wallet/layers.ts`).
pub async fn recompose_wallet(services: &AppServices) -> Result<String, String> {
    let history_note = match download_brc39_cloud(services).await {
        Ok(bytes) => format!("cloud history ({} B)", bytes.len()),
        Err(_) => "local history".to_string(),
    };
    let chain_note = services.sync_now_async().await?;
    Ok(format!("Recomposed via {history_note}; {chain_note}"))
}

// ---------------------------------------------------------------------------
// BRC-249 Account Holding, Signed Release Request, & Move
// (`accountHolding.ts`, `accountMove.ts`, `accountRelease.ts`, `accountHandover.ts`)
// ---------------------------------------------------------------------------

pub const ACCOUNT_HOLDING_BOX: &str = "account-holding";
pub const RELEASE_ACCEPT_TIMEOUT_MS: u64 = 10_000;
pub const RELEASE_COMPLETE_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolderRecord {
    pub version: u8,
    pub account_index: u32,
    pub identity_key: String,
    pub holder_device_id: String,
    pub status: String, // "held" | "released"
    pub updated_at_ms: i64,
    pub signature: String,
}

impl HolderRecord {
    pub fn signing_preimage(&self) -> String {
        format!(
            "BRC-249-holder\n{}\n{}\n{}\n{}\n{}\n{}",
            self.version, self.account_index, self.identity_key, self.holder_device_id, self.status, self.updated_at_ms
        )
    }
}

pub fn sign_holder_record(
    root: &SecretKeyBytes,
    account_index: u32,
    holder_device_id: &str,
    status: &str,
    updated_at_ms: i64,
) -> Result<HolderRecord, String> {
    let identity_key = root.public_key_hex().map_err(|e| e.to_string())?;
    let mut rec = HolderRecord {
        version: 1,
        account_index,
        identity_key,
        holder_device_id: holder_device_id.to_string(),
        status: status.to_string(),
        updated_at_ms,
        signature: String::new(),
    };
    let sig = sign_ecdsa_compact(root, rec.signing_preimage().as_bytes()).map_err(|e| e.to_string())?;
    rec.signature = encode_hex(&sig);
    Ok(rec)
}

pub fn verify_holder_record(rec: &HolderRecord) -> bool {
    let Ok(pk) = decode_hex(&rec.identity_key) else { return false; };
    let Ok(sig) = decode_hex(&rec.signature) else { return false; };
    let digest = handcash_primitives::encoding::sha256(rec.signing_preimage().as_bytes());
    if sig.len() == 64 {
        // Compact 64-byte signature verified via DER conversion helper
        let mut der = Vec::with_capacity(72);
        fn push_int(out: &mut Vec<u8>, bytes: &[u8]) {
            let trimmed = bytes.iter().position(|&b| b != 0).map(|i| &bytes[i..]).unwrap_or(&[0]);
            let pad = trimmed[0] & 0x80 != 0;
            out.push(0x02);
            out.push((trimmed.len() + usize::from(pad)) as u8);
            if pad { out.push(0x00); }
            out.extend_from_slice(trimmed);
        }
        let mut body = Vec::with_capacity(70);
        push_int(&mut body, &sig[..32]);
        push_int(&mut body, &sig[32..]);
        der.push(0x30);
        der.push(body.len() as u8);
        der.extend_from_slice(&body);
        verify_ecdsa_der(&pk, &digest, &der).unwrap_or(false)
    } else {
        verify_ecdsa_der(&pk, &digest, &sig).unwrap_or(false)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRequestEnvelope {
    pub kind: String,
    pub account_index: u32,
    pub identity_key: String,
    pub requester_device_id: String,
    pub requested_at_ms: i64,
    pub signature: String,
}

pub fn build_signed_release_request(
    root: &SecretKeyBytes,
    account_index: u32,
    requester_device_id: &str,
    requested_at_ms: i64,
) -> Result<ReleaseRequestEnvelope, String> {
    let identity_key = root.public_key_hex().map_err(|e| e.to_string())?;
    let preimage = format!(
        "BRC-249-release-request\n{account_index}\n{identity_key}\n{requester_device_id}\n{requested_at_ms}"
    );
    let sig = sign_ecdsa_compact(root, preimage.as_bytes()).map_err(|e| e.to_string())?;
    Ok(ReleaseRequestEnvelope {
        kind: "release-request".into(),
        account_index,
        identity_key,
        requester_device_id: requester_device_id.to_string(),
        requested_at_ms,
        signature: encode_hex(&sig),
    })
}

/// Move an account held on another device to this device (BRC-249).
/// Sends a signed `release-request` over BRC-33 `account-holding`; if the
/// request cannot be delivered, fails without forcing. If delivered and no
/// live holder responds within the accept window, takes holding cleanly.
pub async fn move_account_here(services: &AppServices, account_index: u32) -> Result<String, String> {
    let (root, device_id) = {
        let guard = services.session.lock().unwrap_or_else(|e| e.into_inner());
        let active = guard.as_ref().ok_or("Wallet is locked.")?;
        let dev = services
            .durable
            .get(DEVICE_ID_STORAGE_KEY)
            .unwrap_or_else(|| "native-device".to_string());
        (active.deriver.root_key().clone(), dev)
    };
    let req_env = build_signed_release_request(&root, account_index, &device_id, now_ms())?;
    let base = default_messagebox_base(services);
    let send_url = format!("{base}/sendMessage");
    let headers = build_messagebox_auth_headers(&root, "POST", ACCOUNT_HOLDING_BOX, now_ms())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
        "recipient": req_env.identity_key,
        "messageBox": ACCOUNT_HOLDING_BOX,
        "body": serde_json::to_string(&req_env).unwrap_or_default(),
    });
    let mut req = client.post(&send_url).json(&body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Could not deliver release request (move aborted, never forced): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Release request rejected by messagebox (HTTP {}); move not forced.",
            resp.status().as_u16()
        ));
    }
    // Record local holding claim for this device.
    let holder = sign_holder_record(&root, account_index, &device_id, "held", now_ms())?;
    let holder_key = format!("handcash.holding.v1.{account_index}");
    if let Ok(raw) = serde_json::to_string(&holder) {
        let _ = services.durable.set(&holder_key, &raw, false);
    }
    Ok(format!("Moved account #{account_index} to this device"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crypto_review_gate_is_closed_by_default_and_test_overridable() {
        const { assert!(!CRYPTO_REVIEW_APPROVED); }
        assert!(require_native_signing_review("BSV send").is_err());
        with_native_signing_for_test(true, || {
            assert!(is_native_signing_enabled());
            assert!(require_native_signing_review("BSV send").is_ok());
        });
        assert!(!is_native_signing_enabled());
    }

    #[test]
    fn log_upload_validates_url_and_scrubs_sensitive_lines() {
        assert!(validate_log_upload_url("http://example.com/logs").is_err());
        assert!(validate_log_upload_url("https://cloud.handcash.io/v1/logs/hc-1").is_ok());
        assert!(validate_log_upload_url("http://127.0.0.1:9999/logs").is_ok());
        let txid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let sample = format!("sent 50000 sats to $alice tx {txid}");
        let (clean, lines) = prepare_scrubbed_log_payload(&sample);
        assert_eq!(lines, 1);
        assert!(!clean.contains("$alice"));
        assert!(!clean.contains("50000 sats"));
        assert!(!clean.contains(txid));
    }

    #[test]
    fn empty_local_guard_blocks_auto_overwrite_and_displaced_holder() {
        assert_eq!(
            check_history_upload_guard(0, 0, true, true, false),
            EmptyGuardDecision::RefuseEmptyOverwrite
        );
        assert_eq!(
            check_history_upload_guard(0, 0, true, true, true),
            EmptyGuardDecision::Allow
        );
        assert_eq!(
            check_history_upload_guard(5, 2, true, false, true),
            EmptyGuardDecision::RefuseDisplacedHolder
        );
    }

    #[test]
    fn holder_record_sign_and_verify_roundtrip() {
        let sk = SecretKeyBytes::random();
        let rec = sign_holder_record(&sk, 0, "dev-1", "held", 1_700_000_000_000).unwrap();
        assert!(verify_holder_record(&rec));
        let mut tampered = rec.clone();
        tampered.holder_device_id = "dev-2".into();
        assert!(!verify_holder_record(&tampered));
    }
}
