// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Native Rust BRC-39 encryption and decryption.
//!
//! Byte-compatible with `src/wallet/brc39Lean.ts` and `@handcash/wallet-engine`:
//! - Magic: `WDAT` (`[0x57, 0x44, 0x41, 0x54]`)
//! - 33-byte header (`[1, 1, 38, 1, 0]`, salt_len=32, nonce_len=32,
//!   iterations=7 BE, memory_kib=131072 BE, parallelism=1, hash_len=32, 12 zero bytes)
//! - KDF: Argon2id over NFC-normalized UTF-8 password
//! - Cipher: AES-256-GCM with 32-byte nonce (NIST SP 800-38D GHASH) and 16-byte tag
//!
//! Runs natively off the UI thread (~10x faster than WASM Argon2id with 0 ms UI block).

use aes::Aes256;
use aes_gcm::aead::consts::{U12, U32};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{AesGcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use serde_json::Value;
use std::fmt;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const MAGIC: [u8; 4] = [0x57, 0x44, 0x41, 0x54];
pub const HEADER_LENGTH: usize = 33;
pub const TAG_LENGTH: usize = 16;
pub const DEFAULT_ITERATIONS: u32 = 7;
pub const DEFAULT_MEMORY_KIB: u32 = 131_072;
pub const DEFAULT_PARALLELISM: u32 = 1;
pub const HASH_LENGTH: usize = 32;
pub const SALT_LENGTH: usize = 32;
pub const NONCE_LENGTH: usize = 32;

/// Upper bounds matching `ARGON2ID_MAX_*` in wallet-engine so malicious files cannot OOM.
pub const MAX_ITERATIONS: u32 = 32;
pub const MAX_MEMORY_KIB: u32 = 524_288; // 512 MiB
pub const MAX_PARALLELISM: u32 = 16;

type Aes256Gcm32 = AesGcm<Aes256, U32>;
type Aes256Gcm12 = AesGcm<Aes256, U12>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brc39Params {
    pub iterations: u32,
    pub memory_kib: u32,
    pub parallelism: u32,
}

impl Default for Brc39Params {
    fn default() -> Self {
        Self {
            iterations: DEFAULT_ITERATIONS,
            memory_kib: DEFAULT_MEMORY_KIB,
            parallelism: DEFAULT_PARALLELISM,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Brc39Error {
    InvalidDocument(String),
    InvalidHeader(String),
    KdfFailed(String),
    AuthenticationFailed,
}

impl fmt::Display for Brc39Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDocument(msg) => write!(f, "Invalid BRC-38 document: {msg}"),
            Self::InvalidHeader(msg) => write!(f, "{msg}"),
            Self::KdfFailed(msg) => write!(f, "BRC-39 KDF failed: {msg}"),
            Self::AuthenticationFailed => write!(f, "BRC-39 authentication failed"),
        }
    }
}

impl std::error::Error for Brc39Error {}

/// Structural check that the JSON document is a valid BRC-38 wallet export
/// (`brc: 38`, `schema: "brc-38"`, `tables` object, no null values).
pub fn validate_brc38_json(json: &str) -> Result<Value, Brc39Error> {
    let val: Value =
        serde_json::from_str(json).map_err(|e| Brc39Error::InvalidDocument(e.to_string()))?;
    let Some(obj) = val.as_object() else {
        return Err(Brc39Error::InvalidDocument("root must be an object".into()));
    };
    if obj.get("brc").and_then(|v| v.as_u64()) != Some(38)
        && obj.get("schema").and_then(|v| v.as_str()) != Some("brc-38")
    {
        return Err(Brc39Error::InvalidDocument(
            "missing brc=38 or schema=brc-38".into(),
        ));
    }
    if !obj.get("tables").is_some_and(|t| t.is_object()) {
        return Err(Brc39Error::InvalidDocument(
            "missing tables object".into(),
        ));
    }
    reject_nulls(&val, "root")?;
    Ok(val)
}

fn reject_nulls(val: &Value, path: &str) -> Result<(), Brc39Error> {
    match val {
        Value::Null => Err(Brc39Error::InvalidDocument(format!(
            "BRC-38 {path} must omit null values"
        ))),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                reject_nulls(item, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (k, v) in map {
                reject_nulls(v, &format!("{path}.{k}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn derive_key(
    password: &str,
    salt: &[u8],
    params: &Brc39Params,
) -> Result<Zeroizing<[u8; HASH_LENGTH]>, Brc39Error> {
    if params.iterations == 0 || params.iterations > MAX_ITERATIONS {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 Argon2id iterations".into(),
        ));
    }
    if params.memory_kib == 0 || params.memory_kib > MAX_MEMORY_KIB {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 Argon2id memoryKiB".into(),
        ));
    }
    if params.parallelism == 0 || params.parallelism > MAX_PARALLELISM {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 Argon2id parallelism".into(),
        ));
    }
    let normalized: Zeroizing<String> = Zeroizing::new(password.nfc().collect());
    let argon_params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(HASH_LENGTH),
    )
    .map_err(|e| Brc39Error::KdfFailed(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut key = Zeroizing::new([0u8; HASH_LENGTH]);
    argon
        .hash_password_into(normalized.as_bytes(), salt, &mut *key)
        .map_err(|e| Brc39Error::KdfFailed(e.to_string()))?;
    Ok(key)
}

/// Encrypt a BRC-38 JSON document using standard BRC-39 parameters (7 passes, 128 MiB).
pub fn encrypt_brc39(json: &str, password: &str) -> Result<Vec<u8>, Brc39Error> {
    encrypt_brc39_with_params(json, password, &Brc39Params::default())
}

/// Encrypt a BRC-38 JSON document with explicit Argon2id parameters (used in unit tests).
pub fn encrypt_brc39_with_params(
    json: &str,
    password: &str,
    params: &Brc39Params,
) -> Result<Vec<u8>, Brc39Error> {
    validate_brc38_json(json)?;
    let mut salt = [0u8; SALT_LENGTH];
    let mut nonce = [0u8; NONCE_LENGTH];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce);

    let key_bytes = derive_key(password, &salt, params)?;
    let cipher = Aes256Gcm32::new(Key::<Aes256Gcm32>::from_slice(&*key_bytes));
    let sealed = cipher
        .encrypt(Nonce::<U32>::from_slice(&nonce), json.as_bytes())
        .map_err(|_| Brc39Error::AuthenticationFailed)?;

    let mut out = Vec::with_capacity(HEADER_LENGTH + SALT_LENGTH + NONCE_LENGTH + sealed.len());
    out.extend_from_slice(&MAGIC);
    out.push(1);
    out.push(1);
    out.push(38);
    out.push(1);
    out.push(0);
    out.push(SALT_LENGTH as u8);
    out.push(NONCE_LENGTH as u8);
    out.extend_from_slice(&params.iterations.to_be_bytes());
    out.extend_from_slice(&params.memory_kib.to_be_bytes());
    out.push(params.parallelism as u8);
    out.push(HASH_LENGTH as u8);
    out.extend_from_slice(&[0u8; 12]);
    debug_assert_eq!(out.len(), HEADER_LENGTH);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Decrypt and validate a BRC-39 file, returning the authenticated UTF-8 BRC-38 JSON string.
pub fn decrypt_brc39(bytes: &[u8], password: &str) -> Result<String, Brc39Error> {
    if bytes.len() < 51 {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 file: too short".into(),
        ));
    }
    if bytes[0..4] != MAGIC {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 file: bad magic".into(),
        ));
    }
    if bytes[4..9] != [1, 1, 38, 1, 0] {
        return Err(Brc39Error::InvalidHeader(
            "Unsupported BRC-39 header".into(),
        ));
    }
    if bytes[21..HEADER_LENGTH].iter().any(|&b| b != 0) {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 reserved bytes".into(),
        ));
    }
    let salt_len = bytes[9] as usize;
    let nonce_len = bytes[10] as usize;
    if salt_len == 0 {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 salt length".into(),
        ));
    }
    if nonce_len == 0 {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 nonce length".into(),
        ));
    }
    let iterations = u32::from_be_bytes([bytes[11], bytes[12], bytes[13], bytes[14]]);
    let memory_kib = u32::from_be_bytes([bytes[15], bytes[16], bytes[17], bytes[18]]);
    let parallelism = bytes[19] as u32;
    if bytes[20] as usize != HASH_LENGTH {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 Argon2id hashLength".into(),
        ));
    }
    let payload_start = HEADER_LENGTH + salt_len + nonce_len;
    if bytes.len() <= payload_start + TAG_LENGTH {
        return Err(Brc39Error::InvalidHeader(
            "Invalid BRC-39 ciphertext".into(),
        ));
    }

    let salt = &bytes[HEADER_LENGTH..HEADER_LENGTH + salt_len];
    let nonce = &bytes[HEADER_LENGTH + salt_len..payload_start];
    let ciphertext = &bytes[payload_start..];

    let key_bytes = derive_key(
        password,
        salt,
        &Brc39Params {
            iterations,
            memory_kib,
            parallelism,
        },
    )?;

    let plaintext = match nonce_len {
        NONCE_LENGTH => {
            let cipher = Aes256Gcm32::new(Key::<Aes256Gcm32>::from_slice(&*key_bytes));
            cipher
                .decrypt(Nonce::<U32>::from_slice(nonce), ciphertext)
                .map_err(|_| Brc39Error::AuthenticationFailed)?
        }
        12 => {
            let cipher = Aes256Gcm12::new(Key::<Aes256Gcm12>::from_slice(&*key_bytes));
            cipher
                .decrypt(Nonce::<U12>::from_slice(nonce), ciphertext)
                .map_err(|_| Brc39Error::AuthenticationFailed)?
        }
        other => {
            return Err(Brc39Error::InvalidHeader(format!(
                "Unsupported BRC-39 nonce length: {other}"
            )));
        }
    };

    let json = String::from_utf8(plaintext)
        .map_err(|e| Brc39Error::InvalidDocument(format!("invalid UTF-8: {e}")))?;
    validate_brc38_json(&json)?;
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_params() -> Brc39Params {
        Brc39Params {
            iterations: 1,
            memory_kib: 1024,
            parallelism: 1,
        }
    }

    #[test]
    fn roundtrips_and_validates_brc39_header_and_nfc_password() {
        let doc = r#"{"brc":38,"schema":"brc-38","tables":{"outputs":[],"transactions":[]}}"#;
        // NFD ("u\u{0308}") must derive the exact same key as NFC ("\u{00fc}")
        let nfd_pw = "history-secret u\u{0308}";
        let nfc_pw = "history-secret \u{00fc}";

        let sealed = encrypt_brc39_with_params(doc, nfd_pw, &fast_params()).unwrap();
        assert_eq!(&sealed[0..4], b"WDAT");
        assert_eq!(&sealed[4..9], &[1, 1, 38, 1, 0]);
        assert_eq!(sealed[9], 32);
        assert_eq!(sealed[10], 32);
        assert_eq!(sealed[20], 32);
        assert!(sealed[21..33].iter().all(|&b| b == 0));

        let opened = decrypt_brc39(&sealed, nfc_pw).unwrap();
        assert_eq!(opened, doc);

        // Wrong password fails closed.
        assert_eq!(
            decrypt_brc39(&sealed, "wrong"),
            Err(Brc39Error::AuthenticationFailed)
        );

        // Tampered ciphertext fails closed.
        let mut tampered = sealed.clone();
        let idx = tampered.len() - 20;
        tampered[idx] ^= 1;
        assert_eq!(
            decrypt_brc39(&tampered, nfc_pw),
            Err(Brc39Error::AuthenticationFailed)
        );
    }

    #[test]
    fn aes256_gcm_32byte_nonce_matches_webcrypto_byte_for_byte() {
        let key_bytes: [u8; 32] = core::array::from_fn(|i| (i + 1) as u8);
        let nonce_bytes: [u8; 32] = core::array::from_fn(|i| 0xa0u8.wrapping_add(i as u8));
        let pt = br#"{"brc":38,"tables":{}}"#;
        let cipher = Aes256Gcm32::new(Key::<Aes256Gcm32>::from_slice(&key_bytes));
        let ct = cipher
            .encrypt(Nonce::<U32>::from_slice(&nonce_bytes), pt.as_slice())
            .unwrap();
        // Exact vector produced by WebCrypto crypto.subtle.encrypt({ name: "AES-GCM", iv: 32-byte, tagLength: 128 }).
        assert_eq!(
            crate::encoding::encode_hex(&ct),
            "07e190e90ed122cb6f6cfb43ef2a3498dc96bee0ce122cbaa4712cd07dcdfdc4c80b8856adb4"
        );
    }

    #[test]
    fn rejects_invalid_brc38_documents_and_nulls() {
        assert!(matches!(
            encrypt_brc39_with_params(r#"{"brc":38}"#, "pw", &fast_params()),
            Err(Brc39Error::InvalidDocument(_))
        ));
        assert!(matches!(
            encrypt_brc39_with_params(
                r#"{"brc":38,"tables":{"outputs":[{"a":null}]}}"#,
                "pw",
                &fast_params()
            ),
            Err(Brc39Error::InvalidDocument(_))
        ));
    }
}
