// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! SHA-256 content-addressed cold blob storage and base64 wire helpers for `ToolboxDb`.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Store binary bytes in `cold_blobs` keyed by SHA-256 hex digest.
/// Returns the 64-char hex digest.
pub fn put_cold_blob(conn: &Connection, bytes: &[u8]) -> rusqlite::Result<String> {
    let digest = hex::encode(Sha256::digest(bytes));
    conn.execute(
        "INSERT OR IGNORE INTO cold_blobs (hash, data) VALUES (?1, ?2)",
        params![digest, bytes],
    )?;
    Ok(digest)
}

pub fn get_cold_blob(conn: &Connection, hash: &str) -> rusqlite::Result<Option<Vec<u8>>> {
    conn.query_row(
        "SELECT data FROM cold_blobs WHERE hash = ?1",
        params![hash],
        |row| row.get(0),
    )
    .optional()
}

/// Slice a cold blob directly inside SQLite (`substr` is 1-indexed) without
/// copying multi-megabyte raw transactions out of SQLite when only a small
/// locking script slice is needed.
pub fn get_cold_blob_slice(
    conn: &Connection,
    hash: &str,
    offset: usize,
    length: usize,
) -> rusqlite::Result<Option<Vec<u8>>> {
    if length == 0 {
        return Ok(Some(Vec::new()));
    }
    let start_1based = (offset as i64).saturating_add(1);
    let len_i64 = length as i64;
    let slice: Option<Vec<u8>> = conn
        .query_row(
            "SELECT substr(data, ?2, ?3) FROM cold_blobs WHERE hash = ?1",
            params![hash, start_1based, len_i64],
            |row| row.get(0),
        )
        .optional()?;
    Ok(slice.filter(|b| b.len() == length))
}

pub fn get_cold_blob_len(conn: &Connection, hash: &str) -> rusqlite::Result<usize> {
    let len: Option<i64> = conn
        .query_row(
            "SELECT length(data) FROM cold_blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .optional()?;
    Ok(len.unwrap_or(0).max(0) as usize)
}

pub fn encode_b64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/// Decode wire bytes from either a base64 string (fast path) or a JSON array of
/// byte integers (`[u8, ...]`, compatibility fallback).
pub fn decode_wire_bytes(val: Option<&Value>) -> Result<Option<Vec<u8>>, String> {
    let Some(v) = val else {
        return Ok(None);
    };
    if v.is_null() {
        return Ok(None);
    }
    if let Some(s) = v.as_str() {
        let bytes = BASE64
            .decode(s)
            .map_err(|e| format!("invalid base64 binary field: {e}"))?;
        return Ok(Some(bytes));
    }
    if let Some(arr) = v.as_array() {
        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            let Some(n) = item.as_u64() else {
                return Err("invalid byte array element".into());
            };
            if n > 255 {
                return Err(format!("byte value out of range: {n}"));
            }
            out.push(n as u8);
        }
        return Ok(Some(out));
    }
    Err("expected base64 string or byte array".into())
}

/// Convenience helper: extract binary field from JSON object checking `<key>B64` first,
/// then `<key>`. Returns:
/// - `Ok(None)` if neither key is present
/// - `Ok(Some(None))` if key is explicitly `null` (clear column)
/// - `Ok(Some(Some(bytes)))` if binary payload is provided.
pub fn extract_wire_bytes_field(
    obj: &serde_json::Map<String, Value>,
    b64_key: &str,
    raw_key: &str,
) -> Result<Option<Option<Vec<u8>>>, String> {
    if let Some(v) = obj.get(b64_key) {
        if v.is_null() {
            return Ok(Some(None));
        }
        return Ok(Some(decode_wire_bytes(Some(v))?));
    }
    if let Some(v) = obj.get(raw_key) {
        if v.is_null() {
            return Ok(Some(None));
        }
        return Ok(Some(decode_wire_bytes(Some(v))?));
    }
    Ok(None)
}
