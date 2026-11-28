// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure-Rust LAN device-peer server (`/handcash-device/v1/*`) and connected-device
//! identity sync client. Wire-compatible with `src/wallet/devicePeerAuth.ts`,
//! `devicePeerHandler.ts`, `devicePeer.ts`, and `identityPeerSync.ts`.

use crate::state::{AppServices, SessionSummary, DEVICE_ID_STORAGE_KEY, DEVICE_WALLETS_STORAGE_KEY};
use base64::Engine as _;
use handcash_bitcoin::issuer::{
    normalize_bap_id, normalize_issuer_identity_key, verify_and_decrypt_profile_certificate,
    verify_issuer_identity_package,
};
use handcash_primitives::encoding::{decode_hex, encode_hex};
use handcash_primitives::keys::{Counterparty, KeyDeriver, SecretKeyBytes};
use handcash_shell::bridge_protocol::BridgeReply;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEVICE_PEER_PROTOCOL: (u8, &str) = (2, "handcash device peer");
pub const DEVICE_PEER_AUTH_HEADER: &str = "x-handcash-device-auth";
pub const DEVICE_PEER_AUTH_WINDOW_MS: i64 = 60_000;
const AUTH_KEY_ID: &str = "request v1";
const MAX_LAN_BUNDLE_BYTES: usize = 1_200_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Default)]
pub struct DeviceAuthReplayCache {
    seen: HashMap<String, i64>,
}

impl DeviceAuthReplayCache {
    pub fn check_and_insert(&mut self, nonce: &str, ts: i64, now: i64) -> bool {
        self.seen
            .retain(|_, seen_ts| (now - *seen_ts).abs() <= DEVICE_PEER_AUTH_WINDOW_MS);
        if self.seen.contains_key(nonce) {
            return false;
        }
        self.seen.insert(nonce.to_string(), ts);
        true
    }
}

fn proof_data(method: &str, path: &str, ts: i64, nonce: &str) -> String {
    format!("{} {} {} {}", method.to_ascii_uppercase(), path, ts, nonce)
}

/// Build a BRC-2 HMAC `x-handcash-device-auth` header and its single-use nonce.
pub fn create_device_auth(
    root: &SecretKeyBytes,
    method: &str,
    path: &str,
    now: i64,
) -> Result<(String, String), String> {
    let rand_key = SecretKeyBytes::random();
    let nonce = encode_hex(&rand_key.as_bytes()[..16]);
    let kd = KeyDeriver::new(root.clone());
    let data = proof_data(method, path, now, &nonce);
    let hmac = kd
        .create_hmac(
            DEVICE_PEER_PROTOCOL,
            AUTH_KEY_ID,
            Counterparty::SelfParty,
            data.as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    Ok((format!("{now}.{nonce}.{}", encode_hex(&hmac)), nonce))
}

/// Verify `x-handcash-device-auth` proof and return its nonce on success.
pub fn verify_device_auth(
    root: &SecretKeyBytes,
    header: Option<&str>,
    method: &str,
    path: &str,
    replay: &Mutex<DeviceAuthReplayCache>,
    now: i64,
) -> Option<String> {
    let raw = header?.trim();
    let mut parts = raw.split('.');
    let ts_str = parts.next()?;
    let nonce = parts.next()?;
    let hmac_hex = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if ts_str.is_empty()
        || ts_str.len() > 15
        || !ts_str.bytes().all(|b| b.is_ascii_digit())
        || nonce.len() != 32
        || !nonce.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        || hmac_hex.len() != 64
        || !hmac_hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let ts: i64 = ts_str.parse().ok()?;
    if (now - ts).abs() > DEVICE_PEER_AUTH_WINDOW_MS {
        return None;
    }
    let hmac_bytes = decode_hex(hmac_hex).ok()?;
    let kd = KeyDeriver::new(root.clone());
    let data = proof_data(method, path, ts, nonce);
    let valid = kd
        .verify_hmac(
            DEVICE_PEER_PROTOCOL,
            AUTH_KEY_ID,
            Counterparty::SelfParty,
            data.as_bytes(),
            &hmac_bytes,
        )
        .ok()?;
    if !valid {
        return None;
    }
    let mut guard = replay.lock().ok()?;
    if !guard.check_and_insert(nonce, ts, now) {
        return None;
    }
    Some(nonce.to_string())
}

/// Seal a JSON value to `nonce` using BRC-2 AES-256-GCM (matches `sealForPeer`).
pub fn seal_for_peer(root: &SecretKeyBytes, nonce: &str, value: &Value) -> Result<String, String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let kd = KeyDeriver::new(root.clone());
    let ct = kd
        .encrypt(
            DEVICE_PEER_PROTOCOL,
            nonce,
            Counterparty::SelfParty,
            json.as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&ct))
}

/// Decrypt a base64 sealed device-peer response (matches `openFromPeer`).
pub fn open_from_peer(
    root: &SecretKeyBytes,
    nonce: &str,
    sealed_b64: &str,
) -> Result<Value, String> {
    let ct = base64::engine::general_purpose::STANDARD
        .decode(sealed_b64.trim())
        .map_err(|e| e.to_string())?;
    let kd = KeyDeriver::new(root.clone());
    let pt = kd
        .decrypt(DEVICE_PEER_PROTOCOL, nonce, Counterparty::SelfParty, &ct)
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&pt).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IdentityMergeStats {
    pub profiles_added: usize,
    pub bap_packages_added: usize,
    pub cards_added: usize,
}

fn local_device_id(services: &AppServices) -> String {
    if let Some(id) = services
        .durable
        .get(DEVICE_ID_STORAGE_KEY)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return id;
    }
    let id = format!("dev-{}", encode_hex(&SecretKeyBytes::random().as_bytes()[..8]));
    let _ = services.durable.set(DEVICE_ID_STORAGE_KEY, &id, false);
    id
}

fn local_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// Export this device's verified identity profiles, BAP issuer packages, identity card links,
/// and non-secret own-presentation metadata in the shared `/handcash-device/v1/identities` schema.
pub fn export_local_identity_bundle(services: &AppServices, summary: &SessionSummary) -> Value {
    export_local_identity_bundle_with_limit(services, summary, MAX_LAN_BUNDLE_BYTES)
}

/// Non-secret presentation metadata for one vault account (never includes sealedKey).
fn read_account_presentation(
    services: &AppServices,
    chain: &str,
    account_index: u32,
    identity_key: &str,
) -> Option<Value> {
    let ik_trim = identity_key.trim();
    let ik_lower = normalize_issuer_identity_key(ik_trim)?;
    let v = [
        format!("handcash.publicIdentities.v1:wallet:{chain}:{account_index}:{ik_trim}"),
        format!("handcash.publicIdentities.v1:wallet:{chain}:{account_index}:{ik_lower}"),
    ]
    .iter()
    .find_map(|k| services.durable.get(k))
    .and_then(|r| serde_json::from_str::<Value>(&r).ok())?;

    let mut published = serde_json::Map::new();
    if let Some(arr) = v.get("identities").and_then(Value::as_array) {
        for row in arr {
            if let (Some(ik), Some(bap)) = (
                row.get("identityKey")
                    .and_then(Value::as_str)
                    .and_then(normalize_issuer_identity_key),
                row.get("published")
                    .and_then(Value::as_str)
                    .and_then(normalize_bap_id),
            ) {
                published.insert(ik, Value::String(bap));
            }
        }
    }
    let mut obj = serde_json::Map::new();
    obj.insert("owner".into(), Value::String(ik_lower));
    if let Some(s) = v
        .get("selected")
        .and_then(Value::as_str)
        .and_then(normalize_issuer_identity_key)
    {
        obj.insert("selected".into(), Value::String(s));
    }
    if let Some(p) = v
        .get("presented")
        .and_then(Value::as_str)
        .and_then(normalize_issuer_identity_key)
    {
        obj.insert("presented".into(), Value::String(p));
    }
    if let Some(pa) = v.get("presentedAt").and_then(Value::as_str) {
        obj.insert("presentedAt".into(), Value::String(pa.to_string()));
    }
    if v.get("unsigned").and_then(Value::as_bool) == Some(true) {
        obj.insert("unsigned".into(), Value::Bool(true));
    }
    if !published.is_empty() {
        obj.insert("published".into(), Value::Object(published));
    }
    Some(Value::Object(obj))
}

/// Export local identity bundle capped at `max_bytes` (e.g. 1.2 MB over LAN, 180 KB over messagebox).
pub fn export_local_identity_bundle_with_limit(
    services: &AppServices,
    summary: &SessionSummary,
    max_bytes: usize,
) -> Value {
    let chain = &summary.chain;
    let mut profiles: Vec<Value> = Vec::new();
    let mut bap_packages: Vec<Value> = Vec::new();

    let cards_key = format!("handcash.identityCards.v1:{chain}");
    let cards_map = services
        .durable
        .get(&cards_key)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v.get("links").cloned())
        .filter(|v| v.as_object().is_some_and(|m| !m.is_empty()));

    // Non-secret presentation metadata for active account + all locally held vault accounts.
    let own_presentation =
        read_account_presentation(services, chain, summary.account_index, &summary.identity_key);
    let mut account_presentations: Vec<Value> = Vec::new();
    let mut seen_owners = std::collections::HashSet::new();
    if let Some(ref own) = own_presentation {
        if let Some(owner) = own.get("owner").and_then(Value::as_str) {
            seen_owners.insert(owner.to_string());
        }
        account_presentations.push(own.clone());
    }
    for acc in services.list_vault_accounts() {
        if !acc.held_here {
            continue;
        }
        let Some(owner) = normalize_issuer_identity_key(&acc.identity_key) else {
            continue;
        };
        if !seen_owners.insert(owner) {
            continue;
        }
        if let Some(pres) = read_account_presentation(services, chain, acc.index, &acc.identity_key) {
            account_presentations.push(pres);
        }
    }

    let mut used_bytes = 512usize;
    if let Some(ref c) = cards_map {
        used_bytes += c.to_string().len();
    }
    if !account_presentations.is_empty() {
        used_bytes += Value::Array(account_presentations.clone()).to_string().len();
    }

    let prof_idx_key = format!("handcash.identityProfiles.v1:{chain}");
    if let Some(entries) = services
        .durable
        .get(&prof_idx_key)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v.get("entries").and_then(Value::as_array).cloned())
    {
        for e in entries {
            let Some(ik) = e
                .get("identityKey")
                .and_then(Value::as_str)
                .and_then(normalize_issuer_identity_key)
            else {
                continue;
            };
            let entry_key = format!("handcash.identityProfiles.v1:{chain}:{ik}");
            let Some(stored) = services
                .durable
                .get(&entry_key)
                .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            else {
                continue;
            };
            let Some(record) = stored.get("record").cloned() else {
                continue;
            };
            let Some(name) = stored
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let description = stored
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let issued_at = stored
                .get("issuedAt")
                .and_then(Value::as_str)
                .unwrap_or("");
            let item = json!({
                "identityKey": ik,
                "record": record,
                "name": name,
                "description": description,
                "issuedAt": issued_at,
            });
            let sz = item.to_string().len() + 2;
            if used_bytes + sz <= max_bytes {
                profiles.push(item);
                used_bytes += sz;
            }
        }
    }

    let bap_idx_key = format!("handcash.issuerIdentities.v1:{chain}");
    if let Some(entries) = services
        .durable
        .get(&bap_idx_key)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v.get("entries").and_then(Value::as_array).cloned())
    {
        for e in entries {
            let Some(bap_id) = e
                .get("bapId")
                .and_then(Value::as_str)
                .and_then(normalize_bap_id)
            else {
                continue;
            };
            let entry_key = format!("handcash.issuerIdentities.v1:{chain}:{bap_id}");
            let Some(pkg) = services
                .durable
                .get(&entry_key)
                .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            else {
                continue;
            };
            if verify_issuer_identity_package(&pkg).is_none() {
                continue;
            }
            let sz = pkg.to_string().len() + 2;
            if used_bytes + sz <= max_bytes {
                bap_packages.push(pkg);
                used_bytes += sz;
            }
        }
    }

    let mut out = json!({
        "v": 1,
        "chain": chain,
        "identityKey": summary.identity_key,
        "exportedAt": now_ms(),
        "profiles": profiles,
        "bapPackages": bap_packages,
    });
    if let Some(obj) = out.as_object_mut() {
        if let Some(c) = cards_map {
            obj.insert("cards".into(), c);
        }
        if let Some(p) = own_presentation {
            obj.insert("ownPresentation".into(), p);
        }
        if !account_presentations.is_empty() {
            obj.insert(
                "accountPresentations".into(),
                Value::Array(account_presentations),
            );
        }
    }
    out
}

/// Verify and merge an incoming identity bundle from a connected peer device.
pub fn merge_remote_identity_bundle(
    services: &AppServices,
    chain: &str,
    bundle: &Value,
) -> IdentityMergeStats {
    let mut stats = IdentityMergeStats::default();
    if bundle.get("v").and_then(Value::as_u64) != Some(1)
        || bundle.get("chain").and_then(Value::as_str) != Some(chain)
    {
        return stats;
    }
    let now = now_ms();

    // 1. Merge self-published BRC-248 profiles (newer `issuedAt` wins).
    if let Some(arr) = bundle.get("profiles").and_then(Value::as_array) {
        let idx_key = format!("handcash.identityProfiles.v1:{chain}");
        let mut idx = services
            .durable
            .get(&idx_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| json!({ "version": 1, "entries": [] }));
        let mut idx_changed = false;
        for item in arr {
            let Some(ik) = item
                .get("identityKey")
                .and_then(Value::as_str)
                .and_then(normalize_issuer_identity_key)
            else {
                continue;
            };
            let Some(record) = item.get("record") else {
                continue;
            };
            let Some(cert) = record.get("certificate") else {
                continue;
            };
            let cert_sub = cert
                .get("subject")
                .and_then(Value::as_str)
                .and_then(normalize_issuer_identity_key);
            let cert_iss = cert
                .get("certifier")
                .and_then(Value::as_str)
                .and_then(normalize_issuer_identity_key);
            if cert_sub.as_deref() != Some(ik.as_str()) || cert_iss.as_deref() != Some(ik.as_str()) {
                continue;
            }
            let has_keyring = cert
                .get("keyring")
                .and_then(Value::as_object)
                .is_some_and(|m| !m.is_empty());
            let (final_name, final_desc, final_issued, final_record) = if has_keyring {
                let imgs: Vec<Value> = record.get("image").cloned().into_iter().collect();
                let Some(verified) = verify_and_decrypt_profile_certificate(&ik, cert, &imgs)
                else {
                    continue;
                };
                let mut rec_obj = serde_json::Map::new();
                rec_obj.insert("certificate".into(), verified.certificate);
                if let Some(img) = verified.image {
                    rec_obj.insert("image".into(), img);
                }
                (
                    verified.name,
                    verified.description,
                    verified.issued_at,
                    Value::Object(rec_obj),
                )
            } else {
                let Some(name) = item
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.len() <= 64)
                else {
                    continue;
                };
                let issued_at = item
                    .get("issuedAt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let description = item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                (name.to_string(), description, issued_at, record.clone())
            };
            let entry_key = format!("handcash.identityProfiles.v1:{chain}:{ik}");
            let existing_issued = services
                .durable
                .get(&entry_key)
                .and_then(|r| serde_json::from_str::<Value>(&r).ok())
                .and_then(|v| v.get("issuedAt").and_then(Value::as_str).map(ToString::to_string));
            if let Some(ref prev) = existing_issued {
                if prev.as_str() >= final_issued.as_str() && !prev.is_empty() {
                    continue;
                }
            }
            let stored = json!({
                "record": final_record,
                "name": final_name,
                "description": final_desc,
                "issuedAt": final_issued,
            });
            if let Ok(raw) = serde_json::to_string(&stored) {
                if services.durable.set(&entry_key, &raw, false) {
                    stats.profiles_added += 1;
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
                        idx_changed = true;
                    }
                }
            }
        }
        if idx_changed {
            if let Ok(raw) = serde_json::to_string(&idx) {
                let _ = services.durable.set(&idx_key, &raw, false);
            }
        }
    }

    // 2. Verify and merge BAP issuer packages.
    if let Some(arr) = bundle.get("bapPackages").and_then(Value::as_array) {
        let idx_key = format!("handcash.issuerIdentities.v1:{chain}");
        let mut idx = services
            .durable
            .get(&idx_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| json!({ "version": 1, "entries": [] }));
        let mut idx_changed = false;
        for pkg in arr {
            let Some(verified) = verify_issuer_identity_package(pkg) else {
                continue;
            };
            let bap_id = verified.bap_id;
            let entry_key = format!("handcash.issuerIdentities.v1:{chain}:{bap_id}");
            let existing_raw = services.durable.get(&entry_key);
            if let Ok(raw) = serde_json::to_string(pkg) {
                if existing_raw.as_deref() == Some(raw.as_str()) {
                    continue;
                }
                if services.durable.set(&entry_key, &raw, false) {
                    stats.bap_packages_added += 1;
                    if let Some(entries) = idx.get_mut("entries").and_then(Value::as_array_mut) {
                        entries.retain(|e| e.get("bapId").and_then(Value::as_str) != Some(bap_id.as_str()));
                        entries.push(json!({ "bapId": bap_id, "storedAt": now }));
                        idx_changed = true;
                    }
                }
            }
        }
        if idx_changed {
            if let Ok(raw) = serde_json::to_string(&idx) {
                let _ = services.durable.set(&idx_key, &raw, false);
            }
        }
    }

    // 3. Merge identity card links (`handcash.identityCards.v1:{chain}`).
    if let Some(incoming_cards) = bundle.get("cards").and_then(Value::as_object) {
        let cards_key = format!("handcash.identityCards.v1:{chain}");
        let mut doc = services
            .durable
            .get(&cards_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| json!({ "version": 1, "links": {} }));
        if let Some(links) = doc.get_mut("links").and_then(Value::as_object_mut) {
            for (wallet_key, row) in incoming_cards {
                let Some(owner) = normalize_issuer_identity_key(wallet_key) else {
                    continue;
                };
                let Some(issued_at) = row.get("issuedAt").and_then(Value::as_str) else {
                    continue;
                };
                let prior_issued = links
                    .get(&owner)
                    .and_then(|p| p.get("issuedAt").and_then(Value::as_str))
                    .unwrap_or("");
                if prior_issued >= issued_at && !prior_issued.is_empty() {
                    continue;
                }
                links.insert(owner, row.clone());
                stats.cards_added += 1;
            }
            if stats.cards_added > 0 {
                if let Ok(raw) = serde_json::to_string(&doc) {
                    let _ = services.durable.set(&cards_key, &raw, false);
                }
            }
        }
    }

    // 4. Link verified presented identities from `ownPresentation` + `accountPresentations`
    //    into `handcash.identityCards.v1:{chain}` so every connected vault account resolves
    //    its presented profile/BAP without writing custody stores.
    let mut presentations: Vec<&Value> = Vec::new();
    if let Some(p) = bundle.get("ownPresentation") {
        presentations.push(p);
    }
    if let Some(arr) = bundle.get("accountPresentations").and_then(Value::as_array) {
        for p in arr {
            presentations.push(p);
        }
    }
    if !presentations.is_empty() {
        let fallback_issued = crate::messagebox::iso_utc_from_ms(
            bundle
                .get("exportedAt")
                .and_then(Value::as_i64)
                .filter(|t| *t > 0)
                .unwrap_or(now),
        );
        let cards_key = format!("handcash.identityCards.v1:{chain}");
        let mut doc = services
            .durable
            .get(&cards_key)
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .unwrap_or_else(|| json!({ "version": 1, "links": {} }));
        let mut pres_added = 0usize;
        if let Some(links) = doc.get_mut("links").and_then(Value::as_object_mut) {
            for pres in presentations {
                let Some(owner) = pres
                    .get("owner")
                    .and_then(Value::as_str)
                    .and_then(normalize_issuer_identity_key)
                else {
                    continue;
                };
                let presented_key = pres
                    .get("presented")
                    .and_then(Value::as_str)
                    .and_then(normalize_issuer_identity_key)
                    .unwrap_or_else(|| owner.clone());
                let published_bap = pres
                    .get("published")
                    .and_then(Value::as_object)
                    .and_then(|m| {
                        m.get(&presented_key)
                            .or_else(|| m.get(&owner))
                            .and_then(Value::as_str)
                            .and_then(normalize_bap_id)
                    });
                let has_key_profile = services.identity_profile_for(chain, &presented_key).is_some()
                    || services
                        .linked_bap_identity_for_key(chain, &presented_key)
                        .is_some();
                let verified_bap = published_bap
                    .as_deref()
                    .filter(|bid| services.bap_identity_for(chain, bid).is_some());
                if !has_key_profile && verified_bap.is_none() {
                    continue;
                }
                let issued_at = pres
                    .get("presentedAt")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&fallback_issued);
                let prior_issued = links
                    .get(&owner)
                    .and_then(|p| p.get("issuedAt").and_then(Value::as_str))
                    .unwrap_or("");
                if !prior_issued.is_empty() && prior_issued >= issued_at {
                    continue;
                }
                let link_val = if has_key_profile {
                    json!({ "key": presented_key, "issuedAt": issued_at, "receivedAt": now })
                } else {
                    json!({ "bapId": verified_bap.unwrap(), "issuedAt": issued_at, "receivedAt": now })
                };
                links.insert(owner, link_val);
                pres_added += 1;
            }
        }
        if pres_added > 0 {
            if let Ok(raw) = serde_json::to_string(&doc) {
                let _ = services.durable.set(&cards_key, &raw, false);
            }
            stats.cards_added += pres_added;
        }
    }

    stats
}

fn auth_header_value(headers: &HashMap<String, String>) -> Option<&str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(DEVICE_PEER_AUTH_HEADER))
        .map(|(_, v)| v.as_str())
}

fn error_reply(status: u16, code: &str, description: &str) -> BridgeReply {
    BridgeReply {
        status,
        body: json!({ "status": "error", "code": code, "description": description }).to_string(),
    }
}

/// Handle one `/handcash-device/v1/*` request directly inside `handcash-native`.
pub fn handle_direct_device_peer_request(
    services: &AppServices,
    replay: &Mutex<DeviceAuthReplayCache>,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    _body: &str,
) -> BridgeReply {
    let method_upper = method.to_ascii_uppercase();
    if method_upper == "OPTIONS" {
        return BridgeReply {
            status: 200,
            body: String::new(),
        };
    }
    let clean_path = path.trim_end_matches('/');
    let route = clean_path
        .find("/handcash-device/v1/")
        .map(|at| &clean_path[at..])
        .unwrap_or(clean_path);
    if crate::scan_login::is_scan_login_path(route) {
        return crate::scan_login::handle_scan_login_request(services, &method_upper, route, _body);
    }
    if !matches!(
        (method_upper.as_str(), route),
        ("GET", "/handcash-device/v1/health")
            | ("GET", "/handcash-device/v1/snapshot")
            | ("GET", "/handcash-device/v1/pair-info")
            | ("GET", "/handcash-device/v1/identities")
    ) {
        return error_reply(404, "NOT_FOUND", "Unknown device-peer route");
    }

    let (auth_candidates, summary) = {
        let Ok(guard) = services.session.lock() else {
            return error_reply(503, "WALLET_LOCKED", "Session unavailable.");
        };
        let Some(ref active) = *guard else {
            return error_reply(503, "WALLET_LOCKED", "Unlock HandCash on this device first.");
        };
        let mut candidates: Vec<SecretKeyBytes> = vec![active.deriver.root_key().clone()];
        if route == "/handcash-device/v1/identities" {
            // Non-custodial identity bundle: accept auth from any locally held account
            // or the vault coordination identity (account 0), matching vault-link.
            let mut seen_iks = std::collections::HashSet::new();
            if let Ok(ik) = active.deriver.root_key().public_key_hex() {
                seen_iks.insert(ik.to_ascii_lowercase());
            }
            let store_key = format!(
                "{}{}",
                crate::state::VAULT_ACCOUNTS_PREFIX,
                active.vault.record.identity_key
            );
            let mut held_indices: Vec<u32> = vec![0];
            if let Some(raw) = services.durable.get(&store_key) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if let Some(arr) = v.get("accounts").and_then(Value::as_array) {
                        for item in arr {
                            let idx = item.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let held_here = item
                                .get("holding")
                                .and_then(|h| h.get("kind"))
                                .and_then(Value::as_str)
                                .map(|k| k == "here")
                                .unwrap_or(true);
                            if held_here && !held_indices.contains(&idx) {
                                held_indices.push(idx);
                            }
                        }
                    }
                }
            }
            for idx in held_indices {
                if let Ok(k) = active.vault.master.account_private_key(idx) {
                    if let Ok(ik) = k.public_key_hex() {
                        if seen_iks.insert(ik.to_ascii_lowercase()) {
                            candidates.push(k);
                        }
                    }
                }
            }
        }
        (candidates, active.summary.clone())
    };

    let auth_hdr = auth_header_value(headers);
    let now = now_ms();
    let matched = auth_candidates.into_iter().find_map(|key| {
        verify_device_auth(&key, auth_hdr, &method_upper, route, replay, now)
            .map(|nonce| (key, nonce))
    });
    let Some((root_key, nonce)) = matched else {
        return error_reply(
            401,
            "DEVICE_AUTH_REQUIRED",
            "Only devices signed in to this wallet may ask.",
        );
    };

    let device_id = local_device_id(services);
    let platform = local_platform();
    let value = match route {
        "/handcash-device/v1/health" => json!({
            "ok": true,
            "service": "handcash-device-peer",
            "deviceId": device_id,
            "identityKey": summary.identity_key,
            "label": format!("HandCash ({platform})"),
            "platform": platform,
        }),
        "/handcash-device/v1/snapshot" => {
            let snap = services.read_snapshot();
            let friends = services.list_friends();
            let collectables: Vec<Value> = snap
                .items
                .iter()
                .map(|c| {
                    json!({
                        "outpoint": c.outpoint,
                        "origin": c.origin_outpoint,
                        "name": c.name,
                        "app": snap.item_meta.get(&c.outpoint).and_then(|m| m.app.clone()),
                        "satoshis": 1,
                    })
                })
                .collect();
            json!({
                "identityKey": summary.identity_key,
                "deviceId": device_id,
                "label": format!("HandCash ({platform})"),
                "platform": platform,
                "balanceSats": snap.balance.displayed_sats,
                "friends": friends,
                "collectables": collectables,
            })
        }
        "/handcash-device/v1/identities" => export_local_identity_bundle(services, &summary),
        _ => {
            let status = services.brc100.status_snapshot();
            let peer_url = status
                .get("devicePeerLanUrls")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str);
            json!({
                "v": 3,
                "deviceId": device_id,
                "identityKey": summary.identity_key,
                "address": summary.address,
                "label": format!("HandCash ({platform})"),
                "platform": platform,
                "peerBaseUrl": peer_url,
            })
        }
    };

    match seal_for_peer(&root_key, &nonce, &value) {
        Ok(sealed) => BridgeReply {
            status: 200,
            body: json!({ "sealed": sealed }).to_string(),
        },
        Err(e) => error_reply(500, "SEAL_FAILED", &e),
    }
}

/// Wire the in-process LAN device-peer handler into `Brc100Bridge` (`:3340`).
pub fn install_direct_device_peer_handler(services: &Arc<AppServices>) {
    let svc = Arc::clone(services);
    let replay = Arc::new(Mutex::new(DeviceAuthReplayCache::default()));
    services
        .brc100
        .set_direct_device_peer_handler(move |method, path, headers, body| {
            handle_direct_device_peer_request(&svc, &replay, method, path, headers, body)
        });
}

/// Fetch missing identity profiles, BAP packages, and card links from all connected
/// devices: LAN peers in `handcash.deviceWallets.v1` and same-vault BRC-33 messagebox
/// (`inbox` identity cards + own-box `vault-identities`).
pub async fn sync_identities_from_connected_peers(
    services: &Arc<AppServices>,
) -> Result<IdentityMergeStats, String> {
    sync_identities_inner(services, false).await
}

/// Manual sync triggered by user action (requests fresh identity cards from sibling accounts
/// and friends immediately and performs a short follow-up inbox poll).
pub async fn sync_identities_from_connected_peers_manual(
    services: &Arc<AppServices>,
) -> Result<IdentityMergeStats, String> {
    sync_identities_inner(services, true).await
}

async fn sync_identities_inner(
    services: &Arc<AppServices>,
    manual: bool,
) -> Result<IdentityMergeStats, String> {
    let accounts = services.list_vault_accounts();
    let (summary, vault_account_keys, auth_candidates) = {
        let guard = services.session.lock().map_err(|e| e.to_string())?;
        let Some(ref active) = *guard else {
            return Err("Unlock HandCash first.".into());
        };
        let mut vault_keys = std::collections::HashSet::new();
        if let Some(ik) = normalize_issuer_identity_key(&active.summary.identity_key) {
            vault_keys.insert(ik);
        }
        if let Some(ik) = normalize_issuer_identity_key(&active.vault.record.identity_key) {
            vault_keys.insert(ik);
        }
        for acc in &accounts {
            if let Some(ik) = normalize_issuer_identity_key(&acc.identity_key) {
                vault_keys.insert(ik);
            }
        }
        // Auth keys for non-custodial /identities fetches: locally held accounts + vault identity (account 0).
        let mut candidates: Vec<(String, SecretKeyBytes)> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let active_held = accounts
            .iter()
            .find(|a| a.index == active.summary.account_index)
            .map(|a| a.held_here)
            .unwrap_or(true);
        if active_held {
            let k = active.deriver.root_key().clone();
            if let Ok(ik) = k.public_key_hex() {
                let ik_l = ik.to_ascii_lowercase();
                if seen.insert(ik_l.clone()) {
                    candidates.push((ik_l, k));
                }
            }
        }
        for acc in &accounts {
            if !acc.held_here {
                continue;
            }
            if let Ok(k) = active.vault.master.account_private_key(acc.index) {
                if let Ok(ik) = k.public_key_hex() {
                    let ik_l = ik.to_ascii_lowercase();
                    if seen.insert(ik_l.clone()) {
                        candidates.push((ik_l, k));
                    }
                }
            }
        }
        if let Ok(vroot) = active.vault.master.account_private_key(0) {
            if let Ok(ik) = vroot.public_key_hex() {
                let ik_l = ik.to_ascii_lowercase();
                if seen.insert(ik_l.clone()) {
                    candidates.push((ik_l, vroot));
                }
            }
        }
        (active.summary.clone(), vault_keys, candidates)
    };

    let mut seen_urls = std::collections::HashSet::new();
    let peers: Vec<(String, String)> = services
        .durable
        .get(DEVICE_WALLETS_STORAGE_KEY)
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|w| {
            if w.get("isLocal").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let ik = w
                .get("identityKey")
                .and_then(Value::as_str)
                .and_then(normalize_issuer_identity_key)?;
            if !vault_account_keys.contains(&ik) {
                return None;
            }
            let url = w.get("peerBaseUrl").and_then(Value::as_str)?.trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return None;
            }
            let clean = url.trim_end_matches('/').to_string();
            if !seen_urls.insert(clean.clone()) {
                return None;
            }
            Some((clean, ik))
        })
        .collect();

    let mut totals = IdentityMergeStats::default();

    if !peers.is_empty() && !auth_candidates.is_empty() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
            .map_err(|e| e.to_string())?;
        let route = "/handcash-device/v1/identities";

        for (base_url, peer_expected_ik) in peers {
            // Try the candidate matching the peer's recorded identityKey first, then other vault keys.
            let mut ordered: Vec<&SecretKeyBytes> = Vec::with_capacity(auth_candidates.len());
            for (ik, k) in &auth_candidates {
                if *ik == peer_expected_ik {
                    ordered.push(k);
                }
            }
            for (ik, k) in &auth_candidates {
                if *ik != peer_expected_ik {
                    ordered.push(k);
                }
            }
            let url = format!("{base_url}{route}");
            for root_key in ordered {
                let Ok((auth_hdr, nonce)) = create_device_auth(root_key, "GET", route, now_ms())
                else {
                    continue;
                };
                let Ok(resp) = client
                    .get(&url)
                    .header(DEVICE_PEER_AUTH_HEADER, auth_hdr)
                    .header("accept", "application/json")
                    .send()
                    .await
                else {
                    break;
                };
                if resp.status().as_u16() == 401 {
                    continue;
                }
                if !resp.status().is_success() {
                    break;
                }
                let Ok(body_val) = resp.json::<Value>().await else {
                    break;
                };
                let Some(sealed) = body_val.get("sealed").and_then(Value::as_str) else {
                    break;
                };
                let Ok(bundle) = open_from_peer(root_key, &nonce, sealed) else {
                    break;
                };
                let peer_ik = bundle
                    .get("identityKey")
                    .and_then(Value::as_str)
                    .and_then(normalize_issuer_identity_key);
                if !peer_ik.is_some_and(|ik| vault_account_keys.contains(&ik)) {
                    break;
                }
                let merged = merge_remote_identity_bundle(services, &summary.chain, &bundle);
                totals.profiles_added += merged.profiles_added;
                totals.bap_packages_added += merged.bap_packages_added;
                totals.cards_added += merged.cards_added;
                break;
            }
        }
    }

    // Always sync via BRC-33 messagebox (`inbox` identity cards + vault-level `vault-identities`),
    // which reaches connected same-vault devices even without LAN pairing or WebRTC.
    if let Ok(mb_stats) = crate::messagebox::sync_messagebox_identities(services, manual).await {
        totals.profiles_added += mb_stats.profiles_added;
        totals.bap_packages_added += mb_stats.bap_packages_added;
        totals.cards_added += mb_stats.cards_added;
    }

    if totals.profiles_added > 0 || totals.bap_packages_added > 0 || totals.cards_added > 0 {
        services.bump_patch();
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
        std::env::temp_dir().join(format!("hc-dev-peer-{tag}-{nanos}"))
    }

    #[test]
    fn device_auth_and_sealing_roundtrip_and_reject_replay_or_wrong_key() {
        let root = SecretKeyBytes::from_hex(&"22".repeat(32)).unwrap();
        let stranger = SecretKeyBytes::from_hex(&"33".repeat(32)).unwrap();
        let replay = Mutex::new(DeviceAuthReplayCache::default());
        let now = now_ms();
        let route = "/handcash-device/v1/identities";

        let (hdr, nonce) = create_device_auth(&root, "GET", route, now).unwrap();
        assert_eq!(
            verify_device_auth(&root, Some(&hdr), "GET", route, &replay, now),
            Some(nonce.clone())
        );
        // Replay refused
        assert_eq!(
            verify_device_auth(&root, Some(&hdr), "GET", route, &replay, now),
            None
        );
        // Wrong key refused
        let (hdr2, _) = create_device_auth(&stranger, "GET", route, now).unwrap();
        assert_eq!(
            verify_device_auth(&root, Some(&hdr2), "GET", route, &replay, now),
            None
        );

        // Seal & open
        let payload = json!({ "hello": "world", "count": 3 });
        let sealed = seal_for_peer(&root, &nonce, &payload).unwrap();
        assert_eq!(open_from_peer(&root, &nonce, &sealed).unwrap(), payload);
        assert!(open_from_peer(&stranger, &nonce, &sealed).is_err());
    }

    #[test]
    fn direct_identities_endpoint_syncs_profiles_between_two_devices() {
        let dir_a = temp_dir("a");
        let dir_b = temp_dir("b");
        let svc_a = AppServices::open_in(dir_a, false).unwrap();
        let svc_b = AppServices::open_in(dir_b, false).unwrap();

        let phrase = "absurd avoid scissors anxiety gather lottery category door army half long cage bachelor another expect people blade school educate curtain scrub monitor lady beyond";
        let sum_a = svc_a
            .restore_vault(
                "alice",
                phrase,
                "",
                "Pass1234!",
                "main",
                handcash_primitives::keys::MnemonicScheme::Brc157,
            )
            .unwrap();
        let sum_b = svc_b
            .restore_vault(
                "alice",
                phrase,
                "",
                "Pass1234!",
                "main",
                handcash_primitives::keys::MnemonicScheme::Brc157,
            )
            .unwrap();
        assert_eq!(sum_a.identity_key, sum_b.identity_key);

        // Verify canonical BAP ID matches bap_id_for_deriver on both devices
        let expected_bap = handcash_primitives::keys::bap_id_for_deriver(
            &svc_a.session.lock().unwrap().as_ref().unwrap().deriver,
        )
        .unwrap();
        let view_a = svc_a.list_public_identities_view(&sum_a);
        assert_eq!(view_a.rows[0].bap_id, expected_bap);

        // Device A saves a profile; Device B does not have it.
        svc_a
            .save_public_identity_profile(&sum_a, &sum_a.identity_key, "Atlas Studio", "Creators", None)
            .unwrap();
        assert!(svc_b.identity_profile_for(&sum_b.chain, &sum_b.identity_key).is_none());
        let before = svc_b.resolve_issuer_display(&sum_b.chain, &sum_b.identity_key, None, true);
        assert_eq!(before.state, "key");

        let root_b = svc_b.session.lock().unwrap().as_ref().unwrap().deriver.root_key().clone();
        let route = "/handcash-device/v1/identities";
        let (hdr, nonce) = create_device_auth(&root_b, "GET", route, now_ms()).unwrap();
        let mut headers = HashMap::new();
        headers.insert(DEVICE_PEER_AUTH_HEADER.to_string(), hdr);

        let replay_a = Mutex::new(DeviceAuthReplayCache::default());
        let reply = handle_direct_device_peer_request(&svc_a, &replay_a, "GET", route, &headers, "");
        assert_eq!(reply.status, 200);
        assert!(!reply.body.contains("Atlas Studio"));

        let body_val: Value = serde_json::from_str(&reply.body).unwrap();
        let sealed = body_val.get("sealed").and_then(Value::as_str).unwrap();
        let bundle = open_from_peer(&root_b, &nonce, sealed).unwrap();
        let stats = merge_remote_identity_bundle(&svc_b, &sum_b.chain, &bundle);
        assert_eq!(stats.profiles_added, 1);

        let synced = svc_b
            .identity_profile_for(&sum_b.chain, &sum_b.identity_key)
            .expect("profile synced to device B");
        assert_eq!(synced.name, "Atlas Studio");
        assert_eq!(synced.description, "Creators");

        // After sync, resolve_issuer_display resolves the profile and verified trust state
        let after = svc_b.resolve_issuer_display(&sum_b.chain, &sum_b.identity_key, None, true);
        assert_eq!(after.label, "Atlas Studio");
        assert_eq!(after.state, "verified");
    }

    #[test]
    fn direct_identities_syncs_all_held_wallets_across_different_selected_accounts() {
        let dir_a = temp_dir("multi-a");
        let dir_b = temp_dir("multi-b");
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

        // Device A creates Account 1, saves a profile on Account 1, then switches back to Account 0.
        let (acc_a1, sum_a1) = svc_a.create_vault_account().unwrap();
        svc_a
            .save_public_identity_profile(
                &sum_a1,
                &sum_a1.identity_key,
                "Secondary Wallet",
                "Not selected on A",
                None,
            )
            .unwrap();
        svc_a.switch_vault_account(0).unwrap();
        svc_a
            .save_public_identity_profile(&sum_a0, &sum_a0.identity_key, "Primary Wallet", "Selected on A", None)
            .unwrap();

        // Device B is on Account 1 (different selected account than Device A!).
        let sum_b1 = svc_b.switch_vault_account(1).unwrap();
        assert_eq!(sum_b1.identity_key, acc_a1.identity_key);
        assert!(svc_b.account_profile_for(&sum_b1.chain, 0, &sum_a0.identity_key).is_none());
        assert!(svc_b.account_profile_for(&sum_b1.chain, 1, &sum_a1.identity_key).is_none());

        // Device B authenticates with its active Account 1 key while Device A has Account 0 selected.
        let root_b1 = svc_b.session.lock().unwrap().as_ref().unwrap().deriver.root_key().clone();
        let route = "/handcash-device/v1/identities";
        let (hdr, nonce) = create_device_auth(&root_b1, "GET", route, now_ms()).unwrap();
        let mut headers = HashMap::new();
        headers.insert(DEVICE_PEER_AUTH_HEADER.to_string(), hdr);

        let replay_a = Mutex::new(DeviceAuthReplayCache::default());
        let reply = handle_direct_device_peer_request(&svc_a, &replay_a, "GET", route, &headers, "");
        assert_eq!(reply.status, 200);

        let body_val: Value = serde_json::from_str(&reply.body).unwrap();
        let sealed = body_val.get("sealed").and_then(Value::as_str).unwrap();
        let bundle = open_from_peer(&root_b1, &nonce, sealed).unwrap();
        let pres = bundle
            .get("accountPresentations")
            .and_then(Value::as_array)
            .expect("accountPresentations exported for all held accounts");
        assert!(pres.len() >= 2);

        let stats = merge_remote_identity_bundle(&svc_b, &sum_b1.chain, &bundle);
        assert_eq!(stats.profiles_added, 2);
        assert!(stats.cards_added >= 2);

        let p0 = svc_b
            .account_profile_for(&sum_b1.chain, 0, &sum_a0.identity_key)
            .expect("Account 0 profile synced");
        assert_eq!(p0.name, "Primary Wallet");
        let p1 = svc_b
            .account_profile_for(&sum_b1.chain, 1, &sum_a1.identity_key)
            .expect("Account 1 profile synced");
        assert_eq!(p1.name, "Secondary Wallet");
    }
}
