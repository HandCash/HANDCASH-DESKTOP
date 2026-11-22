// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1Sat Ordinals `OP_FALSE OP_IF "ord" ... OP_ENDIF` envelope & MAP metadata parser.

use handcash_primitives::encoding::encode_hex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const OP_FALSE: u8 = 0x00;
const OP_1: u8 = 0x51;
const OP_3: u8 = 0x53;
const OP_16: u8 = 0x60;
const OP_IF: u8 = 0x63;
const OP_ENDIF: u8 = 0x68;
const OP_RETURN: u8 = 0x6a;

/// MAP protocol prefix (`1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5`).
const MAP_PREFIX: &[u8] = b"1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdEnvelope {
    pub content_type: String,
    pub body: Vec<u8>,
    pub parent_outpoint: Option<String>,
    pub map_fields: HashMap<String, String>,
}

fn read_push(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let op = *bytes.get(at)?;
    match op {
        1..=75 => {
            let len = op as usize;
            let end = at.checked_add(1)?.checked_add(len)?;
            Some((bytes.get(at + 1..end)?, end))
        }
        0x4c => {
            let len = *bytes.get(at + 1)? as usize;
            let end = at.checked_add(2)?.checked_add(len)?;
            Some((bytes.get(at + 2..end)?, end))
        }
        0x4d => {
            let lo = *bytes.get(at + 1)? as usize;
            let hi = *bytes.get(at + 2)? as usize;
            let len = lo | (hi << 8);
            let end = at.checked_add(3)?.checked_add(len)?;
            Some((bytes.get(at + 3..end)?, end))
        }
        0x4e => {
            let b0 = *bytes.get(at + 1)? as usize;
            let b1 = *bytes.get(at + 2)? as usize;
            let b2 = *bytes.get(at + 3)? as usize;
            let b3 = *bytes.get(at + 4)? as usize;
            let len = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
            let end = at.checked_add(5)?.checked_add(len)?;
            Some((bytes.get(at + 5..end)?, end))
        }
        _ => None,
    }
}

fn read_field_tag(bytes: &[u8], at: usize) -> Option<(u8, usize)> {
    let op = *bytes.get(at)?;
    if op == OP_FALSE {
        return Some((0, at + 1));
    }
    if op == OP_1 {
        return Some((1, at + 1));
    }
    if op == OP_3 {
        return Some((3, at + 1));
    }
    if (0x52..=OP_16).contains(&op) {
        return Some((op - 0x50, at + 1));
    }
    if let Some((data, next)) = read_push(bytes, at) {
        if data.len() == 1 && data[0] <= 16 {
            return Some((data[0], next));
        }
    }
    None
}

fn parse_parent_field3(data: &[u8]) -> Option<String> {
    if data.len() == 36 {
        let txid = encode_hex(&data[0..32]);
        let vout = u32::from_le_bytes([data[32], data[33], data[34], data[35]]);
        return Some(format!("{txid}.{vout}"));
    }
    if data.len() == 32 {
        return Some(format!("{}.0", encode_hex(data)));
    }
    let text = std::str::from_utf8(data).ok()?.trim();
    let sep = text.find('_').or_else(|| text.find('.'))?;
    let (id, vout_str) = text.split_at(sep);
    let vout: u32 = vout_str[1..].parse().ok()?;
    if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(format!("{}.{vout}", id.to_ascii_lowercase()));
    }
    None
}

/// Extract optional `OP_RETURN ... 1PuQa... SET k v ...` MAP key/value metadata from a script.
pub fn parse_map_fields(script: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut i = 0usize;
    while i < script.len() {
        if script[i] == OP_RETURN {
            i += 1;
            let mut pushes: Vec<&[u8]> = Vec::new();
            while i < script.len() {
                if let Some((data, next)) = read_push(script, i) {
                    pushes.push(data);
                    i = next;
                } else {
                    i += 1;
                }
            }
            let mut idx = 0;
            while idx + 2 < pushes.len() {
                if pushes[idx] == MAP_PREFIX && pushes[idx + 1] == b"SET" {
                    idx += 2;
                    while idx + 1 < pushes.len() {
                        if pushes[idx] == b"|" {
                            idx += 1;
                            break;
                        }
                        if let (Ok(k), Ok(v)) = (
                            std::str::from_utf8(pushes[idx]),
                            std::str::from_utf8(pushes[idx + 1]),
                        ) {
                            out.insert(k.to_string(), v.to_string());
                        }
                        idx += 2;
                    }
                } else {
                    idx += 1;
                }
            }
            break;
        }
        if let Some((_, next)) = read_push(script, i) {
            i = next;
        } else {
            i += 1;
        }
    }
    out
}

/// Parse the 1Sat `OP_FALSE OP_IF "ord" ... OP_ENDIF` envelope from a locking script.
pub fn parse_ord_envelope(script: &[u8]) -> Option<OrdEnvelope> {
    let mut i = 0usize;
    while i + 2 < script.len() {
        if script[i] == OP_FALSE && script[i + 1] == OP_IF {
            if let Some((marker, mut pos)) = read_push(script, i + 2) {
                if marker == b"ord" {
                    let mut content_type = String::new();
                    let mut body = Vec::new();
                    let mut parent_outpoint = None;
                    let mut closed = false;

                    while pos < script.len() {
                        if script[pos] == OP_ENDIF {
                            closed = true;
                            break;
                        }
                        let Some((tag, after_tag)) = read_field_tag(script, pos) else {
                            break;
                        };
                        let Some((val, after_val)) = read_push(script, after_tag) else {
                            break;
                        };
                        match tag {
                            0 => body.extend_from_slice(val),
                            1 => {
                                if let Ok(s) = std::str::from_utf8(val) {
                                    content_type = s.trim().to_string();
                                }
                            }
                            3 => parent_outpoint = parse_parent_field3(val),
                            _ => {}
                        }
                        pos = after_val;
                    }

                    if closed && (!content_type.is_empty() || !body.is_empty()) {
                        return Some(OrdEnvelope {
                            content_type,
                            body,
                            parent_outpoint,
                            map_fields: parse_map_fields(script),
                        });
                    }
                }
            }
        }
        if let Some((_, next)) = read_push(script, i) {
            i = next;
        } else {
            i += 1;
        }
    }
    None
}

pub fn has_ord_envelope(script: &[u8]) -> bool {
    parse_ord_envelope(script).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_1sat_ord_envelope_and_map_metadata() {
        let mut script = Vec::new();
        // P2PKH prefix
        script.extend_from_slice(&[0x76, 0xa9, 0x14]);
        script.extend_from_slice(&[0x22; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        // OP_FALSE OP_IF "ord" OP_1 "image/png" OP_0 <bytes> OP_ENDIF
        script.push(0x00);
        script.push(0x63);
        script.push(3);
        script.extend_from_slice(b"ord");
        script.push(0x51);
        script.push(9);
        script.extend_from_slice(b"image/png");
        script.push(0x00);
        script.push(4);
        script.extend_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
        script.push(0x68);
        // OP_RETURN MAP SET name "Fox #1"
        script.push(0x6a);
        script.push(MAP_PREFIX.len() as u8);
        script.extend_from_slice(MAP_PREFIX);
        script.push(3);
        script.extend_from_slice(b"SET");
        script.push(4);
        script.extend_from_slice(b"name");
        script.push(6);
        script.extend_from_slice(b"Fox #1");

        let env = parse_ord_envelope(&script).unwrap();
        assert_eq!(env.content_type, "image/png");
        assert_eq!(env.body, vec![0x89, 0x50, 0x4e, 0x47]);
        assert_eq!(env.map_fields.get("name").map(String::as_str), Some("Fox #1"));
    }
}
