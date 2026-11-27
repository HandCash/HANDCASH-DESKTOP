// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! BRC-29 settlement receipt URI — offline remittance beside the messagebox card.
//! 1:1 port of `src/wallet/brc29Uri.ts`.
//!
//! Format:
//! `brc29:<payeeIdentityKey>?txid=<64hex>&dp=<prefix>&ds=<suffix>&sender=<66hex>[&vout=0][&sats=n]`

use k256::PublicKey;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brc29UriRemittance {
    pub derivation_prefix: String,
    pub derivation_suffix: String,
    pub output_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brc29SettlementUri {
    pub payee_identity_key: String,
    pub sender_identity_key: String,
    pub txid: String,
    pub remittance: Brc29UriRemittance,
    pub sats: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brc29UriError(pub String);

impl fmt::Display for Brc29UriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Brc29UriError {}

fn is_hex_of_len(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_compressed_identity_key_hex(s: &str) -> bool {
    is_hex_of_len(s, 66) && (s.starts_with("02") || s.starts_with("03"))
}

fn validate_sec1_pubkey(hex_key: &str, err_msg: &str) -> Result<(), Brc29UriError> {
    if !is_compressed_identity_key_hex(hex_key) {
        return Err(Brc29UriError(err_msg.to_string()));
    }
    let bytes = hex::decode(hex_key).map_err(|_| Brc29UriError(err_msg.to_string()))?;
    PublicKey::from_sec1_bytes(&bytes).map_err(|_| Brc29UriError(err_msg.to_string()))?;
    Ok(())
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

fn percent_decode(input: &str) -> Result<String, Brc29UriError> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex_str = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .map_err(|_| Brc29UriError("Invalid percent encoding".into()))?;
                let val = u8::from_str_radix(hex_str, 16)
                    .map_err(|_| Brc29UriError("Invalid percent encoding".into()))?;
                out.push(val);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| Brc29UriError("Invalid UTF-8 in query".into()))
}

pub fn looks_like_brc29_settlement_uri(raw: &str) -> bool {
    let t = raw.trim();
    t.len() >= 6 && t[..6].eq_ignore_ascii_case("brc29:")
}

pub fn build_brc29_settlement_uri(
    payee_identity_key: &str,
    sender_identity_key: &str,
    txid: &str,
    remittance: &Brc29UriRemittance,
    sats: Option<u64>,
) -> Result<String, Brc29UriError> {
    let payee = payee_identity_key.trim().to_ascii_lowercase();
    let sender = sender_identity_key.trim().to_ascii_lowercase();
    let txid = txid.trim().to_ascii_lowercase();
    validate_sec1_pubkey(&payee, "Invalid payee identity key")?;
    validate_sec1_pubkey(&sender, "Invalid sender identity key")?;
    if !is_hex_of_len(&txid, 64) {
        return Err(Brc29UriError("Invalid payment txid".into()));
    }
    let dp = remittance.derivation_prefix.trim();
    let ds = remittance.derivation_suffix.trim();
    if dp.is_empty() || ds.is_empty() {
        return Err(Brc29UriError("Missing BRC-29 remittance".into()));
    }
    let mut uri = format!(
        "brc29:{payee}?txid={txid}&dp={}&ds={}&sender={sender}&vout={}",
        percent_encode(dp),
        percent_encode(ds),
        remittance.output_index,
    );
    if let Some(s) = sats.filter(|&v| v > 0) {
        uri.push_str(&format!("&sats={s}"));
    }
    Ok(uri)
}

pub fn parse_brc29_settlement_uri(raw: &str) -> Result<Brc29SettlementUri, Brc29UriError> {
    let trimmed = raw.trim();
    if !looks_like_brc29_settlement_uri(trimmed) {
        return Err(Brc29UriError("Not a BRC-29 settlement URI".into()));
    }
    let without_scheme = &trimmed[6..];
    let (key_part, query) = match without_scheme.find('?') {
        Some(q) => (
            without_scheme[..q].trim().to_ascii_lowercase(),
            &without_scheme[q + 1..],
        ),
        None => (without_scheme.trim().to_ascii_lowercase(), ""),
    };
    validate_sec1_pubkey(&key_part, "Payee identity key is invalid")?;

    let mut txid = String::new();
    let mut dp = String::new();
    let mut ds = String::new();
    let mut sender = String::new();
    let mut vout: u32 = 0;
    let mut sats: Option<u64> = None;

    if !query.is_empty() {
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k_raw, v_raw) = pair.split_once('=').unwrap_or((pair, ""));
            let k = percent_decode(k_raw)?;
            let v = percent_decode(v_raw)?;
            match k.as_str() {
                "txid" => txid = v.trim().to_ascii_lowercase(),
                "dp" => dp = v.trim().to_string(),
                "ds" => ds = v.trim().to_string(),
                "sender" => sender = v.trim().to_ascii_lowercase(),
                "vout" if !v.is_empty() => {
                    if !v.bytes().all(|b| b.is_ascii_digit()) {
                        return Err(Brc29UriError("vout must be a non-negative integer".into()));
                    }
                    vout = v
                        .parse::<u32>()
                        .map_err(|_| Brc29UriError("vout must be a non-negative integer".into()))?;
                }
                "sats" if !v.is_empty() => {
                    if !v.bytes().all(|b| b.is_ascii_digit()) {
                        return Err(Brc29UriError("sats must be a non-negative integer".into()));
                    }
                    let n = v
                        .parse::<u64>()
                        .map_err(|_| Brc29UriError("sats must be a non-negative integer".into()))?;
                    sats = if n > 0 { Some(n) } else { None };
                }
                _ => {}
            }
        }
    }

    if !is_hex_of_len(&txid, 64) {
        return Err(Brc29UriError("Settlement URI missing txid".into()));
    }
    if dp.is_empty() || ds.is_empty() {
        return Err(Brc29UriError("Settlement URI missing remittance".into()));
    }
    validate_sec1_pubkey(&sender, "Settlement URI missing sender")?;

    Ok(Brc29SettlementUri {
        payee_identity_key: key_part,
        sender_identity_key: sender,
        txid,
        remittance: Brc29UriRemittance {
            derivation_prefix: dp,
            derivation_suffix: ds,
            output_index: vout,
        },
        sats,
    })
}

pub fn try_parse_brc29_settlement_uri(raw: &str) -> Option<Brc29SettlementUri> {
    if !looks_like_brc29_settlement_uri(raw) {
        return None;
    }
    parse_brc29_settlement_uri(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::SecretKey;

    fn pubkey_hex(seed: u8) -> String {
        let mut bytes = [0u8; 32];
        bytes[31] = seed;
        let sk = SecretKey::from_slice(&bytes).unwrap();
        hex::encode(sk.public_key().to_sec1_bytes())
    }

    #[test]
    fn roundtrips_valid_settlement_uri() {
        let payee = pubkey_hex(1);
        let sender = pubkey_hex(2);
        let txid = "a".repeat(64);
        let rem = Brc29UriRemittance {
            derivation_prefix: "pref+/=1".into(),
            derivation_suffix: "suff+/=2".into(),
            output_index: 3,
        };
        let uri = build_brc29_settlement_uri(&payee, &sender, &txid, &rem, Some(12_345)).unwrap();
        assert!(looks_like_brc29_settlement_uri(&uri));
        let parsed = parse_brc29_settlement_uri(&uri).unwrap();
        assert_eq!(parsed.payee_identity_key, payee);
        assert_eq!(parsed.sender_identity_key, sender);
        assert_eq!(parsed.txid, txid);
        assert_eq!(parsed.remittance, rem);
        assert_eq!(parsed.sats, Some(12_345));
    }

    #[test]
    fn rejects_invalid_scheme_keys_or_numbers() {
        let payee = pubkey_hex(1);
        let sender = pubkey_hex(2);
        let txid = "b".repeat(64);
        assert!(!looks_like_brc29_settlement_uri("peerpay:123"));
        assert!(try_parse_brc29_settlement_uri("peerpay:123").is_none());
        assert!(parse_brc29_settlement_uri(&format!("brc29:02{}", "0".repeat(64))).is_err());
        assert!(parse_brc29_settlement_uri(&format!(
            "brc29:{payee}?txid={txid}&dp=a&ds=b&sender={sender}&vout=-1"
        ))
        .is_err());
        assert!(parse_brc29_settlement_uri(&format!(
            "brc29:{payee}?txid={txid}&dp=a&ds=b&sender={sender}&sats=12abc"
        ))
        .is_err());
    }
}
