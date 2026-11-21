// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Host-side log privacy scrubber — parity with `src/wallet/logPrivacy.ts`.
//!
//! Logs never say who the user deals with or what their transactions are:
//! - hex identifiers (txids, outpoints, identity and device keys) become
//!   same-length pseudonyms under a per-run in-memory key (prefix-preserving);
//! - handles, paymails and labelled peers become opaque per-run tags;
//! - addresses, raw transactions, BEEF, scripts and other blobs are removed;
//! - amounts (sats, BSV, fiat, labelled balances and fees) are removed, while
//!   zero and one-sat placeholders stay for triage.

use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

const CACHE_MAX: usize = 4096;
const RAW_HEX_MIN: usize = 129;
const PER_DIGIT: usize = 8;
const BLOCK: usize = 4;

pub struct LogScrubber {
    key: [u8; 32],
    hex_cache: Mutex<HashMap<String, String>>,
}

impl LogScrubber {
    pub fn new_random() -> Self {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        Self::with_key(key)
    }

    pub fn with_key(key: [u8; 32]) -> Self {
        Self {
            key,
            hex_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn scrub(&self, line: &str) -> String {
        let s = scrub_blobs(line);
        let s = scrub_addresses(&s);
        let s = scrub_paymails(&s, &self.key);
        let s = scrub_handles(&s, &self.key);
        let s = self.scrub_hex(&s);
        let s = scrub_labelled_amounts(&s);
        let s = scrub_unit_amounts(&s);
        let s = scrub_fiat(&s);
        let s = scrub_labelled_peers(&s, &self.key);
        scrub_labelled_tx(&s)
    }

    fn hex_pseudonym(&self, value: &str) -> String {
        let lower = value.to_ascii_lowercase();
        if let Ok(cache) = self.hex_cache.lock() {
            if let Some(hit) = cache.get(&lower) {
                return hit.clone();
            }
        }
        let mut out = String::with_capacity(lower.len());
        let mut masks_from: Option<usize> = None;
        let mut masks = [0u8; 32];
        let bytes = lower.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            let from = mask_start(i);
            if masks_from != Some(from) {
                masks = prf(&self.key, &format!("x:{}", &lower[..from]));
                masks_from = Some(from);
            }
            let nibble = hex_val(b);
            let masked = (nibble.wrapping_add(masks[i - from])) & 15;
            out.push(hex_char(masked));
        }
        if let Ok(mut cache) = self.hex_cache.lock() {
            if cache.len() >= CACHE_MAX {
                cache.clear();
            }
            cache.insert(lower, out.clone());
        }
        out
    }

    fn scrub_hex(&self, input: &str) -> String {
        let b = input.as_bytes();
        let mut out = String::with_capacity(input.len());
        let mut i = 0;
        while i < b.len() {
            if is_hex(b[i]) && (i == 0 || !b[i - 1].is_ascii_alphanumeric()) {
                let start = i;
                while i < b.len() && is_hex(b[i]) {
                    i += 1;
                }
                let end = i;
                let bounded_right = end == b.len() || !b[end].is_ascii_alphanumeric();
                if bounded_right && end - start >= 8 {
                    let m = &input[start..end];
                    if m.len() >= RAW_HEX_MIN {
                        out.push_str("[hex]");
                    } else if !m.bytes().any(|c| c.is_ascii_digit())
                        || !m.bytes().any(|c| matches!(c, b'a'..=b'f' | b'A'..=b'F'))
                    {
                        out.push_str(m);
                    } else {
                        out.push_str(&self.hex_pseudonym(m));
                    }
                } else {
                    out.push_str(&input[start..end]);
                }
            } else {
                let ch = input[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
        out
    }
}

fn mask_start(i: usize) -> usize {
    if i < PER_DIGIT {
        i
    } else {
        i - ((i - PER_DIGIT) % BLOCK)
    }
}

fn prf(key: &[u8; 32], input: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    for ch in input.chars() {
        hasher.update([(ch as u32 & 0xff) as u8]);
    }
    hasher.finalize().into()
}

fn tag(key: &[u8; 32], domain: &str, value: &str) -> String {
    let digest = prf(key, &format!("{domain}:{}", value.to_lowercase()));
    hex::encode(&digest[..3])
}

fn hex_val(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        b'A'..=b'F' => b - b'A' + 10,
        _ => 0,
    }
}

fn hex_char(n: u8) -> char {
    match n & 15 {
        0..=9 => (b'0' + (n & 15)) as char,
        v => (b'a' + (v - 10)) as char,
    }
}

fn is_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_blob_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'_' | b'-')
}

fn is_base58(b: u8) -> bool {
    matches!(
        b,
        b'1'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'a'..=b'k' | b'm'..=b'z'
    )
}

fn mixed(s: &str) -> bool {
    let mut has_upper = false;
    let mut has_lower = false;
    let mut has_digit = false;
    for b in s.bytes() {
        if b.is_ascii_uppercase() {
            has_upper = true;
        } else if b.is_ascii_lowercase() {
            has_lower = true;
        } else if b.is_ascii_digit() {
            has_digit = true;
        }
        if has_upper && has_lower && has_digit {
            return true;
        }
    }
    false
}

fn carries_no_amount(n: &str, unit: &str) -> bool {
    let mut seen_dot = false;
    let mut all_zero = true;
    for b in n.bytes() {
        if b == b'.' && !seen_dot {
            seen_dot = true;
        } else if seen_dot {
            if b != b'0' {
                all_zero = false;
                break;
            }
        } else if !matches!(b, b'0' | b',' | b'_') {
            all_zero = false;
            break;
        }
    }
    if all_zero && !n.is_empty() {
        return true;
    }
    if unit.eq_ignore_ascii_case("sat") || unit.eq_ignore_ascii_case("sats") {
        let nb = n.as_bytes();
        if let Some(&last) = nb.last() {
            if last == b'1' && nb[..nb.len() - 1].iter().all(|&c| matches!(c, b'0' | b',' | b'_')) {
                return true;
            }
        }
    }
    false
}

fn is_scrubbed_id(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() >= 8 {
        let mut i = 0;
        while i < b.len() && matches!(b[i], b'0'..=b'9' | b'a'..=b'f') {
            i += 1;
        }
        if i >= 8 {
            if i == b.len() {
                return true;
            }
            if matches!(b[i], b'.' | b'_')
                && i + 1 < b.len()
                && b[i + 1..].iter().all(|c| c.is_ascii_digit())
            {
                return true;
            }
        }
    }
    if is_tag_with_prefix(value, "$h-", "") {
        return true;
    }
    if is_tag_with_prefix(value, "p-", "@paymail") {
        return true;
    }
    if is_tag_with_prefix(value, "id-", "") {
        return true;
    }
    if b.len() >= 3
        && b[0] == b'['
        && b[b.len() - 1] == b']'
        && b[1..b.len() - 1].iter().all(|c| c.is_ascii_lowercase())
    {
        return true;
    }
    false
}

fn is_tag_with_prefix(s: &str, prefix: &str, suffix: &str) -> bool {
    if let Some(rest) = s.strip_prefix(prefix).and_then(|r| r.strip_suffix(suffix)) {
        rest.len() == 6 && rest.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
    } else {
        false
    }
}

fn scrub_blobs(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if is_blob_char(b[i]) && (i == 0 || !is_blob_char(b[i - 1])) {
            let start = i;
            while i < b.len() && is_blob_char(b[i]) {
                i += 1;
            }
            let body_len = i - start;
            if body_len >= 40 {
                let mut eq = 0;
                while eq < 2 && i < b.len() && b[i] == b'=' {
                    i += 1;
                    eq += 1;
                }
                let m = &input[start..i];
                if m.bytes().all(is_hex) || !mixed(m) {
                    out.push_str(m);
                } else {
                    out.push_str("[blob]");
                }
            } else {
                out.push_str(&input[start..i]);
            }
        } else {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn scrub_addresses(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if matches!(b[i], b'1' | b'3' | b'm' | b'n')
            && (i == 0 || !b[i - 1].is_ascii_alphanumeric())
        {
            let start = i;
            let mut j = i + 1;
            while j < b.len() && is_base58(b[j]) && (j - start - 1) < 33 {
                j += 1;
            }
            let tail_len = j - start - 1;
            let bounded_right = j == b.len() || !b[j].is_ascii_alphanumeric();
            if (24..=33).contains(&tail_len) && bounded_right {
                let m = &input[start..j];
                if mixed(m) {
                    out.push_str("[address]");
                } else {
                    out.push_str(m);
                }
                i = j;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_paymail_local(b: u8) -> bool {
    is_word(b) || matches!(b, b'.' | b'+' | b'-')
}

fn is_domain_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-'
}

fn match_paymail_at(b: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    while i < b.len() && is_paymail_local(b[i]) {
        i += 1;
    }
    if i == start || i >= b.len() || b[i] != b'@' {
        return None;
    }
    i += 1; // skip '@'
    let domain_start = i;
    let mut label_start = i;
    let mut last_dot: Option<usize> = None;
    while i < b.len() {
        if is_domain_char(b[i]) {
            i += 1;
        } else if b[i] == b'.' && i > label_start {
            last_dot = Some(i);
            i += 1;
            label_start = i;
        } else {
            break;
        }
    }
    // Trim trailing dot if domain ended on '.'
    let mut end = i;
    if end > domain_start && b[end - 1] == b'.' {
        end -= 1;
        last_dot = b[domain_start..end]
            .iter()
            .rposition(|&c| c == b'.')
            .map(|p| domain_start + p);
    }
    // Find the longest valid prefix ending in `.<alpha{2,}>`
    let dot = last_dot?;
    let tld = &b[dot + 1..end];
    if tld.len() >= 2 && tld.iter().all(|c| c.is_ascii_alphabetic()) && dot > domain_start {
        Some(end)
    } else {
        None
    }
}

fn scrub_paymails(input: &str, key: &[u8; 32]) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if is_paymail_local(b[i]) {
            if let Some(end) = match_paymail_at(b, i) {
                let m = &input[i..end];
                if is_tag_with_prefix(m, "p-", "@paymail") {
                    out.push_str(m);
                } else {
                    out.push_str(&format!("p-{}@paymail", tag(key, "p", m)));
                }
                i = end;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn scrub_handles(input: &str, key: &[u8; 32]) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'$'
            && (i == 0 || (!is_word(b[i - 1]) && b[i - 1] != b'$'))
            && i + 1 < b.len()
            && b[i + 1].is_ascii_alphabetic()
        {
            let start = i;
            let mut j = i + 2;
            let mut last_word = i + 2;
            while j < b.len() && (is_word(b[j]) || matches!(b[j], b'.' | b'-')) {
                if is_word(b[j]) {
                    last_word = j + 1;
                }
                j += 1;
            }
            let end = last_word;
            let m = &input[start..end];
            if is_tag_with_prefix(m, "$h-", "") {
                out.push_str(m);
            } else {
                out.push_str(&format!("$h-{}", tag(key, "h", &m[1..])));
            }
            i = end;
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn match_label_sep(b: &[u8], after_label: usize) -> Option<usize> {
    let mut j = after_label;
    if j < b.len() && matches!(b[j], b'"' | b'\'') {
        j += 1;
    }
    while j < b.len() && b[j].is_ascii_whitespace() {
        j += 1;
    }
    if j >= b.len() || !matches!(b[j], b':' | b'=') {
        return None;
    }
    j += 1;
    while j < b.len() && b[j].is_ascii_whitespace() {
        j += 1;
    }
    if j < b.len() && matches!(b[j], b'"' | b'\'') {
        j += 1;
    }
    Some(j)
}

fn is_amount_label(word: &str) -> bool {
    let low = word.to_ascii_lowercase();
    if matches!(
        low.as_str(),
        "amt" | "price" | "fee" | "fees" | "paid" | "pendingchange"
    ) {
        return true;
    }
    for suffix in ["sats", "satoshis", "balance", "amount", "spendable"] {
        if let Some(prefix) = low.strip_suffix(suffix) {
            if prefix.bytes().all(|c| c.is_ascii_lowercase()) {
                return true;
            }
        }
    }
    false
}

fn is_peer_label(word: &str) -> bool {
    matches!(
        word.to_ascii_lowercase().as_str(),
        "peer"
            | "sender"
            | "recipient"
            | "counterparty"
            | "counterpartykey"
            | "friend"
            | "handle"
            | "paymail"
            | "identitykey"
            | "publickey"
            | "pubkey"
            | "displayname"
    )
}

fn is_tx_label(word: &str) -> bool {
    matches!(
        word.to_ascii_lowercase().as_str(),
        "txid" | "txhash" | "txnhash" | "outpoint"
    )
}

fn scrub_labelled_amounts(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphabetic() && (i == 0 || !is_word(b[i - 1])) {
            let start = i;
            let mut j = i;
            while j < b.len() && is_word(b[j]) {
                j += 1;
            }
            let word = &input[start..j];
            if is_amount_label(word) {
                if let Some(val_start) = match_label_sep(b, j) {
                    let mut val_end = val_start;
                    while val_end < b.len()
                        && !b[val_end].is_ascii_whitespace()
                        && !matches!(b[val_end], b'"' | b'\'' | b',' | b'}' | b']')
                    {
                        val_end += 1;
                    }
                    if val_end > val_start {
                        out.push_str(&input[start..val_start]);
                        out.push_str("[amt]");
                        i = val_end;
                        continue;
                    }
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn match_unit_at(b: &[u8], pos: usize) -> Option<usize> {
    for unit in ["satoshis", "sats", "sat", "bsv"] {
        let len = unit.len();
        if pos + len <= b.len()
            && b[pos..pos + len].eq_ignore_ascii_case(unit.as_bytes())
            && (pos + len == b.len() || !is_word(b[pos + len]))
        {
            return Some(pos + len);
        }
    }
    None
}

fn scrub_unit_amounts(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        let can_start = i == 0 || (!is_word(b[i - 1]) && !matches!(b[i - 1], b'.' | b'-'));
        if can_start && (b[i] == b'-' || b[i].is_ascii_digit()) {
            let start = i;
            let mut j = i;
            let sign_end = if b[j] == b'-' {
                j += 1;
                j
            } else {
                j
            };
            if j < b.len() && b[j].is_ascii_digit() {
                let num_start = j;
                j += 1;
                while j < b.len() && (b[j].is_ascii_digit() || matches!(b[j], b',' | b'_')) {
                    j += 1;
                }
                if j + 1 < b.len() && b[j] == b'.' && b[j + 1].is_ascii_digit() {
                    j += 2;
                    while j < b.len() && b[j].is_ascii_digit() {
                        j += 1;
                    }
                }
                let num_end = j;
                let space_start = j;
                if j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                let unit_start = j;
                if let Some(unit_end) = match_unit_at(b, unit_start) {
                    let sign = &input[start..sign_end];
                    let num = &input[num_start..num_end];
                    let space = &input[space_start..unit_start];
                    let unit = &input[unit_start..unit_end];
                    if carries_no_amount(num, unit) {
                        out.push_str(&input[start..unit_end]);
                    } else {
                        out.push_str(sign);
                        out.push_str("[amt]");
                        out.push_str(space);
                        out.push_str(unit);
                    }
                    i = unit_end;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn scrub_fiat(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        let can_start = i == 0 || (!is_word(b[i - 1]) && b[i - 1] != b'$');
        if can_start {
            let start = i;
            let mut j = i;
            let sign = if b[j] == b'-' {
                j += 1;
                "-"
            } else {
                ""
            };
            if j + 1 < b.len() && b[j] == b'$' && b[j + 1].is_ascii_digit() {
                j += 2;
                while j < b.len() && (b[j].is_ascii_digit() || b[j] == b',') {
                    j += 1;
                }
                if j + 1 < b.len() && b[j] == b'.' && b[j + 1].is_ascii_digit() {
                    j += 2;
                    while j < b.len() && b[j].is_ascii_digit() {
                        j += 1;
                    }
                }
                out.push_str(sign);
                out.push_str("$[amt]");
                i = j;
                let _ = start;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn scrub_labelled_peers(input: &str, key: &[u8; 32]) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphabetic() && (i == 0 || !is_word(b[i - 1])) {
            let start = i;
            let mut j = i;
            while j < b.len() && is_word(b[j]) {
                j += 1;
            }
            let word = &input[start..j];
            if is_peer_label(word) {
                if let Some(val_start) = match_label_sep(b, j) {
                    let mut val_end = val_start;
                    while val_end < b.len()
                        && !b[val_end].is_ascii_whitespace()
                        && !matches!(b[val_end], b'"' | b'\'' | b',' | b'}' | b']' | b')')
                    {
                        val_end += 1;
                    }
                    if val_end > val_start {
                        let val = &input[val_start..val_end];
                        out.push_str(&input[start..val_start]);
                        if is_scrubbed_id(val) {
                            out.push_str(val);
                        } else {
                            out.push_str(&format!("id-{}", tag(key, "i", val)));
                        }
                        i = val_end;
                        continue;
                    }
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn scrub_labelled_tx(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphabetic() && (i == 0 || !is_word(b[i - 1])) {
            let start = i;
            let mut j = i;
            while j < b.len() && is_word(b[j]) {
                j += 1;
            }
            let word = &input[start..j];
            if is_tx_label(word) {
                if let Some(val_start) = match_label_sep(b, j) {
                    let mut val_end = val_start;
                    while val_end < b.len()
                        && !b[val_end].is_ascii_whitespace()
                        && !matches!(b[val_end], b'"' | b'\'' | b',' | b'}' | b']' | b')')
                    {
                        val_end += 1;
                    }
                    if val_end > val_start {
                        let val = &input[val_start..val_end];
                        out.push_str(&input[start..val_start]);
                        if is_scrubbed_id(val) {
                            out.push_str(val);
                        } else {
                            out.push_str("[REDACTED]");
                        }
                        i = val_end;
                        continue;
                    }
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TXID: &str = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
    const IDENTITY: &str = "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc";
    const ADDRESS: &str = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const BEEF_B64: &str =
        "AQC+7wH+AAAAAAABAQAAAAAAAAAA/////01UaGUgVGltZXMgMDMvSmFuLzIwMDkgQ2hhbmNlbGxvcg==";

    fn test_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, slot) in k.iter_mut().enumerate() {
            *slot = (i * 7 + 3) as u8;
        }
        k
    }

    fn other_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, slot) in k.iter_mut().enumerate() {
            *slot = (255 - i) as u8;
        }
        k
    }

    fn corpus() -> Vec<String> {
        vec![
            format!("[activity] new spent/brc29 -12500 sat {}… — settled", &TXID[..12]),
            format!("[beef] local-lookup done 12ms — cache {}", &TXID[..8]),
            format!("[chat] delivered to {IDENTITY} via box"),
            format!("[send] paying $alice.smith 0.25 BSV ($12.34) txid={TXID}"),
            format!(r#"[peer] {{"sender":"bob","counterparty":"carol"}} outpoint={TXID}.0"#),
            format!("[legacy] scan {ADDRESS} beef={BEEF_B64}"),
            "[written-off] reconcile done 40ms — restored=2 sats=9100 hidden=1 hiddenSats=546"
                .to_string(),
            "[collectables] page returned=10 load=29ms hydrate=7163ms done 7192ms".to_string(),
            "[1sat] identify pass: probed 4, 1 sat each, 0 sat placeholder, paymail alice@handcash.io"
                .to_string(),
            format!("raw {}", "ab01".repeat(60)),
        ]
    }

    #[test]
    fn turns_txids_and_keys_into_prefix_preserving_pseudonyms() {
        let scrubber = LogScrubber::with_key(test_key());
        let other = LogScrubber::with_key(other_key());
        let full = scrubber.scrub(&format!("txid={TXID}"))["txid=".len()..].to_string();
        let seen = scrubber.scrub(&format!("seen {}…", &TXID[..12]));
        let prefix = &seen["seen ".len().."seen ".len() + 12];
        assert_eq!(full.len(), 64);
        assert!(full.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));
        assert_ne!(full, TXID);
        assert!(full.starts_with(prefix));
        assert_eq!(scrubber.scrub(TXID), full);
        assert_ne!(other.scrub(TXID), full);

        let key = scrubber.scrub(IDENTITY);
        assert_eq!(key.len(), 66);
        assert!(!key.contains(&IDENTITY[2..14]));
    }

    #[test]
    fn never_lets_identities_addresses_blobs_or_amounts_through() {
        let scrubber = LogScrubber::with_key(test_key());
        let out = corpus()
            .iter()
            .map(|l| scrubber.scrub(l))
            .collect::<Vec<_>>()
            .join("\n");
        for leak in [
            &TXID[..8],
            &IDENTITY[..10],
            ADDRESS,
            &BEEF_B64[..20],
            "ab01ab01ab01",
            "alice",
            "bob",
            "carol",
            "handcash.io",
            "12500",
            "0.25",
            "12.34",
            "9100",
            "546",
        ] {
            assert!(!out.contains(leak), "leaked {leak} in:\n{out}");
        }
        assert!(out.contains("-[amt] sat"));
        assert!(out.contains("[amt] BSV ($[amt])"));
        assert!(out.contains("sats=[amt] hidden=1 hiddenSats=[amt]"));
        assert!(out.contains("[address]"));
        assert!(out.contains("[blob]"));
        assert!(out.contains("[hex]"));
        assert!(out.contains("$h-"));
        assert!(out.contains(r#""sender":"id-"#));
        assert!(out.contains("@paymail"));
    }

    #[test]
    fn keeps_timings_counts_zero_and_one_sat_wording_for_triage() {
        let scrubber = LogScrubber::with_key(test_key());
        let c = corpus();
        assert_eq!(scrubber.scrub(&c[7]), c[7]);
        assert_eq!(
            scrubber.scrub("[1sat] identify pass: probed 4, 1 sat each, 0 sat placeholder"),
            "[1sat] identify pass: probed 4, 1 sat each, 0 sat placeholder"
        );
        assert_eq!(
            scrubber.scrub("[activity] new spent/approve 0 sat no-txid — x"),
            "[activity] new spent/approve 0 sat no-txid — x"
        );
        assert_eq!(scrubber.scrub("1 BSV"), "[amt] BSV");
    }

    #[test]
    fn second_pass_leaks_nothing_and_stays_consistent() {
        let scrubber = LogScrubber::with_key(test_key());
        let once: Vec<String> = corpus().iter().map(|l| scrubber.scrub(l)).collect();
        let twice: Vec<String> = once.iter().map(|l| scrubber.scrub(l)).collect();
        let again: Vec<String> = corpus()
            .iter()
            .map(|l| scrubber.scrub(&scrubber.scrub(l)))
            .collect();
        assert_eq!(twice, again);
        let joined = twice.join("\n");
        assert!(!joined.contains("alice"));
        assert!(joined.contains("[amt]"));
    }
}
