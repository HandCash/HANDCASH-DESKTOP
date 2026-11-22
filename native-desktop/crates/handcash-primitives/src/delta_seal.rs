// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Fast session-keyed HKDF + AES-256-GCM sealing for append-only fact segments.
//!
//! Full BRC-39 checkpoints run 128 MiB / 7-pass Argon2id on a background OS thread;
//! incremental fact-segment replication seals each small delta segment in microseconds
//! using an HKDF-SHA-256 subkey derived once per unlocked session from the account root key.

use crate::encoding::hkdf_sha256_32;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use std::fmt;
use zeroize::Zeroizing;

pub const DELTA_MAGIC: [u8; 4] = *b"HCD1";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const HKDF_INFO_PREFIX: &[u8] = b"handcash-fact-segment-seal-v1:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeltaSealError {
    Malformed,
    AuthenticationFailed,
}

impl fmt::Display for DeltaSealError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed => write!(f, "malformed sealed delta segment"),
            Self::AuthenticationFailed => write!(f, "delta segment authentication failed"),
        }
    }
}

impl std::error::Error for DeltaSealError {}

/// Session-cached AEAD key derived via HKDF-SHA-256 from the account root key.
/// Zeroized automatically on drop (lock / account switch).
pub struct DeltaSessionKey {
    account_id: String,
    key: Zeroizing<[u8; 32]>,
}

impl DeltaSessionKey {
    pub fn derive(root_key_bytes: &[u8], account_id: &str) -> Self {
        let mut info = Vec::with_capacity(HKDF_INFO_PREFIX.len() + account_id.len());
        info.extend_from_slice(HKDF_INFO_PREFIX);
        info.extend_from_slice(account_id.as_bytes());
        let derived = hkdf_sha256_32(None, root_key_bytes, &info);
        Self {
            account_id: account_id.to_string(),
            key: Zeroizing::new(derived),
        }
    }

    /// Seal a fact segment with `segment_root` bound as AES-GCM AAD.
    pub fn seal(&self, segment_root: &str, plaintext: &[u8]) -> Result<Vec<u8>, DeltaSealError> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*self.key));
        let aad = self.aad_bytes(segment_root);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| DeltaSealError::AuthenticationFailed)?;
        let mut out = Vec::with_capacity(DELTA_MAGIC.len() + NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&DELTA_MAGIC);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Unseal and authenticate a fact segment against its expected `segment_root`.
    pub fn open(&self, segment_root: &str, sealed: &[u8]) -> Result<Vec<u8>, DeltaSealError> {
        if sealed.len() < DELTA_MAGIC.len() + NONCE_LEN + TAG_LEN {
            return Err(DeltaSealError::Malformed);
        }
        if sealed[0..4] != DELTA_MAGIC {
            return Err(DeltaSealError::Malformed);
        }
        let nonce = &sealed[4..4 + NONCE_LEN];
        let ciphertext = &sealed[4 + NONCE_LEN..];
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*self.key));
        let aad = self.aad_bytes(segment_root);
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| DeltaSealError::AuthenticationFailed)
    }

    fn aad_bytes(&self, segment_root: &str) -> Vec<u8> {
        let mut aad = Vec::with_capacity(self.account_id.len() + 1 + segment_root.len());
        aad.extend_from_slice(self.account_id.as_bytes());
        aad.push(b':');
        aad.extend_from_slice(segment_root.as_bytes());
        aad
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_opens_and_binds_account_and_root_aad() {
        let key_a = DeltaSessionKey::derive(b"test-root-key-material-32bytes!!", "acct-1");
        let key_b = DeltaSessionKey::derive(b"test-root-key-material-32bytes!!", "acct-2");
        let payload = br#"{"facts":["f1","f2"]}"#;
        let sealed = key_a.seal("root-abc", payload).unwrap();

        assert_eq!(key_a.open("root-abc", &sealed).unwrap(), payload);
        // Wrong root AAD fails closed.
        assert_eq!(
            key_a.open("root-other", &sealed),
            Err(DeltaSealError::AuthenticationFailed)
        );
        // Cross-account key fails closed.
        assert_eq!(
            key_b.open("root-abc", &sealed),
            Err(DeltaSealError::AuthenticationFailed)
        );
    }
}
