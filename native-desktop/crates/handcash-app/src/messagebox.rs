// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure-Rust BRC-33 messagebox client for peer identity card exchange
//! (`handcash-identity-card:` / `handcash-identity-card-request:v1`) and
//! vault-scoped encrypted identity bundle sync (`vault-identities` own-box).
//! Wire-compatible with `src/wallet/messageboxAuth.ts`, `messageEnvelope.ts`,
//! `identityCard.ts`, `identityCardShare.ts`, and `identityPeerSync.ts`.

use crate::device_peer::{
    export_local_identity_bundle_with_limit, merge_remote_identity_bundle, IdentityMergeStats,
};
use crate::health::PUBLIC_BRC_CLOUD_ORIGIN;
use crate::state::{AppServices, SessionSummary};
use base64::Engine as _;
use handcash_bitcoin::issuer::{
    normalize_bap_id, normalize_issuer_identity_key, verify_and_decrypt_profile_certificate,
    verify_issuer_identity_package,
};
use handcash_primitives::encoding::{decode_hex, encode_hex, sha256};
use handcash_primitives::keys::{
    anyone_private_key, brc78_decrypt, brc78_encrypt, p2pkh_address_from_pubkey,
    sign_ecdsa_compact, sign_ecdsa_der, verify_bsm, verify_ecdsa_der, Counterparty, KeyDeriver,
    SecretKeyBytes,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const IDENTITY_CARD_PREFIX: &str = "handcash-identity-card:";
pub const IDENTITY_CARD_REQUEST: &str = "handcash-identity-card-request:v1";
pub const VAULT_IDENTITIES_BOX: &str = "vault-identities";
const WALLET_CONFIG_KEY: &str = "handcash.brc100.walletConfig.v1";
const PEER_ENVELOPE_VERSION: &str = "1.0";
const MAX_CARD_WIRE_CHARS: usize = 240_000;
const MAX_OWN_BOX_BUNDLE_BYTES: usize = 180_000;
const FUTURE_SKEW_MS: i64 = 10 * 60 * 1000;
const CARD_REQUEST_COOLDOWN_MS: i64 = 10 * 60 * 1000;
const OWN_BOX_STALE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PROTOCOL_CARD_V1: (u8, &str) = (2, "bap identity card");
const PROTOCOL_CARD_V2: (u8, &str) = (2, "identity card");
const CARD_KEY_ID: &str = "1";

static LAST_CARD_REQUESTED: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
static LAST_PUSHED_BUNDLE_HASH: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Format Unix epoch milliseconds as canonical ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`),
/// matching JS `new Date(ms).toISOString()`.
pub fn iso_utc_from_ms(ms: i64) -> String {
    let clamped = ms.max(0);
    let millis = clamped % 1000;
    let total_secs = clamped / 1000;
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let total_hours = total_mins / 60;
    let hours = total_hours % 24;
    let days = total_hours / 24;
    // Howard Hinnant's civil-from-days algorithm (exact for all proleptic Gregorian dates).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{m:02}-{d:02}T{hours:02}:{mins:02}:{secs:02}.{millis:03}Z"
    )
}

/// Parse canonical ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS(.mmm)?Z`) into epoch milliseconds.
fn parse_iso_utc_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if !s.ends_with('Z') || s.len() < 20 {
        return None;
    }
    let body = &s[..s.len() - 1];
    let (date_part, time_part) = body.split_once('T')?;
    let mut dp = date_part.split('-');
    let year: i64 = dp.next()?.parse().ok()?;
    let month: u32 = dp.next()?.parse().ok()?;
    let day: u32 = dp.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hms, frac) = match time_part.split_once('.') {
        Some((a, b)) => (a, b),
        None => (time_part, "0"),
    };
    let mut tp = hms.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let min: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;
    if hour > 23 || min > 59 || sec > 59 {
        return None;
    }
    let mut ms_str = frac.chars().take(3).collect::<String>();
    while ms_str.len() < 3 {
        ms_str.push('0');
    }
    let millis: i64 = ms_str.parse().ok()?;
    // Days from civil (inverse of civil_from_days)
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m_adj = if month > 2 { month - 3 } else { month + 9 } as u64;
    let doy = (153 * m_adj + 2) / 5 + (day as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + (doe as i64) - 719_468;
    Some((((days * 24 + hour) * 60 + min) * 60 + sec) * 1000 + millis)
}

/// Resolve default BRC-33 messagebox base URL from `walletConfig.v1` or `PUBLIC_BRC_CLOUD_ORIGIN`.
pub fn default_messagebox_base(services: &AppServices) -> String {
    let origin = services
        .durable
        .get(WALLET_CONFIG_KEY)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            v.get("historyBaseUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| PUBLIC_BRC_CLOUD_ORIGIN.to_string());
    let trimmed = origin.trim_end_matches('/');
    if trimmed.ends_with("/messagebox") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1/messagebox")
    }
}

/// Build exact `X-BRC33-*` and `X-BRC103-*` auth headers matching `src/wallet/messageboxAuth.ts`.
pub fn build_messagebox_auth_headers(
    root: &SecretKeyBytes,
    method: &str,
    message_box: &str,
    timestamp_ms: i64,
) -> Result<Vec<(&'static str, String)>, String> {
    let ik = root.public_key_hex().map_err(|e| e.to_string())?;
    let nonce_key = SecretKeyBytes::random();
    let nonce = encode_hex(&nonce_key.as_bytes()[..16]);
    let preimage = format!("BRC-33-lite\n{method}\n{message_box}\n{timestamp_ms}");
    let authrite_preimage =
        format!("BRC-103-identity\n{method}\n{message_box}\n{timestamp_ms}\n{nonce}");
    let sig = sign_ecdsa_compact(root, preimage.as_bytes()).map_err(|e| e.to_string())?;
    let authrite_sig =
        sign_ecdsa_compact(root, authrite_preimage.as_bytes()).map_err(|e| e.to_string())?;
    Ok(vec![
        ("X-BRC33-Identity", ik.clone()),
        ("X-BRC33-Timestamp", timestamp_ms.to_string()),
        ("X-BRC33-Signature", encode_hex(&sig)),
        ("X-BRC103-Identity", ik),
        ("X-BRC103-Timestamp", timestamp_ms.to_string()),
        ("X-BRC103-Nonce", nonce),
        ("X-BRC103-Signature", encode_hex(&authrite_sig)),
    ])
}

/// RFC 8785 deterministic JSON serialization matching `canonicalizeJson` in `messageEnvelope.ts`.
pub fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonicalize_json).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    let k_json = serde_json::to_string(k).unwrap_or_else(|_| "\"\"".into());
                    format!("{k_json}:{}", canonicalize_json(&map[k]))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Seal a BRC-169 §7 + BRC-78 peer envelope matching `sealPeerMessage` in `messageEnvelope.ts`.
pub fn seal_peer_message(
    sender: &SecretKeyBytes,
    recipient_identity_key: &str,
    plaintext: &str,
    created_iso: &str,
) -> Result<String, String> {
    let sender_ik = sender.public_key_hex().map_err(|e| e.to_string())?;
    let recipient_ik = normalize_issuer_identity_key(recipient_identity_key)
        .ok_or_else(|| "Invalid recipient identity key".to_string())?;
    let cipher = brc78_encrypt(plaintext.as_bytes(), sender, &recipient_ik)
        .map_err(|e| e.to_string())?;
    let meta = json!({
        "metanetHandles": PEER_ENVELOPE_VERSION,
        "recipient": { "identityKey": recipient_ik },
        "sender": { "identityKey": sender_ik },
        "created": created_iso,
        "payment": Value::Null,
    });
    let preimage = canonicalize_json(&meta);
    let digest = sha256(preimage.as_bytes());
    let sig_der = sign_ecdsa_der(sender, &digest).map_err(|e| e.to_string())?;
    let env = json!({
        "metanetHandles": PEER_ENVELOPE_VERSION,
        "recipient": { "identityKey": recipient_ik },
        "sender": { "identityKey": sender_ik },
        "created": created_iso,
        "payment": Value::Null,
        "content": base64::engine::general_purpose::STANDARD.encode(cipher),
        "signature": encode_hex(&sig_der),
    });
    serde_json::to_string(&env).map_err(|e| e.to_string())
}

/// Open a BRC-169 §7 + BRC-78 peer envelope matching `openPeerMessage` in `messageEnvelope.ts`.
/// Returns `Some((plaintext, sealed))`; returns `None` if an envelope fails signature/recipient/decrypt verification.
pub fn open_peer_message(
    recipient: &SecretKeyBytes,
    body: &str,
    expected_sender: Option<&str>,
) -> Option<(String, bool)> {
    let trimmed = body.trim();
    let parsed = if trimmed.starts_with('{') {
        serde_json::from_str::<Value>(trimmed).ok()
    } else {
        None
    };
    let is_envelope = parsed.as_ref().is_some_and(|v| {
        v.get("metanetHandles").and_then(Value::as_str) == Some(PEER_ENVELOPE_VERSION)
            && v.get("content").and_then(Value::as_str).is_some()
            && v.get("signature").and_then(Value::as_str).is_some()
            && v.get("sender")
                .and_then(|s| s.get("identityKey"))
                .and_then(Value::as_str)
                .is_some()
            && v.get("recipient")
                .and_then(|r| r.get("identityKey"))
                .and_then(Value::as_str)
                .is_some()
    });
    if !is_envelope {
        return Some((body.to_string(), false));
    }
    let env = parsed?;
    let recipient_ik = normalize_issuer_identity_key(
        env.get("recipient")?.get("identityKey")?.as_str()?,
    )?;
    let sender_ik =
        normalize_issuer_identity_key(env.get("sender")?.get("identityKey")?.as_str()?)?;
    if let Some(exp) = expected_sender {
        if normalize_issuer_identity_key(exp).as_deref() != Some(sender_ik.as_str()) {
            return None;
        }
    }
    let self_ik = recipient.public_key_hex().ok()?;
    if recipient_ik != self_ik {
        return None;
    }
    let created = env.get("created")?.as_str()?;
    if !env.get("payment").is_some_and(Value::is_null) {
        return None;
    }
    let sig_hex = env.get("signature")?.as_str()?;
    let sig_der = decode_hex(sig_hex).ok()?;
    let sender_pub_bytes = decode_hex(&sender_ik).ok()?;
    let meta = json!({
        "metanetHandles": PEER_ENVELOPE_VERSION,
        "recipient": { "identityKey": recipient_ik },
        "sender": { "identityKey": sender_ik },
        "created": created,
        "payment": Value::Null,
    });
    let digest = sha256(canonicalize_json(&meta).as_bytes());
    if !verify_ecdsa_der(&sender_pub_bytes, &digest, &sig_der).unwrap_or(false) {
        return None;
    }
    let content_b64 = env.get("content")?.as_str()?;
    let ct = base64::engine::general_purpose::STANDARD
        .decode(content_b64)
        .ok()?;
    let pt = brc78_decrypt(&ct, recipient).ok()?;
    let text = String::from_utf8(pt).ok()?;
    Some((text, true))
}

fn card_statement_bytes(v: u64, identity_key: &str, target_key: &str, target_val: Value, issued_at: &str) -> Vec<u8> {
    // Exact field order matching TS `identityCardStatement` (`JSON.stringify({ v, identityKey, presents|bapId, issuedAt })`).
    let target_json = serde_json::to_string(&target_val).unwrap_or_else(|_| "null".into());
    let ik_json = serde_json::to_string(identity_key).unwrap_or_else(|_| "\"\"".into());
    let ts_json = serde_json::to_string(issued_at).unwrap_or_else(|_| "\"\"".into());
    format!("{{{{\"v\":{v},\"identityKey\":{ik_json},\"{target_key}\":{target_json},\"issuedAt\":{ts_json}}}}}").into_bytes()
}

fn verify_card_brc3(version: u64, statement: &[u8], signer_ik: &str, sig_hex: &str) -> bool {
    let Ok(sig_der) = decode_hex(sig_hex) else {
        return false;
    };
    let protocol = if version == 1 {
        PROTOCOL_CARD_V1
    } else {
        PROTOCOL_CARD_V2
    };
    let anyone = KeyDeriver::new(anyone_private_key());
    anyone
        .verify_signature(
            protocol,
            CARD_KEY_ID,
            Counterparty::PublicKeyHex(signer_ik.to_string()),
            false,
            Some(statement),
            None,
            &sig_der,
        )
        .unwrap_or(false)
}

/// Store a verified self-published BRC-248 profile if newer than any stored entry.
fn store_verified_profile(
    services: &AppServices,
    chain: &str,
    verified: &handcash_bitcoin::issuer::VerifiedSelfProfile,
    now: i64,
) -> bool {
    let ik = &verified.identity_key;
    let entry_key = format!("handcash.identityProfiles.v1:{chain}:{ik}");
    let existing_issued = services
        .durable
        .get(&entry_key)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v.get("issuedAt").and_then(Value::as_str).map(ToString::to_string));
    if let Some(ref prev) = existing_issued {
        if !prev.is_empty() && prev.as_str() >= verified.issued_at.as_str() {
            return false;
        }
    }
    let mut rec = serde_json::Map::new();
    rec.insert("certificate".into(), verified.certificate.clone());
    if let Some(ref img) = verified.image {
        rec.insert("image".into(), img.clone());
    }
    let stored = json!({
        "record": Value::Object(rec),
        "name": verified.name,
        "description": verified.description,
        "issuedAt": verified.issued_at,
    });
    let Ok(raw) = serde_json::to_string(&stored) else {
        return false;
    };
    if !services.durable.set(&entry_key, &raw, false) {
        return false;
    }
    let idx_key = format!("handcash.identityProfiles.v1:{chain}");
    let mut idx = services
        .durable
        .get(&idx_key)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .unwrap_or_else(|| json!({ "version": 1, "entries": [] }));
    if let Some(entries) = idx.get_mut("entries").and_then(Value::as_array_mut) {
        let was_pinned = entries
            .iter()
            .find(|e| e.get("identityKey").and_then(Value::as_str) == Some(ik.as_str()))
            .and_then(|e| e.get("pinned").and_then(Value::as_bool))
            .unwrap_or(false);
        entries.retain(|e| e.get("identityKey").and_then(Value::as_str) != Some(ik.as_str()));
        let mut row = json!({ "identityKey": ik, "storedAt": now });
        if was_pinned {
            row["pinned"] = Value::Bool(true);
        }
        entries.push(row);
        if let Ok(idx_raw) = serde_json::to_string(&idx) {
            let _ = services.durable.set(&idx_key, &idx_raw, false);
        }
    }
    true
}

/// Store a verified BAP issuer package (`{ v: 1, bapId, beefB64 }`).
fn store_verified_bap_package(
    services: &AppServices,
    chain: &str,
    pkg: &Value,
    now: i64,
) -> Option<handcash_bitcoin::issuer::VerifiedBapIdentity> {
    let verified = verify_issuer_identity_package(pkg)?;
    let bap_id = &verified.bap_id;
    let entry_key = format!("handcash.issuerIdentities.v1:{chain}:{bap_id}");
    let raw = serde_json::to_string(pkg).ok()?;
    if services.durable.get(&entry_key).as_deref() != Some(raw.as_str())
        && services.durable.set(&entry_key, &raw, false)
    {
        let idx_key = format!("handcash.issuerIdentities.v1:{chain}");
        let mut idx = services
            .durable
            .get(&idx_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| json!({ "version": 1, "entries": [] }));
        if let Some(entries) = idx.get_mut("entries").and_then(Value::as_array_mut) {
            let was_pinned = entries
                .iter()
                .find(|e| e.get("bapId").and_then(Value::as_str) == Some(bap_id.as_str()))
                .and_then(|e| e.get("pinned").and_then(Value::as_bool))
                .unwrap_or(false);
            entries.retain(|e| e.get("bapId").and_then(Value::as_str) != Some(bap_id.as_str()));
            let mut row = json!({ "bapId": bap_id, "storedAt": now });
            if was_pinned {
                row["pinned"] = Value::Bool(true);
            }
            entries.push(row);
            if let Ok(idx_raw) = serde_json::to_string(&idx) {
                let _ = services.durable.set(&idx_key, &idx_raw, false);
            }
        }
    }
    Some(verified)
}

/// Ingest a delivered v1 BAP or v2 BRC-248 `IdentityKeyPackage` (from identity card or payment `meta.identities`).
pub fn ingest_delivered_identity_package(
    services: &AppServices,
    chain: &str,
    pkg: &Value,
    now: i64,
) -> IdentityMergeStats {
    let mut stats = IdentityMergeStats::default();
    match pkg.get("v").and_then(Value::as_u64) {
        Some(1) => {
            if store_verified_bap_package(services, chain, pkg, now).is_some() {
                stats.bap_packages_added += 1;
            }
        }
        Some(2) => {
            let Some(ik) = pkg
                .get("identityKey")
                .and_then(Value::as_str)
                .and_then(normalize_issuer_identity_key)
            else {
                return stats;
            };
            let images = pkg
                .get("images")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(certs) = pkg.get("certificates").and_then(Value::as_array) {
                let mut best: Option<handcash_bitcoin::issuer::VerifiedSelfProfile> = None;
                for cert in certs.iter().take(8) {
                    if let Some(v) = verify_and_decrypt_profile_certificate(&ik, cert, &images) {
                        if best
                            .as_ref()
                            .is_none_or(|b| v.issued_at > b.issued_at)
                        {
                            best = Some(v);
                        }
                    }
                }
                if let Some(verified) = best {
                    if store_verified_profile(services, chain, &verified, now) {
                        stats.profiles_added += 1;
                    }
                }
            }
            if let Some(bap_obj) = pkg.get("bap").and_then(Value::as_object) {
                if let (Some(bap_id), Some(beef_b64)) = (
                    bap_obj.get("bapId").and_then(Value::as_str),
                    bap_obj.get("beefB64").and_then(Value::as_str),
                ) {
                    let wrapped = json!({ "v": 1, "bapId": bap_id, "beefB64": beef_b64 });
                    if store_verified_bap_package(services, chain, &wrapped, now).is_some() {
                        stats.bap_packages_added += 1;
                    }
                }
            }
        }
        _ => {}
    }
    stats
}

/// Verify and store a v1 or v2 `IdentityCard` (1:1 with `rememberIdentityCard` in `identityCard.ts`).
pub fn ingest_identity_card(
    services: &AppServices,
    chain: &str,
    raw: &Value,
    expected_sender: Option<&str>,
) -> IdentityMergeStats {
    let mut stats = IdentityMergeStats::default();
    let Some(version) = raw.get("v").and_then(Value::as_u64) else {
        return stats;
    };
    if version != 1 && version != 2 {
        return stats;
    }
    let Some(identity_key) = raw
        .get("identityKey")
        .and_then(Value::as_str)
        .and_then(normalize_issuer_identity_key)
    else {
        return stats;
    };
    if let Some(exp) = expected_sender {
        if normalize_issuer_identity_key(exp).as_deref() != Some(identity_key.as_str()) {
            return stats;
        }
    }
    let Some(issued_at) = raw.get("issuedAt").and_then(Value::as_str) else {
        return stats;
    };
    let Some(issued_ms) = parse_iso_utc_ms(issued_at) else {
        return stats;
    };
    let now = now_ms();
    if issued_ms > now + FUTURE_SKEW_MS {
        return stats;
    }
    let Some(id_sig) = raw.get("identitySignature").and_then(Value::as_str) else {
        return stats;
    };

    let cards_key = format!("handcash.identityCards.v1:{chain}");
    let mut cards_doc = services
        .durable
        .get(&cards_key)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .unwrap_or_else(|| json!({ "version": 1, "links": {} }));
    if let Some(prior_issued) = cards_doc
        .get("links")
        .and_then(|l| l.get(&identity_key))
        .and_then(|r| r.get("issuedAt"))
        .and_then(Value::as_str)
    {
        if let Some(prior_ms) = parse_iso_utc_ms(prior_issued) {
            if issued_ms < prior_ms {
                return stats;
            }
        }
    }

    if version == 2 {
        let presents = raw.get("presents");
        if presents.is_some_and(Value::is_null) {
            let stmt = card_statement_bytes(2, &identity_key, "presents", Value::Null, issued_at);
            if !verify_card_brc3(2, &stmt, &identity_key, id_sig) {
                return stats;
            }
            if let Some(links) = cards_doc.get_mut("links").and_then(Value::as_object_mut) {
                links.insert(
                    identity_key,
                    json!({ "issuedAt": issued_at, "receivedAt": now }),
                );
                if let Ok(s) = serde_json::to_string(&cards_doc) {
                    let _ = services.durable.set(&cards_key, &s, false);
                }
                stats.cards_added += 1;
            }
            return stats;
        }
        let Some(presents_ik) = presents
            .and_then(Value::as_str)
            .and_then(normalize_issuer_identity_key)
        else {
            return stats;
        };
        let stmt = card_statement_bytes(
            2,
            &identity_key,
            "presents",
            Value::String(presents_ik.clone()),
            issued_at,
        );
        if !verify_card_brc3(2, &stmt, &identity_key, id_sig) {
            return stats;
        }
        if presents_ik != identity_key {
            let Some(pres_sig) = raw.get("presentedSignature").and_then(Value::as_str) else {
                return stats;
            };
            if !verify_card_brc3(2, &stmt, &presents_ik, pres_sig) {
                return stats;
            }
        }
        let Some(pkg) = raw.get("package") else {
            return stats;
        };
        if pkg
            .get("identityKey")
            .and_then(Value::as_str)
            .and_then(normalize_issuer_identity_key)
            .as_deref()
            != Some(presents_ik.as_str())
        {
            return stats;
        }
        let pkg_stats = ingest_delivered_identity_package(services, chain, pkg, now);
        stats.profiles_added += pkg_stats.profiles_added;
        stats.bap_packages_added += pkg_stats.bap_packages_added;
        let has_resolved = services.identity_profile_for(chain, &presents_ik).is_some()
            || services
                .linked_bap_identity_for_key(chain, &presents_ik)
                .is_some();
        if !has_resolved {
            return stats;
        }
        if let Some(links) = cards_doc.get_mut("links").and_then(Value::as_object_mut) {
            let changed = links
                .get(&identity_key)
                .and_then(|p| p.get("issuedAt").and_then(Value::as_str))
                != Some(issued_at)
                || links
                    .get(&identity_key)
                    .and_then(|p| p.get("key").and_then(Value::as_str))
                    != Some(presents_ik.as_str());
            links.insert(
                identity_key,
                json!({ "key": presents_ik, "issuedAt": issued_at, "receivedAt": now }),
            );
            if let Ok(s) = serde_json::to_string(&cards_doc) {
                let _ = services.durable.set(&cards_key, &s, false);
            }
            if changed {
                stats.cards_added += 1;
            }
        }
        return stats;
    }

    // Version 1 card (presents a BAP ID countersigned by its active BAP key).
    let bap_val = raw.get("bapId");
    if bap_val.is_some_and(Value::is_null) {
        let stmt = card_statement_bytes(1, &identity_key, "bapId", Value::Null, issued_at);
        if !verify_card_brc3(1, &stmt, &identity_key, id_sig) {
            return stats;
        }
        if let Some(links) = cards_doc.get_mut("links").and_then(Value::as_object_mut) {
            links.insert(
                identity_key,
                json!({ "issuedAt": issued_at, "receivedAt": now }),
            );
            if let Ok(s) = serde_json::to_string(&cards_doc) {
                let _ = services.durable.set(&cards_key, &s, false);
            }
            stats.cards_added += 1;
        }
        return stats;
    }
    let Some(bap_id) = bap_val.and_then(Value::as_str).and_then(normalize_bap_id) else {
        return stats;
    };
    let Some(bap_signer) = raw
        .get("bapSigner")
        .and_then(Value::as_str)
        .and_then(normalize_issuer_identity_key)
    else {
        return stats;
    };
    let Some(bap_sig_b64) = raw.get("bapSignature").and_then(Value::as_str) else {
        return stats;
    };
    let Ok(bap_sig) = base64::engine::general_purpose::STANDARD.decode(bap_sig_b64) else {
        return stats;
    };
    let Ok(bap_signer_bytes) = decode_hex(&bap_signer) else {
        return stats;
    };
    let signer_addr = p2pkh_address_from_pubkey(&bap_signer_bytes, false);
    let stmt = card_statement_bytes(1, &identity_key, "bapId", Value::String(bap_id.clone()), issued_at);
    if !verify_card_brc3(1, &stmt, &identity_key, id_sig)
        || !verify_bsm(&stmt, &bap_sig, &signer_addr)
    {
        return stats;
    }
    let Some(pkg) = raw.get("package") else {
        return stats;
    };
    let Some(verified_bap) = store_verified_bap_package(services, chain, pkg, now) else {
        return stats;
    };
    if verified_bap.bap_id != bap_id
        || verified_bap.revoked
        || verified_bap.active_address != signer_addr
    {
        return stats;
    }
    stats.bap_packages_added += 1;
    if let Some(links) = cards_doc.get_mut("links").and_then(Value::as_object_mut) {
        links.insert(
            identity_key,
            json!({ "bapId": bap_id, "issuedAt": issued_at, "receivedAt": now }),
        );
        if let Ok(s) = serde_json::to_string(&cards_doc) {
            let _ = services.durable.set(&cards_key, &s, false);
        }
        stats.cards_added += 1;
    }
    stats
}

/// Build a signed v2 `IdentityCard` for the active account so we can answer sibling/friend card requests.
pub fn build_own_identity_card_v2(
    services: &AppServices,
    root: &SecretKeyBytes,
    summary: &SessionSummary,
) -> Option<Value> {
    let ik = root.public_key_hex().ok()?;
    let chain = &summary.chain;
    let prof_key = format!("handcash.identityProfiles.v1:{chain}:{ik}");
    let prof_stored = services
        .durable
        .get(&prof_key)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok());
    let bap_pkg = services
        .list_public_identities_view(summary)
        .rows
        .into_iter()
        .find(|r| r.identity_key.eq_ignore_ascii_case(&ik) && r.bap_published)
        .and_then(|r| {
            let entry_key = format!("handcash.issuerIdentities.v1:{chain}:{}", r.bap_id);
            services
                .durable
                .get(&entry_key)
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        });
    if prof_stored.is_none() && bap_pkg.is_none() {
        return None;
    }
    let mut pkg = serde_json::Map::new();
    pkg.insert("v".into(), Value::from(2));
    pkg.insert("identityKey".into(), Value::String(ik.clone()));
    let mut issued_at = iso_utc_from_ms(now_ms());
    if let Some(ref ps) = prof_stored {
        if let Some(ts) = ps.get("issuedAt").and_then(Value::as_str) {
            if parse_iso_utc_ms(ts).is_some() {
                issued_at = ts.to_string();
            }
        }
        if let Some(rec) = ps.get("record") {
            if let Some(cert) = rec.get("certificate") {
                // Only attach certificates that pass real BRC-52 verification
                let imgs: Vec<Value> = rec.get("image").cloned().into_iter().collect();
                if verify_and_decrypt_profile_certificate(&ik, cert, &imgs).is_some() {
                    pkg.insert("certificates".into(), Value::Array(vec![cert.clone()]));
                    if !imgs.is_empty() {
                        pkg.insert("images".into(), Value::Array(imgs));
                    }
                }
            }
        }
    }
    if let Some(ref bp) = bap_pkg {
        if let (Some(bap_id), Some(beef_b64)) = (
            bp.get("bapId").and_then(Value::as_str),
            bp.get("beefB64").and_then(Value::as_str),
        ) {
            pkg.insert(
                "bap".into(),
                json!({ "bapId": bap_id, "beefB64": beef_b64 }),
            );
        }
    }
    if !pkg.contains_key("certificates") && !pkg.contains_key("bap") {
        return None;
    }
    let stmt = card_statement_bytes(2, &ik, "presents", Value::String(ik.clone()), &issued_at);
    let kd = KeyDeriver::new(root.clone());
    let sig_der = kd
        .create_signature(
            PROTOCOL_CARD_V2,
            CARD_KEY_ID,
            Counterparty::Anyone,
            Some(&stmt),
            None,
        )
        .ok()?;
    let mut card = json!({
        "v": 2,
        "identityKey": ik,
        "presents": ik,
        "issuedAt": issued_at,
        "identitySignature": encode_hex(&sig_der),
        "package": Value::Object(pkg.clone()),
    });
    if format!("{IDENTITY_CARD_PREFIX}{card}").len() > MAX_CARD_WIRE_CHARS {
        pkg.remove("bap");
        if !pkg.contains_key("certificates") {
            return None;
        }
        card["package"] = Value::Object(pkg);
    }
    Some(card)
}

async fn list_messages(
    client: &reqwest::Client,
    base_url: &str,
    root: &SecretKeyBytes,
    message_box: &str,
) -> Option<Vec<Value>> {
    let headers = build_messagebox_auth_headers(root, "listMessages", message_box, now_ms()).ok()?;
    let mut req = client
        .post(format!("{base_url}/listMessages"))
        .header("content-type", "application/json")
        .header("accept", "application/json");
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .json(&json!({ "messageBox": message_box }))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let val = resp.json::<Value>().await.ok()?;
    val.get("messages").and_then(Value::as_array).cloned()
}

async fn send_message(
    client: &reqwest::Client,
    base_url: &str,
    root: &SecretKeyBytes,
    recipient: &str,
    message_box: &str,
    body: &str,
) -> bool {
    let Ok(headers) = build_messagebox_auth_headers(root, "sendMessage", message_box, now_ms())
    else {
        return false;
    };
    let mut req = client
        .post(format!("{base_url}/sendMessage"))
        .header("content-type", "application/json")
        .header("accept", "application/json");
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let Ok(resp) = req
        .json(&json!({
            "message": {
                "recipient": recipient.trim().to_ascii_lowercase(),
                "messageBox": message_box,
                "body": body,
            }
        }))
        .send()
        .await
    else {
        return false;
    };
    resp.status().is_success()
}

async fn acknowledge_messages(
    client: &reqwest::Client,
    base_url: &str,
    root: &SecretKeyBytes,
    message_box: &str,
    message_ids: &[String],
) {
    if message_ids.is_empty() {
        return;
    }
    let Ok(headers) =
        build_messagebox_auth_headers(root, "acknowledgeMessage", message_box, now_ms())
    else {
        return;
    };
    let mut req = client
        .post(format!("{base_url}/acknowledgeMessage"))
        .header("content-type", "application/json")
        .header("accept", "application/json");
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let _ = req
        .json(&json!({ "messageBox": message_box, "messageIds": message_ids }))
        .send()
        .await;
}

fn listed_sender(msg: &Value) -> Option<String> {
    msg.get("sender")
        .or_else(|| msg.get("senderIdentityKey"))
        .and_then(Value::as_str)
        .and_then(normalize_issuer_identity_key)
}

/// Poll `inbox` of the active (locally held) account for identity cards, card requests,
/// and passive `meta.identities` inside payment messages. Never ACKs non-card messages.
async fn poll_active_inbox_cards(
    services: &Arc<AppServices>,
    client: &reqwest::Client,
    base_url: &str,
    active_root: &SecretKeyBytes,
    summary: &SessionSummary,
    known_peers: &HashSet<String>,
) -> IdentityMergeStats {
    let mut stats = IdentityMergeStats::default();
    let Some(messages) = list_messages(client, base_url, active_root, "inbox").await else {
        return stats;
    };
    let mut ack_ids: Vec<String> = Vec::new();
    for m in messages {
        let msg_id = m
            .get("messageId")
            .and_then(|v| v.as_str().map(ToString::to_string).or_else(|| v.as_i64().map(|n| n.to_string())));
        let Some(body) = m.get("body").and_then(Value::as_str) else {
            continue;
        };
        let sender = listed_sender(&m);
        let Some((inner, _sealed)) = open_peer_message(active_root, body, sender.as_deref()) else {
            continue;
        };
        if inner == IDENTITY_CARD_REQUEST {
            if let Some(ref peer_ik) = sender {
                if known_peers.contains(peer_ik) {
                    if let Some(card) = build_own_identity_card_v2(services, active_root, summary) {
                        let wire = format!("{IDENTITY_CARD_PREFIX}{card}");
                        if let Ok(sealed) =
                            seal_peer_message(active_root, peer_ik, &wire, &iso_utc_from_ms(now_ms()))
                        {
                            let _ = send_message(client, base_url, active_root, peer_ik, "inbox", &sealed).await;
                        }
                    }
                }
            }
            if let Some(id) = msg_id {
                ack_ids.push(id);
            }
            continue;
        }
        if let Some(card_json) = inner.strip_prefix(IDENTITY_CARD_PREFIX) {
            if inner.len() <= MAX_CARD_WIRE_CHARS {
                if let Ok(card_val) = serde_json::from_str::<Value>(card_json) {
                    let merged =
                        ingest_identity_card(services, &summary.chain, &card_val, sender.as_deref());
                    stats.profiles_added += merged.profiles_added;
                    stats.bap_packages_added += merged.bap_packages_added;
                    stats.cards_added += merged.cards_added;
                }
            }
            if let Some(id) = msg_id {
                ack_ids.push(id);
            }
            continue;
        }
        // Passively extract `meta.identities` from `handcash-message:` without ACKing the message.
        if let Some(payload_json) = inner.strip_prefix("handcash-message:") {
            if let Ok(payload) = serde_json::from_str::<Value>(payload_json) {
                if let Some(ids) = payload.get("identities").and_then(Value::as_array) {
                    let now = now_ms();
                    for entry in ids {
                        let merged = ingest_delivered_identity_package(services, &summary.chain, entry, now);
                        stats.profiles_added += merged.profiles_added;
                        stats.bap_packages_added += merged.bap_packages_added;
                    }
                }
            }
        }
    }
    if !ack_ids.is_empty() {
        acknowledge_messages(client, base_url, active_root, "inbox", &ack_ids).await;
    }
    stats
}

/// Sync identity profiles, BAP packages, and card links across connected same-vault devices
/// over BRC-33 messagebox (`inbox` identity cards + vault-level own-box `vault-identities`).
pub async fn sync_messagebox_identities(
    services: &Arc<AppServices>,
    manual: bool,
) -> Result<IdentityMergeStats, String> {
    let (active_root, vault_root, summary) = {
        let guard = services.session.lock().map_err(|e| e.to_string())?;
        let Some(ref active) = *guard else {
            return Err("Unlock HandCash first.".into());
        };
        let vault_root = active.vault.master.account_private_key(0).ok();
        (
            active.deriver.root_key().clone(),
            vault_root,
            active.summary.clone(),
        )
    };

    let accounts = services.list_vault_accounts();
    let active_held_here = accounts
        .iter()
        .find(|a| a.index == summary.account_index)
        .map(|a| a.held_here)
        .unwrap_or(true);
    let active_ik_lower = summary.identity_key.trim().to_ascii_lowercase();
    let mut known_peers: HashSet<String> = HashSet::new();
    let mut request_targets: Vec<String> = Vec::new();
    for acc in &accounts {
        if let Some(ik) = normalize_issuer_identity_key(&acc.identity_key) {
            if ik != active_ik_lower {
                known_peers.insert(ik.clone());
                // Ask sibling accounts (especially those held on other devices) for their identity card.
                if !acc.held_here
                    || services
                        .account_profile_for(&summary.chain, acc.index, &ik)
                        .is_none()
                {
                    request_targets.push(ik);
                }
            }
        }
    }
    for fr in services.list_friends() {
        if let Some(ik) = normalize_issuer_identity_key(&fr.identity_key) {
            if ik != active_ik_lower {
                known_peers.insert(ik.clone());
                if services.identity_profile_for(&summary.chain, &ik).is_none() {
                    request_targets.push(ik);
                }
            }
        }
    }
    request_targets.sort();
    request_targets.dedup();

    let base_url = default_messagebox_base(services);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let mut totals = IdentityMergeStats::default();

    // 1. Active account inbox (ONLY when this device holds the active account).
    if active_held_here {
        let first = poll_active_inbox_cards(
            services,
            &client,
            &base_url,
            &active_root,
            &summary,
            &known_peers,
        )
        .await;
        totals.profiles_added += first.profiles_added;
        totals.bap_packages_added += first.bap_packages_added;
        totals.cards_added += first.cards_added;

        // Send identity-card requests to sibling accounts held elsewhere and friends without profiles.
        let now = now_ms();
        let mut sent_any = false;
        for peer_ik in &request_targets {
            let should_send = {
                let map = LAST_CARD_REQUESTED.get_or_init(|| Mutex::new(HashMap::new()));
                let mut g = map.lock().unwrap_or_else(|e| e.into_inner());
                let key = format!("{active_ik_lower}:{peer_ik}");
                let prev = g.get(&key).copied().unwrap_or(0);
                if manual || now.saturating_sub(prev) >= CARD_REQUEST_COOLDOWN_MS {
                    g.insert(key, now);
                    true
                } else {
                    false
                }
            };
            if !should_send {
                continue;
            }
            if let Ok(sealed) = seal_peer_message(
                &active_root,
                peer_ik,
                IDENTITY_CARD_REQUEST,
                &iso_utc_from_ms(now),
            ) {
                if send_message(&client, &base_url, &active_root, peer_ik, "inbox", &sealed).await {
                    sent_any = true;
                }
            }
        }

        if manual && sent_any {
            tokio::time::sleep(Duration::from_millis(2_500)).await;
            let second = poll_active_inbox_cards(
                services,
                &client,
                &base_url,
                &active_root,
                &summary,
                &known_peers,
            )
            .await;
            totals.profiles_added += second.profiles_added;
            totals.bap_packages_added += second.bap_packages_added;
            totals.cards_added += second.cards_added;
        }
    }

    // 2. Vault-level own-box `vault-identities` (BRC-78 sealed to self on vault identity,
    //    same vault-coordination boundary as `vault-link`).
    if let Some(ref vroot) = vault_root {
        if let Ok(vault_ik) = vroot.public_key_hex() {
            let local_device_id = services.get_or_create_device_id();
            let now = now_ms();
            let mut own_msg_ids: Vec<(i64, String)> = Vec::new();
            let mut stale_ids: Vec<String> = Vec::new();
            let mut latest_own_hash: Option<String> = None;
            if let Some(messages) =
                list_messages(&client, &base_url, vroot, VAULT_IDENTITIES_BOX).await
            {
                for m in messages {
                    let msg_id = m
                        .get("messageId")
                        .and_then(|v| v.as_str().map(ToString::to_string).or_else(|| v.as_i64().map(|n| n.to_string())));
                    let Some(body) = m.get("body").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some((inner, sealed)) = open_peer_message(vroot, body, Some(&vault_ik)) else {
                        continue;
                    };
                    if !sealed {
                        continue;
                    }
                    let Ok(frame) = serde_json::from_str::<Value>(&inner) else {
                        continue;
                    };
                    if frame.get("type").and_then(Value::as_str) != Some("vault-identity-snapshot") {
                        continue;
                    }
                    let frame_chain = frame.get("chain").and_then(Value::as_str).unwrap_or("");
                    let frame_dev = frame.get("deviceId").and_then(Value::as_str).unwrap_or("");
                    let created_at = m.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
                    if frame_chain == summary.chain {
                        if let Some(bundle) = frame.get("bundle") {
                            let merged =
                                merge_remote_identity_bundle(services, &summary.chain, bundle);
                            totals.profiles_added += merged.profiles_added;
                            totals.bap_packages_added += merged.bap_packages_added;
                            totals.cards_added += merged.cards_added;
                        }
                    }
                    if let Some(id) = msg_id {
                        if frame_dev == local_device_id && frame_chain == summary.chain {
                            own_msg_ids.push((created_at, id));
                            if let Some(h) = frame.get("bundleHash").and_then(Value::as_str) {
                                latest_own_hash = Some(h.to_string());
                            }
                        } else if created_at > 0 && now.saturating_sub(created_at) > OWN_BOX_STALE_MS {
                            stale_ids.push(id);
                        }
                    }
                }
            }
            // Publish our own local bundle if non-empty and changed since our last snapshot.
            let bundle =
                export_local_identity_bundle_with_limit(services, &summary, MAX_OWN_BOX_BUNDLE_BYTES);
            let has_data = bundle
                .get("profiles")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
                || bundle
                    .get("bapPackages")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty())
                || bundle
                    .get("cards")
                    .and_then(Value::as_object)
                    .is_some_and(|o| !o.is_empty());
            if has_data {
                // Hash stable fields (excluding `exportedAt`) so unchanged bundles are not re-posted.
                let mut stable = bundle.clone();
                if let Some(obj) = stable.as_object_mut() {
                    obj.remove("exportedAt");
                }
                let bundle_hash = encode_hex(&sha256(canonicalize_json(&stable).as_bytes()));
                let cache_key = format!("{vault_ik}:{}", summary.chain);
                let prev_cached = {
                    let map = LAST_PUSHED_BUNDLE_HASH.get_or_init(|| Mutex::new(HashMap::new()));
                    map.lock().unwrap_or_else(|e| e.into_inner()).get(&cache_key).cloned()
                };
                let already_published = prev_cached.as_deref() == Some(bundle_hash.as_str())
                    || latest_own_hash.as_deref() == Some(bundle_hash.as_str());
                if !already_published {
                    let frame = json!({
                        "type": "vault-identity-snapshot",
                        "v": 1,
                        "deviceId": local_device_id,
                        "chain": summary.chain,
                        "bundleHash": bundle_hash,
                        "bundle": bundle,
                    });
                    if let Ok(frame_str) = serde_json::to_string(&frame) {
                        if let Ok(sealed) =
                            seal_peer_message(vroot, &vault_ik, &frame_str, &iso_utc_from_ms(now))
                        {
                            if send_message(
                                &client,
                                &base_url,
                                vroot,
                                &vault_ik,
                                VAULT_IDENTITIES_BOX,
                                &sealed,
                            )
                            .await
                            {
                                let map = LAST_PUSHED_BUNDLE_HASH
                                    .get_or_init(|| Mutex::new(HashMap::new()));
                                map.lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .insert(cache_key, bundle_hash);
                                // Retire all previous snapshots from this device now that the new one landed.
                                for (_, old_id) in own_msg_ids.drain(..) {
                                    stale_ids.push(old_id);
                                }
                            }
                        }
                    }
                } else if own_msg_ids.len() > 1 {
                    own_msg_ids.sort_by_key(|(ts, _)| *ts);
                    for (_, old_id) in own_msg_ids.into_iter().rev().skip(1) {
                        stale_ids.push(old_id);
                    }
                }
            }
            if !stale_ids.is_empty() {
                acknowledge_messages(&client, &base_url, vroot, VAULT_IDENTITIES_BOX, &stale_ids)
                    .await;
            }
        }
    }

    Ok(totals)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("hc-mb-{tag}-{nanos}"))
    }

    #[test]
    fn iso_utc_formats_and_parses_epoch_timestamps() {
        assert_eq!(iso_utc_from_ms(0), "1970-01-01T00:00:00.000Z");
        let ts = "2026-11-24T22:36:31.456Z";
        let ms = parse_iso_utc_ms(ts).unwrap();
        assert_eq!(iso_utc_from_ms(ms), ts);
    }

    #[test]
    fn peer_envelope_seal_open_and_tamper_rejection() {
        let alice = SecretKeyBytes::from_hex(&"11".repeat(32)).unwrap();
        let bob = SecretKeyBytes::from_hex(&"22".repeat(32)).unwrap();
        let alice_ik = alice.public_key_hex().unwrap();
        let bob_ik = bob.public_key_hex().unwrap();
        let sealed = seal_peer_message(
            &alice,
            &bob_ik,
            IDENTITY_CARD_REQUEST,
            "2026-11-24T12:00:00.000Z",
        )
        .unwrap();
        let (pt, was_sealed) = open_peer_message(&bob, &sealed, Some(&alice_ik)).unwrap();
        assert!(was_sealed);
        assert_eq!(pt, IDENTITY_CARD_REQUEST);
        // Wrong expected sender rejected
        assert!(open_peer_message(&bob, &sealed, Some(&bob_ik)).is_none());
        // Tampered metadata rejected
        let tampered = sealed.replace("2026-11-24T12:00:00.000Z", "2026-11-24T12:00:01.000Z");
        assert!(open_peer_message(&bob, &tampered, Some(&alice_ik)).is_none());
    }

    #[test]
    fn identity_card_v2_roundtrip_between_sibling_accounts_resolves_account_profile() {
        let dir_a = temp_dir("card-a");
        let dir_b = temp_dir("card-b");
        let svc_a = AppServices::open_in(dir_a, false).unwrap();
        let svc_b = AppServices::open_in(dir_b, false).unwrap();
        let phrase = "absurd avoid scissors anxiety gather lottery category door army half long cage bachelor another expect people blade school educate curtain scrub monitor lady beyond";
        let sum_a0 = svc_a
            .restore_vault(
                "alice",
                phrase,
                "",
                "Pass1234!",
                "main",
                handcash_primitives::keys::MnemonicScheme::Brc157,
            )
            .unwrap();
        let _sum_b0 = svc_b
            .restore_vault(
                "alice",
                phrase,
                "",
                "Pass1234!",
                "main",
                handcash_primitives::keys::MnemonicScheme::Brc157,
            )
            .unwrap();
        // Device B switches to Account 1 while Device A holds Account 0 with a saved profile + avatar.
        let _sum_b1 = svc_b.switch_vault_account(1).unwrap();
        let png_b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\navatar");
        let img_url = format!("data:image/png;base64,{png_b64}");
        svc_a
            .save_public_identity_profile(
                &sum_a0,
                &sum_a0.identity_key,
                "Primary Creator",
                "On another device",
                Some(&img_url),
            )
            .unwrap();
        assert!(svc_b
            .account_profile_for(&sum_a0.chain, 0, &sum_a0.identity_key)
            .is_none());

        let root_a0 = svc_a
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .deriver
            .root_key()
            .clone();
        let card = build_own_identity_card_v2(&svc_a, &root_a0, &sum_a0)
            .expect("signed v2 identity card built");
        let stats = ingest_identity_card(&svc_b, &sum_a0.chain, &card, Some(&sum_a0.identity_key));
        assert_eq!(stats.profiles_added, 1);
        assert_eq!(stats.cards_added, 1);

        // Device B now resolves Account 0's profile & avatar via account_profile_for!
        let resolved = svc_b
            .account_profile_for(&sum_a0.chain, 0, &sum_a0.identity_key)
            .expect("remote sibling account profile resolves on Device B");
        assert_eq!(resolved.name, "Primary Creator");
        assert_eq!(resolved.description, "On another device");
        assert_eq!(resolved.image_data_url.as_deref(), Some(img_url.as_str()));
    }
}
