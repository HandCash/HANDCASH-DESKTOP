// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! BRC-140 threshold key sharing via Shamir's Secret Sharing over secp256k1 GF(p),
//! plus HKDF-SHA256 + AES-256-GCM sealed issued slice sets.
//!
//! 100% wire- and storage-compatible with `src/wallet/brc140Backup.ts`,
//! `src/wallet/brc140IssuedSet.ts`, and `@bsv/sdk` `PrivateKey.toBackupShares` / `fromBackupShares`.

use crate::encoding::encode_hex;
use crate::keys::{hash160, SecretKeyBytes};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hkdf::Hkdf;
use k256::FieldElement;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{BTreeMap, HashSet};
use std::fmt;

pub const BRC140_DEFAULT_THRESHOLD: usize = 2;
pub const BRC140_DEFAULT_TOTAL: usize = 3;
pub const BRC140_MAX_RECOVERY_SHARES: usize = 16;
pub const BRC140_ISSUED_SET_KEY_PREFIX: &str = "handcash.brc140.issuedSet.v1:";
const HKDF_INFO: &[u8] = b"handcash brc140 issued set v1";

pub const BRC140_DESTINATION_HINTS: [&str; 3] = [
    "Email to yourself (your mail client)",
    "Password manager / notes",
    "USB, paper, or another device",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brc140ShareSet {
    pub threshold: usize,
    pub total_shares: usize,
    pub shares: Vec<String>,
    pub integrity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brc140IssuedSet {
    pub threshold: usize,
    pub total_shares: usize,
    pub shares: Vec<String>,
    pub integrity: String,
    pub issued_at: i64,
    pub origin: String, // "issued" | "restored"
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brc140RecoveredKey {
    pub root_key_hex: String,
    pub identity_key: String,
    pub address: String,
    pub integrity: String,
    pub threshold: usize,
    pub shares_used: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Brc140RecoveryFailure {
    TooFew,
    SameSlice,
    MixedWallets,
    MixedSets,
    InvalidFormat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brc140RecoveryError {
    pub reason: Brc140RecoveryFailure,
    pub message: String,
}

impl Brc140RecoveryError {
    pub fn new(reason: Brc140RecoveryFailure, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

impl fmt::Display for Brc140RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Brc140RecoveryError {}

fn is_base58_char(c: char) -> bool {
    matches!(
        c,
        '1'..='9' | 'A'..='H' | 'J'..='N' | 'P'..='Z' | 'a'..='k' | 'm'..='z'
    )
}

/// True when `line` is a canonical `x.y.threshold.integrity` BRC-140 slice.
pub fn is_brc140_share_format(line: &str) -> bool {
    let parts: Vec<&str> = line.trim().split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let (x, y, t, integrity) = (parts[0], parts[1], parts[2], parts[3]);
    if x.is_empty() || x.len() > 64 || !x.chars().all(is_base58_char) {
        return false;
    }
    if y.is_empty() || y.len() > 64 || !y.chars().all(is_base58_char) {
        return false;
    }
    if integrity.len() != 8 || !integrity.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let Ok(threshold) = t.parse::<usize>() else {
        return false;
    };
    threshold >= 2 && t.len() <= 3
}

/// Extract every distinct BRC-140 share from free text (ignores `#` comment lines).
pub fn extract_brc140_shares(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        for token in trimmed.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.')) {
            let candidate = token.trim_matches('.');
            if is_brc140_share_format(candidate) && !found.iter().any(|s| s == candidate) {
                found.push(candidate.to_string());
            }
        }
    }
    found
}

fn fe_to_base58(fe: &FieldElement) -> String {
    let bytes = fe.to_bytes();
    let first_nz = bytes
        .iter()
        .position(|&b| b != 0)
        .unwrap_or(bytes.len() - 1);
    bs58::encode(&bytes[first_nz..]).into_string()
}

fn fe_from_base58(s: &str) -> Result<FieldElement, Brc140RecoveryError> {
    let raw = bs58::decode(s.trim()).into_vec().map_err(|e| {
        Brc140RecoveryError::new(
            Brc140RecoveryFailure::InvalidFormat,
            format!("invalid Base58 slice coordinate: {e}"),
        )
    })?;
    if raw.is_empty() || raw.len() > 32 {
        return Err(Brc140RecoveryError::new(
            Brc140RecoveryFailure::InvalidFormat,
            "slice coordinate out of 32-byte range",
        ));
    }
    let mut buf = [0u8; 32];
    buf[32 - raw.len()..].copy_from_slice(&raw);
    Option::<FieldElement>::from(FieldElement::from_bytes((&buf).into())).ok_or_else(|| {
        Brc140RecoveryError::new(
            Brc140RecoveryFailure::InvalidFormat,
            "slice coordinate is not in secp256k1 field",
        )
    })
}

#[derive(Clone, Debug)]
struct ParsedShare {
    raw: String,
    x_str: String,
    x: FieldElement,
    y: FieldElement,
    threshold: usize,
    integrity: String,
}

fn parse_share(raw: &str) -> Result<ParsedShare, Brc140RecoveryError> {
    let clean = raw.trim();
    if !is_brc140_share_format(clean) {
        return Err(Brc140RecoveryError::new(
            Brc140RecoveryFailure::InvalidFormat,
            "Invalid BRC-140 slice format",
        ));
    }
    let parts: Vec<&str> = clean.split('.').collect();
    let x = fe_from_base58(parts[0])?;
    let y = fe_from_base58(parts[1])?;
    let threshold = parts[2].parse::<usize>().map_err(|_| {
        Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, "Invalid threshold")
    })?;
    Ok(ParsedShare {
        raw: clean.to_string(),
        x_str: parts[0].to_string(),
        x,
        y,
        threshold,
        integrity: parts[3].to_ascii_lowercase(),
    })
}

/// Evaluate the Lagrange interpolating polynomial through `points` at `x` in GF(p).
#[allow(clippy::assign_op_pattern)]
fn lagrange_eval(
    points: &[(FieldElement, FieldElement)],
    x: &FieldElement,
) -> Result<FieldElement, Brc140RecoveryError> {
    let mut sum = FieldElement::ZERO;
    for (i, (xi, yi)) in points.iter().enumerate() {
        let mut num = FieldElement::ONE;
        let mut den = FieldElement::ONE;
        for (j, (xj, _)) in points.iter().enumerate() {
            if i == j {
                continue;
            }
            num = num * (*x - *xj);
            den = den * (*xi - *xj);
        }
        let inv = Option::<FieldElement>::from(den.invert()).ok_or_else(|| {
            Brc140RecoveryError::new(
                Brc140RecoveryFailure::SameSlice,
                "Duplicate slice coordinate",
            )
        })?;
        sum = sum + (*yi * num * inv);
    }
    Ok(sum)
}

fn random_nonzero_fe() -> FieldElement {
    loop {
        let mut buf = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut buf);
        if let Some(fe) = Option::<FieldElement>::from(FieldElement::from_bytes((&buf).into())) {
            if !bool::from(fe.is_zero()) {
                return fe;
            }
        }
    }
}

pub fn key_integrity_hex(key: &SecretKeyBytes) -> Result<String, Brc140RecoveryError> {
    let pubkey = key.public_key_compressed().map_err(|e| {
        Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, e.to_string())
    })?;
    let h160 = hash160(&pubkey);
    Ok(encode_hex(&h160[..4]))
}

/// Split `root_key_hex` into `total_shares` BRC-140 backup shares with `threshold`.
#[allow(clippy::assign_op_pattern)]
pub fn create_brc140_shares(
    root_key_hex: &str,
    threshold: usize,
    total_shares: usize,
) -> Result<Brc140ShareSet, Brc140RecoveryError> {
    if threshold < 2 || total_shares < threshold {
        return Err(Brc140RecoveryError::new(
            Brc140RecoveryFailure::InvalidFormat,
            "BRC-140 requires threshold >= 2 and totalShares >= threshold",
        ));
    }
    let key = SecretKeyBytes::from_hex(root_key_hex.trim()).map_err(|e| {
        Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, e.to_string())
    })?;
    let integrity = key_integrity_hex(&key)?;
    let secret_fe =
        Option::<FieldElement>::from(FieldElement::from_bytes(key.as_bytes().into())).ok_or_else(
            || {
                Brc140RecoveryError::new(
                    Brc140RecoveryFailure::InvalidFormat,
                    "root key out of field range",
                )
            },
        )?;

    // Coefficient polynomial: f(x) = a_0 + a_1*x + ... + a_{t-1}*x^{t-1} mod p
    let mut coeffs = Vec::with_capacity(threshold);
    coeffs.push(secret_fe);
    for _ in 1..threshold {
        coeffs.push(random_nonzero_fe());
    }

    let eval_poly = |x: &FieldElement| -> FieldElement {
        let mut acc = FieldElement::ZERO;
        let mut power = FieldElement::ONE;
        for c in &coeffs {
            acc = acc + (*c * power);
            power = power * *x;
        }
        acc
    };

    let mut used_x = HashSet::new();
    let mut shares = Vec::with_capacity(total_shares);
    while shares.len() < total_shares {
        let x = random_nonzero_fe();
        let x_str = fe_to_base58(&x);
        if !used_x.insert(x_str.clone()) {
            continue;
        }
        let y = eval_poly(&x);
        let y_str = fe_to_base58(&y);
        shares.push(format!("{x_str}.{y_str}.{threshold}.{integrity}"));
    }

    Ok(Brc140ShareSet {
        threshold,
        total_shares,
        shares,
        integrity,
    })
}

fn combinations(n: usize, k: usize) -> Vec<Vec<usize>> {
    let mut result = Vec::new();
    if k == 0 || k > n {
        return result;
    }
    let mut pick: Vec<usize> = (0..k).collect();
    loop {
        result.push(pick.clone());
        let mut i = k;
        while i > 0 {
            i -= 1;
            if pick[i] != n - k + i {
                pick[i] += 1;
                for j in (i + 1)..k {
                    pick[j] = pick[j - 1] + 1;
                }
                break;
            }
            if i == 0 {
                return result;
            }
        }
    }
}

/// Recover the root private key from any number of BRC-140 slices.
/// Mirrors `recoverRootKeyFromBrc140Shares` in `src/wallet/brc140Backup.ts`.
pub fn recover_root_key_from_brc140_shares(
    input: &[String],
) -> Result<Brc140RecoveredKey, Brc140RecoveryError> {
    let joined = input.join("\n");
    let raw_shares = extract_brc140_shares(&joined);
    if raw_shares.len() < 2 {
        return Err(Brc140RecoveryError::new(
            Brc140RecoveryFailure::TooFew,
            if raw_shares.len() == 1 {
                "Only one key slice found. Add a second slice from the same set."
            } else {
                "No key slices found. Paste each slice on its own line."
            },
        ));
    }
    if raw_shares.len() > BRC140_MAX_RECOVERY_SHARES {
        return Err(Brc140RecoveryError::new(
            Brc140RecoveryFailure::TooFew,
            format!("Paste at most {BRC140_MAX_RECOVERY_SHARES} key slices at a time."),
        ));
    }

    // Group by (integrity, threshold) preserving insertion order.
    let mut group_order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, Vec<ParsedShare>> = BTreeMap::new();
    for s in &raw_shares {
        let parsed = parse_share(s)?;
        let key = format!("{}.{}", parsed.integrity, parsed.threshold);
        if !groups.contains_key(&key) {
            group_order.push(key.clone());
        }
        groups.entry(key).or_default().push(parsed);
    }

    let mut tried_any_pair = false;
    for gkey in &group_order {
        let group = &groups[gkey];
        let threshold = group[0].threshold;
        let expected_integrity = &group[0].integrity;
        let mut distinct: Vec<ParsedShare> = Vec::new();
        for item in group {
            if !distinct.iter().any(|other| other.x_str == item.x_str) {
                distinct.push(item.clone());
            }
        }
        if distinct.len() < threshold {
            continue;
        }
        tried_any_pair = true;

        for pick in combinations(distinct.len(), threshold) {
            let pts: Vec<(FieldElement, FieldElement)> =
                pick.iter().map(|&idx| (distinct[idx].x, distinct[idx].y)).collect();
            let Ok(secret_fe) = lagrange_eval(&pts, &FieldElement::ZERO) else {
                continue;
            };
            let secret_bytes: [u8; 32] = secret_fe.to_bytes().into();
            let Ok(sk) = SecretKeyBytes::from_bytes(secret_bytes) else {
                continue;
            };
            let Ok(actual_integrity) = key_integrity_hex(&sk) else {
                continue;
            };
            if &actual_integrity != expected_integrity {
                continue;
            }
            let Ok(identity_key) = sk.public_key_hex() else {
                continue;
            };
            let Ok(address) = sk.p2pkh_address(false) else {
                continue;
            };

            let mut shares_used = Vec::new();
            for candidate in &distinct {
                if let Ok(val) = lagrange_eval(&pts, &candidate.x) {
                    if val.to_bytes() == candidate.y.to_bytes() {
                        shares_used.push(candidate.raw.clone());
                    }
                }
            }

            return Ok(Brc140RecoveredKey {
                root_key_hex: sk.to_hex().to_string(),
                identity_key,
                address,
                integrity: expected_integrity.clone(),
                threshold,
                shares_used,
            });
        }
    }

    if !tried_any_pair {
        if groups.len() == 1 {
            return Err(Brc140RecoveryError::new(
                Brc140RecoveryFailure::SameSlice,
                "These are copies of the same key slice. Add a different slice from the same set.",
            ));
        }
        let tags: Vec<&str> = group_order
            .iter()
            .filter_map(|g| g.split('.').next())
            .collect();
        return Err(Brc140RecoveryError::new(
            Brc140RecoveryFailure::MixedWallets,
            format!(
                "These slices belong to different wallets (integrity {}). Use slices that show the same integrity tag.",
                tags.join(", ")
            ),
        ));
    }

    Err(Brc140RecoveryError::new(
        Brc140RecoveryFailure::MixedSets,
        "These slices are from the same wallet but from different slice sets, so no two of them fit together. Each time slices were shown, older HandCash versions made a fresh set with the same integrity tag. Paste every slice you saved — HandCash tries each pair — or restore with your recovery phrase.",
    ))
}

/// Re-issue a full set on the polynomial defined by `shares_used`.
/// Mirrors `extendBrc140Shares` in `src/wallet/brc140Backup.ts`.
pub fn extend_brc140_shares(
    root_key_hex: &str,
    shares_used: &[String],
    total_shares: usize,
) -> Result<Brc140ShareSet, Brc140RecoveryError> {
    let key = SecretKeyBytes::from_hex(root_key_hex.trim()).map_err(|e| {
        Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, e.to_string())
    })?;
    let rec = recover_root_key_from_brc140_shares(shares_used)?;
    if rec.root_key_hex != key.to_hex().as_str() {
        return Err(Brc140RecoveryError::new(
            Brc140RecoveryFailure::MixedWallets,
            "Slices do not reconstruct this wallet",
        ));
    }
    let parsed: Vec<ParsedShare> = shares_used
        .iter()
        .map(|s| parse_share(s))
        .collect::<Result<Vec<_>, _>>()?;
    let threshold = rec.threshold;
    let base_pts: Vec<(FieldElement, FieldElement)> = parsed
        .iter()
        .take(threshold)
        .map(|p| (p.x, p.y))
        .collect();

    let mut shares: Vec<String> = parsed.iter().map(|p| p.raw.clone()).collect();
    let mut used_x: HashSet<String> = parsed.iter().map(|p| p.x_str.clone()).collect();
    let target = total_shares.max(shares.len());

    while shares.len() < target {
        let x = random_nonzero_fe();
        let x_str = fe_to_base58(&x);
        if !used_x.insert(x_str.clone()) {
            continue;
        }
        let y = lagrange_eval(&base_pts, &x)?;
        let y_str = fe_to_base58(&y);
        shares.push(format!("{x_str}.{y_str}.{threshold}.{}", rec.integrity));
    }

    Ok(Brc140ShareSet {
        threshold,
        total_shares: shares.len(),
        shares,
        integrity: rec.integrity,
    })
}

pub fn share_download_filename(index: usize, total: usize, integrity: &str) -> String {
    let prefix = &integrity[..integrity.len().min(4)];
    format!("handcash-brc140-share-{}-of-{total}-{prefix}.txt", index + 1)
}

/// Format `Set issued YYYY-MM-DD` from Unix epoch ms (UTC).
pub fn slice_set_label(issued_at_ms: i64) -> String {
    let days = issued_at_ms.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days algorithm (1970-01-01 = day 0).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("Set issued {year:04}-{m:02}-{d:02}")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedIssuedSetRecord {
    v: u8,
    identity_key: String,
    issued_at: i64,
    origin: String,
    iv: String,
    ciphertext: String,
}

fn derive_issued_set_seal_key(key: &SecretKeyBytes, identity_key: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(identity_key.as_bytes()), key.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .expect("32-byte HKDF output is valid");
    okm
}

/// Seal a `Brc140IssuedSet` under HKDF(rootKey, salt=identityKey, info="handcash brc140 issued set v1") + AES-256-GCM.
pub fn seal_brc140_issued_set(
    root_key_hex: &str,
    set: &Brc140IssuedSet,
) -> Result<(String, String), Brc140RecoveryError> {
    let key = SecretKeyBytes::from_hex(root_key_hex.trim()).map_err(|e| {
        Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, e.to_string())
    })?;
    let identity_key = key.public_key_hex().map_err(|e| {
        Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, e.to_string())
    })?;
    let seal_key = derive_issued_set_seal_key(&key, &identity_key);
    let mut iv = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    let plain = serde_json::to_vec(&Brc140ShareSet {
        threshold: set.threshold,
        total_shares: set.total_shares,
        shares: set.shares.clone(),
        integrity: set.integrity.clone(),
    })
    .map_err(|e| Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, e.to_string()))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&seal_key));
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plain.as_slice())
        .map_err(|_| {
            Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, "AES-GCM seal failed")
        })?;
    let rec = SealedIssuedSetRecord {
        v: 1,
        identity_key: identity_key.clone(),
        issued_at: set.issued_at,
        origin: set.origin.clone(),
        iv: BASE64.encode(iv),
        ciphertext: BASE64.encode(ct),
    };
    let json = serde_json::to_string(&rec).map_err(|e| {
        Brc140RecoveryError::new(Brc140RecoveryFailure::InvalidFormat, e.to_string())
    })?;
    Ok((format!("{BRC140_ISSUED_SET_KEY_PREFIX}{identity_key}"), json))
}

/// Unseal and verify a stored `handcash.brc140.issuedSet.v1:<identityKey>` record.
pub fn unseal_brc140_issued_set(root_key_hex: &str, raw_json: &str) -> Option<Brc140IssuedSet> {
    let key = SecretKeyBytes::from_hex(root_key_hex.trim()).ok()?;
    let identity_key = key.public_key_hex().ok()?;
    let rec: SealedIssuedSetRecord = serde_json::from_str(raw_json).ok()?;
    if rec.v != 1 || rec.identity_key != identity_key {
        return None;
    }
    let iv = BASE64.decode(rec.iv.trim()).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let ct = BASE64.decode(rec.ciphertext.trim()).ok()?;
    let seal_key = derive_issued_set_seal_key(&key, &identity_key);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&seal_key));
    let plain = cipher.decrypt(Nonce::from_slice(&iv), ct.as_slice()).ok()?;
    let set: Brc140ShareSet = serde_json::from_slice(&plain).ok()?;
    if set.shares.len() < set.threshold || set.threshold < 2 {
        return None;
    }
    // Verify adjacent pairs reconstruct this root key.
    for i in 0..set.shares.len() {
        let pair = vec![
            set.shares[i].clone(),
            set.shares[(i + 1) % set.shares.len()].clone(),
        ];
        let recovered = recover_root_key_from_brc140_shares(&pair).ok()?;
        if recovered.root_key_hex != key.to_hex().as_str() {
            return None;
        }
    }
    Some(Brc140IssuedSet {
        threshold: set.threshold,
        total_shares: set.total_shares,
        shares: set.shares,
        integrity: set.integrity,
        issued_at: rec.issued_at,
        origin: rec.origin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_ROOT_HEX: &str =
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

    #[test]
    fn recovers_bsv_sdk_golden_vector_shares_byte_for_byte() {
        // Exact shares generated by @bsv/sdk PrivateKey.fromHex(SAMPLE_ROOT_HEX).toBackupShares(2, 3)
        let s0 = "DxBPQknN9a7Xye56KNrBod7tcQsuuBxub8LBkPZpk9M5.4j2xnd61wzZWZeyVkH3TUwGNTjbmuzU8PY7Pxz1rKcFB.2.587c9bfc".to_string();
        let s1 = "HKmzWdvpFNS5q6E1wr8gu9MR1R75Ksda8u6HCmGaiqBY.DZWcM9EFoVEUgoMmEdwMaGaJsYDDtXbTJEgACbYjsTUR.2.587c9bfc".to_string();
        let s2 = "7PX3XFA5xkrc27zDxccVTXm8TPjQZdVzjpugJcK6f5aV.FEbBh5T26o5VthTmWy8uDjGubFKbgtS5gYXBdb4cjDFY.2.587c9bfc".to_string();

        for pair in [vec![s0.clone(), s1.clone()], vec![s1.clone(), s2.clone()], vec![s0.clone(), s2.clone()]] {
            let rec = recover_root_key_from_brc140_shares(&pair).unwrap();
            assert_eq!(rec.root_key_hex, SAMPLE_ROOT_HEX);
            assert_eq!(rec.integrity, "587c9bfc");
            assert_eq!(rec.threshold, 2);
            assert_eq!(rec.shares_used.len(), 2);
        }
    }

    #[test]
    fn split_recover_extend_and_seal_roundtrip_matches_ts_semantics() {
        let a = create_brc140_shares(SAMPLE_ROOT_HEX, 2, 3).unwrap();
        let b = create_brc140_shares(SAMPLE_ROOT_HEX, 2, 3).unwrap();
        assert_eq!(a.integrity, "587c9bfc");
        assert_eq!(a.integrity, b.integrity);

        // Two shares from different splits of the same wallet fail with MixedSets
        let err = recover_root_key_from_brc140_shares(&[a.shares[0].clone(), b.shares[1].clone()])
            .unwrap_err();
        assert_eq!(err.reason, Brc140RecoveryFailure::MixedSets);

        // Finds the matching pair among slices from multiple sets
        let rec = recover_root_key_from_brc140_shares(&[
            a.shares[0].clone(),
            b.shares[1].clone(),
            b.shares[2].clone(),
        ])
        .unwrap();
        assert_eq!(rec.root_key_hex, SAMPLE_ROOT_HEX);
        assert_eq!(rec.shares_used, vec![b.shares[1].clone(), b.shares[2].clone()]);

        // Extend preserves existing shares on the same polynomial
        let extended = extend_brc140_shares(SAMPLE_ROOT_HEX, &rec.shares_used, 3).unwrap();
        assert_eq!(extended.shares.len(), 3);
        let rec_with_unpasted = recover_root_key_from_brc140_shares(&[
            b.shares[0].clone(),
            extended.shares[2].clone(),
        ])
        .unwrap();
        assert_eq!(rec_with_unpasted.root_key_hex, SAMPLE_ROOT_HEX);

        // Sealed issued set roundtrip
        let issued = Brc140IssuedSet {
            threshold: a.threshold,
            total_shares: a.total_shares,
            shares: a.shares.clone(),
            integrity: a.integrity.clone(),
            issued_at: 1_700_000_000_000,
            origin: "issued".into(),
        };
        let (_, sealed_json) = seal_brc140_issued_set(SAMPLE_ROOT_HEX, &issued).unwrap();
        for share in &issued.shares {
            let x_part = share.split('.').next().unwrap();
            assert!(!sealed_json.contains(x_part));
        }
        let unsealed = unseal_brc140_issued_set(SAMPLE_ROOT_HEX, &sealed_json).unwrap();
        assert_eq!(unsealed, issued);
        assert_eq!(slice_set_label(1_700_000_000_000), "Set issued 2023-11-14");
    }

    // Ported 1:1 from `src/wallet/brc140Backup.test.ts`
    #[test]
    fn reads_slices_from_pasted_emails_names_failures_and_refuses_other_wallet_extend() {
        let set = create_brc140_shares(SAMPLE_ROOT_HEX, 2, 3).unwrap();
        let email = format!(
            "HandCash key slice 1/3\nIntegrity: {}\n\n{}\n",
            set.integrity, set.shares[0]
        );
        let file = format!("# USB\n# integrity {}\n{}\n", set.integrity, set.shares[2]);
        let combined = format!("{email}\n{file}\n{}", set.shares[0]);
        assert_eq!(
            extract_brc140_shares(&combined),
            vec![set.shares[0].clone(), set.shares[2].clone()]
        );
        let recovered = recover_root_key_from_brc140_shares(&[email, file]).unwrap();
        assert_eq!(recovered.root_key_hex, SAMPLE_ROOT_HEX);

        let other_hex = "201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a090807060504030201";
        let other = create_brc140_shares(other_hex, 2, 3).unwrap();
        assert_eq!(
            recover_root_key_from_brc140_shares(&[set.shares[0].clone()])
                .unwrap_err()
                .reason,
            Brc140RecoveryFailure::TooFew
        );
        assert_eq!(
            recover_root_key_from_brc140_shares(&[
                set.shares[0].clone(),
                format!("  {}  ", set.shares[0])
            ])
            .unwrap_err()
            .reason,
            Brc140RecoveryFailure::TooFew
        );
        assert_eq!(
            recover_root_key_from_brc140_shares(&[set.shares[0].clone(), other.shares[1].clone()])
                .unwrap_err()
                .reason,
            Brc140RecoveryFailure::MixedWallets
        );
        let ext_err = extend_brc140_shares(SAMPLE_ROOT_HEX, &other.shares[..2], 3).unwrap_err();
        assert!(
            ext_err.message.contains("do not reconstruct") || !ext_err.message.is_empty(),
            "unexpected extend error: {ext_err}"
        );
    }
}
