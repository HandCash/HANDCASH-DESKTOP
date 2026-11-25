// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Asset issuer metadata (BRC-247 MAP SET issuer + Sigma BRC-77/BSM verification),
//! BAP identity package verification (BRC-248), HandCash verified-issuer list
//! signature checking, and issuer trust-state classification.

use crate::beef::Beef;
use crate::tx::Transaction;
use base64::Engine as _;
use handcash_primitives::encoding::{decode_hex, sha256};
use handcash_primitives::keys::{
    anyone_private_key, bap_id_for_address, p2pkh_address_from_pubkey, parse_public_key_point,
    verify_brc77_anyone, verify_bsm, Counterparty, KeyDeriver,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Bitcom MAP protocol prefix (`1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5`).
const MAP_PREFIX: &[u8] = b"1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";
/// BAP protocol prefix (`1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT`).
const BAP_PREFIX: &[u8] = b"1BAPSuaPnfGnSBM3GLV9yhxUdYe4vGbdMT";
/// AIP protocol prefix (`15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva`).
const AIP_PREFIX: &[u8] = b"15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const SIGMA_PREFIX: &[u8] = b"SIGMA";
const ISSUER_PUSH: &[u8] = &[0x06, b'i', b's', b's', b'u', b'e', b'r'];
const OP_RETURN: u8 = 0x6a;

/// Pinned HandCash certifier public key (`HANDLE_CERTIFIERS[HOME_HANDLE_DOMAIN]`).
pub const HANDCASH_VERIFIED_ISSUERS_CERTIFIER: &str =
    "027bf8f661e41618907329e78a0460ffe4a9b3c59dbc9fda49ccb4e08317b7de55";

/// Lowercase compressed 33-byte secp256k1 public key on the curve, or `None`.
pub fn normalize_issuer_identity_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() != 66 {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("02") || lower.starts_with("03")) {
        return None;
    }
    let bytes = decode_hex(&lower).ok()?;
    if bytes.len() != 33 {
        return None;
    }
    parse_public_key_point(&bytes).ok()?;
    Some(lower)
}

/// Canonical BAP ID: base58 of a 20-byte hash.
pub fn normalize_bap_id(value: &str) -> Option<String> {
    let id = value.trim();
    if !(20..=40).contains(&id.len()) {
        return None;
    }
    let decoded = bs58::decode(id).into_vec().ok()?;
    if decoded.len() == 20 {
        Some(id.to_string())
    } else {
        None
    }
}

#[derive(Clone, Debug)]
struct ScriptChunk<'a> {
    op: u8,
    data: Option<&'a [u8]>,
    start: usize,
}

fn parse_script_chunks(script: &[u8]) -> Vec<ScriptChunk<'_>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < script.len() {
        let start = i;
        let op = script[i];
        match op {
            1..=75 => {
                let len = op as usize;
                if i + 1 + len > script.len() {
                    break;
                }
                out.push(ScriptChunk {
                    op,
                    data: Some(&script[i + 1..i + 1 + len]),
                    start,
                });
                i += 1 + len;
            }
            0x4c => {
                if i + 2 > script.len() {
                    break;
                }
                let len = script[i + 1] as usize;
                if i + 2 + len > script.len() {
                    break;
                }
                out.push(ScriptChunk {
                    op,
                    data: Some(&script[i + 2..i + 2 + len]),
                    start,
                });
                i += 2 + len;
            }
            0x4d => {
                if i + 3 > script.len() {
                    break;
                }
                let len = u16::from_le_bytes([script[i + 1], script[i + 2]]) as usize;
                if i + 3 + len > script.len() {
                    break;
                }
                out.push(ScriptChunk {
                    op,
                    data: Some(&script[i + 3..i + 3 + len]),
                    start,
                });
                i += 3 + len;
            }
            0x4e => {
                if i + 5 > script.len() {
                    break;
                }
                let len = u32::from_le_bytes([
                    script[i + 1],
                    script[i + 2],
                    script[i + 3],
                    script[i + 4],
                ]) as usize;
                if i + 5 + len > script.len() {
                    break;
                }
                out.push(ScriptChunk {
                    op,
                    data: Some(&script[i + 5..i + 5 + len]),
                    start,
                });
                i += 5 + len;
            }
            _ => {
                out.push(ScriptChunk {
                    op,
                    data: None,
                    start,
                });
                i += 1;
            }
        }
    }
    out
}

fn chunk_text<'a>(chunks: &'a [ScriptChunk<'a>], i: usize) -> &'a str {
    match chunks.get(i).and_then(|c| c.data) {
        Some(d) if d.len() <= 4096 => std::str::from_utf8(d).unwrap_or(""),
        _ => "",
    }
}

/// Issuer metadata extracted from a Bitcom `MAP SET issuer <key> [bapId <id>]` tape.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IssuerTapeMetadata {
    pub issuer: Option<String>,
    pub bap_id: Option<String>,
}

/// Exact Rust port of `src/wallet/issuerMetadata.ts` (`issuerMetadataFromScript`).
pub fn issuer_metadata_from_script(script: &[u8]) -> IssuerTapeMetadata {
    if script.is_empty() || script.len() > 1_000_000 {
        return IssuerTapeMetadata::default();
    }
    if !script.windows(ISSUER_PUSH.len()).any(|w| w == ISSUER_PUSH) {
        return IssuerTapeMetadata::default();
    }
    let chunks = parse_script_chunks(script);
    if chunks.len() < 5 {
        return IssuerTapeMetadata::default();
    }
    let mut result: Option<IssuerTapeMetadata> = None;
    for i in 1..chunks.len().saturating_sub(3) {
        if chunks[i].data != Some(MAP_PREFIX)
            || chunk_text(&chunks, i + 1) != "SET"
            || chunk_text(&chunks, i + 2) != "issuer"
        {
            continue;
        }
        let prev_ok = chunks[i - 1].op == OP_RETURN || chunk_text(&chunks, i - 1) == "|";
        if !prev_ok {
            continue;
        }
        let Some(issuer) = normalize_issuer_identity_key(chunk_text(&chunks, i + 3)) else {
            return IssuerTapeMetadata::default();
        };
        if result.is_some() {
            return IssuerTapeMetadata::default();
        }
        let bap_id = if chunk_text(&chunks, i + 4) == "bapId" {
            normalize_bap_id(chunk_text(&chunks, i + 5))
        } else {
            None
        };
        result = Some(IssuerTapeMetadata {
            issuer: Some(issuer),
            bap_id,
        });
    }
    result.unwrap_or_default()
}

/// Verified Sigma signature bound to a transaction input and output script prefix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigmaSigner {
    pub algorithm: String,
    pub address: String,
    pub identity_key: Option<String>,
}

/// Compute Sigma's input hash: `sha256(display_order_txid_bytes || vout_le_u32)`.
fn sigma_input_hash(prev_txid: &str, prev_vout: u32) -> Option<[u8; 32]> {
    let txid_bytes = decode_hex(prev_txid).ok()?;
    if txid_bytes.len() != 32 {
        return None;
    }
    let mut buf = [0u8; 36];
    buf[0..32].copy_from_slice(&txid_bytes);
    buf[32..36].copy_from_slice(&prev_vout.to_le_bytes());
    Some(sha256(&buf))
}

/// Verify Sigma signatures on `tx.outputs[vout]` (`BRC77` or `BSM`), returning the first verified signer.
pub fn verified_sigma_signer(tx: &Transaction, vout: usize) -> Option<SigmaSigner> {
    let output = tx.outputs.get(vout)?;
    let script = &output.locking_script;
    if !script.windows(SIGMA_PREFIX.len()).any(|w| w == SIGMA_PREFIX) {
        return None;
    }
    let chunks = parse_script_chunks(script);
    for i in 1..chunks.len().saturating_sub(3) {
        if chunks[i].data != Some(SIGMA_PREFIX) {
            continue;
        }
        let prev_is_pipe = chunk_text(&chunks, i - 1) == "|";
        let prev_is_op_return = chunks[i - 1].op == OP_RETURN;
        if !prev_is_pipe && !prev_is_op_return {
            continue;
        }
        let alg = chunk_text(&chunks, i + 1).trim();
        let address = chunk_text(&chunks, i + 2).trim();
        let Some(sig_bytes) = chunks.get(i + 3).and_then(|c| c.data) else {
            continue;
        };
        let vin: usize = chunk_text(&chunks, i + 4)
            .trim()
            .parse::<usize>()
            .unwrap_or(0);
        let Some(input) = tx.inputs.get(vin) else {
            continue;
        };
        let Some(in_hash) = sigma_input_hash(&input.prev_txid, input.prev_vout) else {
            continue;
        };
        let data_end = chunks[i - 1].start;
        let data_hash = sha256(&script[..data_end]);
        let mut combined = [0u8; 64];
        combined[0..32].copy_from_slice(&in_hash);
        combined[32..64].copy_from_slice(&data_hash);
        let msg_hash = sha256(&combined);

        if alg.eq_ignore_ascii_case("BRC77") {
            if let Some(signer_key) = verify_brc77_anyone(&msg_hash, sig_bytes) {
                let pub_bytes = decode_hex(&signer_key).ok()?;
                let derived_addr = p2pkh_address_from_pubkey(&pub_bytes, false);
                if address.is_empty()
                    || address == derived_addr
                    || address.eq_ignore_ascii_case(&signer_key)
                {
                    return Some(SigmaSigner {
                        algorithm: "BRC77".into(),
                        address: derived_addr,
                        identity_key: Some(signer_key),
                    });
                }
            }
        } else if alg.eq_ignore_ascii_case("BSM")
            && !address.is_empty()
            && verify_bsm(&msg_hash, sig_bytes, address)
        {
            return Some(SigmaSigner {
                algorithm: "BSM".into(),
                address: address.to_string(),
                identity_key: None,
            });
        }
    }
    None
}

/// True when `signer` proves `issuer_key` (direct compressed pubkey match for BRC-77, or P2PKH address match for BSM).
pub fn sigma_signer_matches(signer: &SigmaSigner, issuer_key: &str) -> bool {
    let Some(norm) = normalize_issuer_identity_key(issuer_key) else {
        return false;
    };
    if let Some(ref ik) = signer.identity_key {
        if ik.eq_ignore_ascii_case(&norm) {
            return true;
        }
    }
    if let Ok(pub_bytes) = decode_hex(&norm) {
        if p2pkh_address_from_pubkey(&pub_bytes, false) == signer.address {
            return true;
        }
    }
    false
}

/// Issuer fields extracted from a transaction, BEEF, or custom instructions.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExtractedItemIssuer {
    pub issuer_key: Option<String>,
    pub bap_id: Option<String>,
    pub signer: Option<String>,
    pub issuer_attested: bool,
    pub provenance_origin: Option<String>,
}

/// Parse an outpoint `txid.vout` or `txid_vout` into `(lowercase_txid, vout)`.
pub fn parse_outpoint(outpoint: &str) -> Option<(String, usize)> {
    let clean = outpoint.trim();
    let (txid, vout_str) = clean.rsplit_once('.').or_else(|| clean.rsplit_once('_'))?;
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let vout = vout_str.parse::<usize>().ok()?;
    Some((txid.to_ascii_lowercase(), vout))
}

/// Extract MAP issuer tape + verified Sigma signer from a single transaction output.
pub fn extract_issuer_from_tx(tx: &Transaction, vout: usize) -> ExtractedItemIssuer {
    let Some(output) = tx.outputs.get(vout) else {
        return ExtractedItemIssuer::default();
    };
    let tape = issuer_metadata_from_script(&output.locking_script);
    let sigma = verified_sigma_signer(tx, vout);
    let mut out = ExtractedItemIssuer {
        issuer_key: tape.issuer,
        bap_id: tape.bap_id,
        signer: sigma
            .as_ref()
            .and_then(|s| s.identity_key.clone().or_else(|| Some(s.address.clone()))),
        issuer_attested: false,
        provenance_origin: None,
    };
    if let Some(ref sig) = sigma {
        if let Some(ref key) = out.issuer_key {
            out.issuer_attested = sigma_signer_matches(sig, key);
        } else if let Some(ref ik) = sig.identity_key {
            out.issuer_key = Some(ik.clone());
            out.issuer_attested = true;
        }
    }
    out
}

/// Extract issuer attribution from BEEF bytes for `origin_outpoint`.
pub fn extract_issuer_from_beef(beef_bytes: &[u8], origin_outpoint: &str) -> Option<ExtractedItemIssuer> {
    let (txid, vout) = parse_outpoint(origin_outpoint)?;
    let beef = Beef::from_bytes(beef_bytes).ok()?;
    let entry = beef.txs.get(&txid)?;
    let tx = entry.tx.as_ref()?;
    Some(extract_issuer_from_tx(tx, vout))
}

/// Extract issuer fields and any embedded BRC-150 provenance BEEF from `custom_instructions` JSON.
pub fn extract_issuer_from_custom_instructions(
    ci_json: &str,
    fallback_origin: &str,
) -> ExtractedItemIssuer {
    let Ok(v) = serde_json::from_str::<Value>(ci_json) else {
        return ExtractedItemIssuer::default();
    };
    let mut out = ExtractedItemIssuer::default();
    if let Some(iss) = v
        .get("issuer")
        .or_else(|| v.get("issuerKey"))
        .and_then(Value::as_str)
        .and_then(normalize_issuer_identity_key)
    {
        out.issuer_key = Some(iss);
    }
    if let Some(bap) = v
        .get("bapId")
        .and_then(Value::as_str)
        .and_then(normalize_bap_id)
    {
        out.bap_id = Some(bap);
    }

    let prov_origin = v
        .get("provenance")
        .and_then(|p| p.get("origin"))
        .and_then(Value::as_str)
        .or_else(|| v.get("origin").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('_', "."));
    out.provenance_origin = prov_origin.clone();

    let effective_origin = prov_origin.as_deref().unwrap_or(fallback_origin);
    let beef_b64 = v
        .get("provenance")
        .and_then(|p| p.get("beefB64").or_else(|| p.get("beef")))
        .or_else(|| {
            v.get("remittance")
                .and_then(|r| r.get("beefB64").or_else(|| r.get("beef")))
        })
        .or_else(|| v.get("beefB64"))
        .and_then(Value::as_str);
    if let Some(b64) = beef_b64 {
        if let Ok(beef_bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
            if let Some(from_beef) = extract_issuer_from_beef(&beef_bytes, effective_origin) {
                if from_beef.issuer_key.is_some() {
                    out.issuer_key = from_beef.issuer_key;
                }
                if from_beef.bap_id.is_some() {
                    out.bap_id = from_beef.bap_id;
                }
                if from_beef.signer.is_some() {
                    out.signer = from_beef.signer;
                }
                if from_beef.issuer_attested {
                    out.issuer_attested = true;
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// BAP Identity Package verification (BRC-248 / `src/wallet/issuerIdentity.ts`)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBapIdentity {
    pub bap_id: String,
    pub name: String,
    pub description: String,
    pub image_data_url: Option<String>,
    pub active_address: String,
    pub revoked: bool,
    pub linked_identity_keys: Vec<String>,
}

fn verify_aip_on_bap_chunks(chunks: &[ScriptChunk<'_>], bap_start: usize) -> Option<String> {
    let mut aip_idx = None;
    for i in (bap_start + 1)..chunks.len().saturating_sub(3) {
        if chunks[i].data == Some(AIP_PREFIX) && chunk_text(chunks, i - 1) == "|" {
            aip_idx = Some(i);
            break;
        }
    }
    let aip_i = aip_idx?;
    let alg = chunk_text(chunks, aip_i + 1);
    if alg != "BITCOIN_ECDSA" {
        return None;
    }
    let address = chunk_text(chunks, aip_i + 2).trim();
    let sig_raw = chunks.get(aip_i + 3)?.data?;
    let sig_bytes = if sig_raw.len() == 65 {
        sig_raw.to_vec()
    } else if let Ok(s) = std::str::from_utf8(sig_raw) {
        base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .ok()?
    } else {
        return None;
    };

    let mut msg = Vec::new();
    msg.push(OP_RETURN);
    for c in &chunks[bap_start..aip_i] {
        if let Some(d) = c.data {
            msg.extend_from_slice(d);
        }
    }
    if verify_bsm(&msg, &sig_bytes, address) {
        return Some(address.to_string());
    }
    if verify_bsm(&msg[1..], &sig_bytes, address) {
        return Some(address.to_string());
    }
    None
}

fn parse_identity_link_in_tx(
    tx: &Transaction,
    vout: usize,
) -> Option<(bool, String, String, Option<String>)> {
    let output = tx.outputs.get(vout)?;
    let script = &output.locking_script;
    if !script.windows(9).any(|w| w == b"identity-") {
        return None;
    }
    let chunks = parse_script_chunks(script);
    let mut kind_is_link: Option<bool> = None;
    let mut ik: Option<String> = None;
    let mut bap: Option<String> = None;
    for i in 1..chunks.len().saturating_sub(3) {
        if chunks[i].data == Some(MAP_PREFIX) && chunk_text(&chunks, i + 1) == "SET" {
            let mut j = i + 2;
            while j + 1 < chunks.len() {
                if chunk_text(&chunks, j) == "|" {
                    break;
                }
                let k = chunk_text(&chunks, j);
                let v = chunk_text(&chunks, j + 1);
                match k {
                    "type" => {
                        if v == "identity-link" {
                            kind_is_link = Some(true);
                        } else if v == "identity-unlink" {
                            kind_is_link = Some(false);
                        }
                    }
                    "identityKey" => ik = normalize_issuer_identity_key(v),
                    "bapId" => bap = normalize_bap_id(v),
                    _ => {}
                }
                j += 2;
            }
            break;
        }
    }
    let is_link = kind_is_link?;
    let identity_key = ik?;
    let bap_id = bap?;
    let mut has_identity_sig = false;
    let mut bap_signer_addr: Option<String> = None;
    for i in 1..chunks.len().saturating_sub(3) {
        if chunks[i].data != Some(SIGMA_PREFIX) {
            continue;
        }
        if chunk_text(&chunks, i - 1) != "|" && chunks[i - 1].op != OP_RETURN {
            continue;
        }
        let alg = chunk_text(&chunks, i + 1).trim();
        let address = chunk_text(&chunks, i + 2).trim();
        let Some(sig_bytes) = chunks.get(i + 3).and_then(|c| c.data) else {
            continue;
        };
        let vin: usize = chunk_text(&chunks, i + 4).trim().parse().unwrap_or(0);
        let Some(input) = tx.inputs.get(vin) else {
            continue;
        };
        let Some(in_hash) = sigma_input_hash(&input.prev_txid, input.prev_vout) else {
            continue;
        };
        let data_hash = sha256(&script[..chunks[i - 1].start]);
        let mut combined = [0u8; 64];
        combined[0..32].copy_from_slice(&in_hash);
        combined[32..64].copy_from_slice(&data_hash);
        let msg_hash = sha256(&combined);
        if alg.eq_ignore_ascii_case("BRC77") {
            if let Some(signer_ik) = verify_brc77_anyone(&msg_hash, sig_bytes) {
                if signer_ik.eq_ignore_ascii_case(&identity_key) {
                    has_identity_sig = true;
                }
            }
        } else if alg.eq_ignore_ascii_case("BSM")
            && !address.is_empty()
            && verify_bsm(&msg_hash, sig_bytes, address)
        {
            bap_signer_addr = Some(address.to_string());
        }
    }
    if is_link && (!has_identity_sig || bap_signer_addr.is_none()) {
        return None;
    }
    if !is_link && !has_identity_sig && bap_signer_addr.is_none() {
        return None;
    }
    Some((is_link, identity_key, bap_id, bap_signer_addr))
}

/// Verify a stored `IssuerIdentityPackage` (`{ v: 1, bapId, beefB64 }`) from `handcash.issuerIdentities.v1`.
pub fn verify_issuer_identity_package(raw: &Value) -> Option<VerifiedBapIdentity> {
    let bap_id = normalize_bap_id(raw.get("bapId")?.as_str()?)?;
    let beef_b64 = raw.get("beefB64")?.as_str()?.trim();
    let beef_bytes = base64::engine::general_purpose::STANDARD
        .decode(beef_b64)
        .ok()?;
    let beef = Beef::from_bytes(&beef_bytes).ok()?;

    let mut txs: Vec<(u64, &str, &Transaction)> = beef
        .txs
        .values()
        .filter_map(|bt| {
            let tx = bt.tx.as_ref()?;
            let height = bt
                .bump_index
                .and_then(|idx| beef.bumps.get(idx))
                .map(|b| b.block_height)
                .unwrap_or(u64::MAX);
            Some((height, bt.txid.as_str(), tx))
        })
        .collect();
    txs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));

    let mut valid_addresses: Vec<String> = Vec::new();
    let mut revoked = false;
    let mut name = String::new();
    let mut description = String::new();
    let mut image_data_url: Option<String> = None;
    let mut linked_keys: HashMap<String, bool> = HashMap::new();

    for (_height, _txid, tx) in &txs {
        for (vout, output) in tx.outputs.iter().enumerate() {
            let chunks = parse_script_chunks(&output.locking_script);
            if let Some(bap_i) = chunks.iter().position(|c| c.data == Some(BAP_PREFIX)) {
                let action = chunk_text(&chunks, bap_i + 1);
                let Some(signer_addr) = verify_aip_on_bap_chunks(&chunks, bap_i) else {
                    continue;
                };
                match action {
                    "ID" => {
                        let id_field = chunk_text(&chunks, bap_i + 2);
                        let next_addr = chunk_text(&chunks, bap_i + 3).trim();
                        if id_field != bap_id || next_addr.is_empty() {
                            continue;
                        }
                        if valid_addresses.is_empty() {
                            if bap_id_for_address(&signer_addr) != bap_id {
                                continue;
                            }
                            valid_addresses.push(signer_addr);
                            if valid_addresses.last().map(String::as_str) != Some(next_addr) {
                                valid_addresses.push(next_addr.to_string());
                            }
                        } else if valid_addresses.last().map(String::as_str)
                            == Some(signer_addr.as_str())
                            && !valid_addresses.iter().any(|a| a == next_addr)
                        {
                            valid_addresses.push(next_addr.to_string());
                        }
                    }
                    "ALIAS" => {
                        let id_field = chunk_text(&chunks, bap_i + 2);
                        let doc_str = chunk_text(&chunks, bap_i + 3);
                        if id_field != bap_id {
                            continue;
                        }
                        let authorized = valid_addresses.iter().any(|a| a == &signer_addr)
                            || (valid_addresses.is_empty()
                                && bap_id_for_address(&signer_addr) == bap_id);
                        if !authorized {
                            continue;
                        }
                        if valid_addresses.is_empty() {
                            valid_addresses.push(signer_addr);
                        }
                        if let Ok(doc) = serde_json::from_str::<Value>(doc_str) {
                            if let Some(n) = doc
                                .get("alternateName")
                                .or_else(|| doc.get("name"))
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                            {
                                name = n.to_string();
                            }
                            if let Some(d) = doc
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::trim)
                            {
                                description = d.to_string();
                            }
                            if let Some(img) = doc
                                .get("image")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| s.starts_with("data:image/"))
                            {
                                image_data_url = Some(img.to_string());
                            }
                        }
                    }
                    "REVOKE" => {
                        let id_field = chunk_text(&chunks, bap_i + 2);
                        if id_field == bap_id && valid_addresses.iter().any(|a| a == &signer_addr) {
                            revoked = true;
                        }
                    }
                    _ => {}
                }
            }

            if let Some((is_link, ik, link_bap, bap_signer)) = parse_identity_link_in_tx(tx, vout) {
                if link_bap == bap_id {
                    let signer_ok = bap_signer
                        .as_deref()
                        .map(|a| valid_addresses.iter().any(|v| v == a))
                        .unwrap_or(!is_link);
                    if signer_ok {
                        linked_keys.insert(ik, is_link);
                    }
                }
            }
        }
    }

    let active_address = valid_addresses.last()?.clone();
    if name.is_empty() {
        return None;
    }
    let linked_identity_keys: Vec<String> = linked_keys
        .into_iter()
        .filter_map(|(k, active)| active.then_some(k))
        .collect();
    Some(VerifiedBapIdentity {
        bap_id,
        name,
        description,
        image_data_url,
        active_address,
        revoked,
        linked_identity_keys,
    })
}

// ---------------------------------------------------------------------------
// HandCash Verified Issuers List (`src/wallet/verifiedIssuers.ts`)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedIssuerEntry {
    pub bap_id: String,
    pub name: String,
}

/// Verify a persisted `handcash.verifiedIssuers.v1` value against the pinned HandCash certifier.
pub fn verify_verified_issuer_list(raw: &Value) -> Option<Vec<VerifiedIssuerEntry>> {
    let list = raw.get("list").unwrap_or(raw);
    if list.get("v")?.as_u64()? != 1 {
        return None;
    }
    let updated_at = list.get("updatedAt")?.as_str()?;
    let certifier = list.get("certifier")?.as_str()?.trim().to_ascii_lowercase();
    if certifier != HANDCASH_VERIFIED_ISSUERS_CERTIFIER {
        return None;
    }
    let sig_hex = list.get("signature")?.as_str()?.trim();
    let sig_bytes = decode_hex(sig_hex).ok()?;
    let raw_entries = list.get("entries")?.as_array()?;
    let mut entries = Vec::with_capacity(raw_entries.len());
    let mut canonical_entries = Vec::with_capacity(raw_entries.len());
    for e in raw_entries {
        let bap_id = normalize_bap_id(e.get("bapId")?.as_str()?)?;
        let name = e.get("name")?.as_str()?.trim();
        if name.is_empty() {
            return None;
        }
        entries.push(VerifiedIssuerEntry {
            bap_id: bap_id.clone(),
            name: name.to_string(),
        });
        canonical_entries.push(serde_json::json!({
            "bapId": bap_id,
            "name": name,
        }));
    }
    let msg = serde_json::json!({
        "v": 1,
        "updatedAt": updated_at,
        "entries": canonical_entries,
    })
    .to_string();
    let kd = KeyDeriver::new(anyone_private_key());
    let valid = kd
        .verify_signature(
            (2, "handcash verified issuers"),
            "1",
            Counterparty::PublicKeyHex(certifier),
            false,
            Some(msg.as_bytes()),
            None,
            &sig_bytes,
        )
        .ok()?;
    valid.then_some(entries)
}

// ---------------------------------------------------------------------------
// Issuer trust state (`src/wallet/issuerTrust.ts`)
// ---------------------------------------------------------------------------

fn normalize_trust_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.to_lowercase().chars() {
        let mapped = match ch {
            '0' => 'o',
            '1' | 'l' | '|' => 'i',
            '3' => 'e',
            '5' => 's',
            '@' => 'a',
            '$' => 's',
            _ => ch,
        };
        if mapped.is_alphanumeric() {
            out.push(mapped);
        }
    }
    out
}

/// Compute TS `issuerViewState` for a verified profile: `listed` | `imitation` | `shared-name` | `verified`.
pub fn compute_issuer_trust_state(
    profile_id: &str,
    name: &str,
    bap_id: Option<&str>,
    verified_list: &[VerifiedIssuerEntry],
    known_identities: &[(String, String)],
) -> &'static str {
    let norm_name = normalize_trust_name(name);
    if let Some(bid) = bap_id {
        if let Some(listed) = verified_list.iter().find(|e| e.bap_id == bid) {
            if normalize_trust_name(&listed.name) == norm_name {
                return "listed";
            }
        }
    }
    if !norm_name.is_empty() {
        for listed in verified_list {
            if Some(listed.bap_id.as_str()) != bap_id
                && normalize_trust_name(&listed.name) == norm_name
            {
                return "imitation";
            }
        }
        let mut others = HashSet::new();
        for (other_id, other_name) in known_identities {
            if !other_id.eq_ignore_ascii_case(profile_id)
                && Some(other_id.as_str()) != bap_id
                && normalize_trust_name(other_name) == norm_name
            {
                others.insert(other_id.to_ascii_lowercase());
            }
        }
        if !others.is_empty() {
            return "shared-name";
        }
    }
    "verified"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tx::{TxInput, TxOutput};
    use handcash_primitives::keys::{sign_brc77_anyone, sign_bsm, SecretKeyBytes};

    fn push_bytes(out: &mut Vec<u8>, data: &[u8]) {
        if data.len() <= 75 {
            out.push(data.len() as u8);
        } else if data.len() <= 255 {
            out.push(0x4c);
            out.push(data.len() as u8);
        } else {
            out.push(0x4d);
            out.extend_from_slice(&(data.len() as u16).to_le_bytes());
        }
        out.extend_from_slice(data);
    }

    #[test]
    fn extracts_map_issuer_and_verifies_sigma_brc77_and_bsm() {
        let sk = SecretKeyBytes::from_hex(&"11".repeat(32)).unwrap();
        let pk_hex = sk.public_key_hex().unwrap();
        let addr = sk.p2pkh_address(false).unwrap();
        let bap_id = bap_id_for_address(&addr);
        let prev_txid = "aa".repeat(32);

        let mut script = vec![OP_RETURN];
        push_bytes(&mut script, MAP_PREFIX);
        push_bytes(&mut script, b"SET");
        push_bytes(&mut script, b"issuer");
        push_bytes(&mut script, pk_hex.as_bytes());
        push_bytes(&mut script, b"bapId");
        push_bytes(&mut script, bap_id.as_bytes());

        let data_hash = sha256(&script);
        let in_hash = sigma_input_hash(&prev_txid, 0).unwrap();
        let mut combined = [0u8; 64];
        combined[0..32].copy_from_slice(&in_hash);
        combined[32..64].copy_from_slice(&data_hash);
        let msg_hash = sha256(&combined);
        let sig = sign_brc77_anyone(&sk, &msg_hash).unwrap();

        push_bytes(&mut script, b"|");
        push_bytes(&mut script, SIGMA_PREFIX);
        push_bytes(&mut script, b"BRC77");
        push_bytes(&mut script, addr.as_bytes());
        push_bytes(&mut script, &sig);
        push_bytes(&mut script, b"0");

        let tx = Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev_txid: prev_txid.clone(),
                prev_vout: 0,
                unlocking_script: vec![],
                sequence: u32::MAX,
            }],
            outputs: vec![TxOutput {
                satoshis: 1,
                locking_script: script,
            }],
            lock_time: 0,
        };

        let extracted = extract_issuer_from_tx(&tx, 0);
        assert_eq!(extracted.issuer_key.as_deref(), Some(pk_hex.as_str()));
        assert_eq!(extracted.bap_id.as_deref(), Some(bap_id.as_str()));
        assert!(extracted.issuer_attested);

        let mut bsm_script = vec![OP_RETURN];
        push_bytes(&mut bsm_script, MAP_PREFIX);
        push_bytes(&mut bsm_script, b"SET");
        push_bytes(&mut bsm_script, b"issuer");
        push_bytes(&mut bsm_script, pk_hex.as_bytes());
        let dh2 = sha256(&bsm_script);
        let mut comb2 = [0u8; 64];
        comb2[0..32].copy_from_slice(&in_hash);
        comb2[32..64].copy_from_slice(&dh2);
        let mh2 = sha256(&comb2);
        let bsm_sig = sign_bsm(&sk, &mh2).unwrap();
        push_bytes(&mut bsm_script, b"|");
        push_bytes(&mut bsm_script, SIGMA_PREFIX);
        push_bytes(&mut bsm_script, b"BSM");
        push_bytes(&mut bsm_script, addr.as_bytes());
        push_bytes(&mut bsm_script, &bsm_sig);
        push_bytes(&mut bsm_script, b"0");
        let tx2 = Transaction {
            version: 1,
            inputs: tx.inputs.clone(),
            outputs: vec![TxOutput {
                satoshis: 1,
                locking_script: bsm_script,
            }],
            lock_time: 0,
        };
        let ex2 = extract_issuer_from_tx(&tx2, 0);
        assert_eq!(ex2.issuer_key.as_deref(), Some(pk_hex.as_str()));
        assert!(ex2.issuer_attested);
    }

    #[test]
    fn trust_state_distinguishes_listed_imitation_shared_and_verified() {
        let list = vec![VerifiedIssuerEntry {
            bap_id: "BapVerified111111111111111111".into(),
            name: "HandCash".into(),
        }];
        assert_eq!(
            compute_issuer_trust_state(
                "02aa",
                "HandCash",
                Some("BapVerified111111111111111111"),
                &list,
                &[]
            ),
            "listed"
        );
        assert_eq!(
            compute_issuer_trust_state("02bb", "HandCa$h", None, &list, &[]),
            "imitation"
        );
        assert_eq!(
            compute_issuer_trust_state(
                "02cc",
                "Studio",
                None,
                &list,
                &[("02dd".into(), "Studio".into())]
            ),
            "shared-name"
        );
        assert_eq!(
            compute_issuer_trust_state("02ee", "UniqueStudio", None, &list, &[]),
            "verified"
        );
    }
}
