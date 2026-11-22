// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Bitcoin 80-byte block header serialization and Proof-of-Work self-verification.
//!
//! Matches `src/wallet/blockHeaders.ts`: an untrusted header from any public API is
//! accepted ONLY when its 80-byte double-SHA-256 matches its advertised hash AND
//! satisfies the compact-target proof-of-work encoded in `bits`.

use crate::{reverse_32, BitcoinError};
use handcash_primitives::encoding::{decode_hex, double_sha256, encode_hex};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockHeader {
    pub height: u64,
    pub hash: String,
    pub version: u32,
    pub previous_hash: String,
    pub merkle_root: String,
    pub time: u32,
    pub bits: u32,
    pub nonce: u32,
}

impl BlockHeader {
    /// Serialize the canonical 80-byte Bitcoin block header.
    pub fn serialize_80(&self) -> Result<[u8; 80], BitcoinError> {
        let prev = decode_hex(&self.previous_hash)
            .map_err(|e| BitcoinError::InvalidHeader(e.to_string()))?;
        let root = decode_hex(&self.merkle_root)
            .map_err(|e| BitcoinError::InvalidHeader(e.to_string()))?;
        if prev.len() != 32 || root.len() != 32 {
            return Err(BitcoinError::InvalidHeader(
                "previous_hash and merkle_root must be 32 bytes".into(),
            ));
        }
        let mut prev32 = [0u8; 32];
        prev32.copy_from_slice(&prev);
        let mut root32 = [0u8; 32];
        root32.copy_from_slice(&root);

        let mut out = [0u8; 80];
        out[0..4].copy_from_slice(&self.version.to_le_bytes());
        out[4..36].copy_from_slice(&reverse_32(prev32));
        out[36..68].copy_from_slice(&reverse_32(root32));
        out[68..72].copy_from_slice(&self.time.to_le_bytes());
        out[72..76].copy_from_slice(&self.bits.to_le_bytes());
        out[76..80].copy_from_slice(&self.nonce.to_le_bytes());
        Ok(out)
    }

    /// Compute the big-endian display block hash from the 80 header bytes.
    pub fn computed_hash(&self) -> Result<String, BitcoinError> {
        let bytes = self.serialize_80()?;
        Ok(encode_hex(&reverse_32(double_sha256(&bytes))))
    }

    /// True iff `double_sha256(header80)` equals `self.hash` AND `hash <= target(bits)`.
    pub fn self_proving(&self) -> bool {
        let Ok(bytes) = self.serialize_80() else {
            return false;
        };
        let hash_be = reverse_32(double_sha256(&bytes));
        if encode_hex(&hash_be) != self.hash.trim().to_ascii_lowercase() {
            return false;
        }
        let Some(target_be) = target_from_bits(self.bits) else {
            return false;
        };
        // Both hash_be and target_be are 256-bit unsigned big-endian integers.
        hash_be <= target_be
    }
}

/// Convert Bitcoin compact `bits` into a 256-bit big-endian target array.
/// Returns `None` for zero, negative, or overflowing targets.
pub fn target_from_bits(bits: u32) -> Option<[u8; 32]> {
    let exponent = (bits >> 24) as usize;
    let mantissa = bits & 0x00ff_ffff;
    if mantissa == 0 || (mantissa & 0x0080_0000) != 0 {
        return None;
    }
    let mut target = [0u8; 32];
    if exponent <= 3 {
        let shifted = mantissa >> (8 * (3 - exponent));
        if shifted == 0 {
            return None;
        }
        target[29] = ((shifted >> 16) & 0xff) as u8;
        target[30] = ((shifted >> 8) & 0xff) as u8;
        target[31] = (shifted & 0xff) as u8;
    } else {
        if exponent > 32 {
            return None;
        }
        // `mantissa << (8 * (exponent - 3))` places the 3 mantissa bytes ending at byte `32 - (exponent - 3)`.
        let start = 32 - exponent;
        target[start] = ((mantissa >> 16) & 0xff) as u8;
        target[start + 1] = ((mantissa >> 8) & 0xff) as u8;
        target[start + 2] = (mantissa & 0xff) as u8;
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_bitcoin_genesis_block_header_pow_and_rejects_tampered() {
        // Real Bitcoin Genesis block (height 0) — independently verifiable public vector.
        let genesis = BlockHeader {
            height: 0,
            hash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f".into(),
            version: 1,
            previous_hash: "00".repeat(32),
            merkle_root: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b".into(),
            time: 1_231_006_505,
            bits: 0x1d00_ffff,
            nonce: 2_083_236_893,
        };
        assert!(genesis.self_proving());

        // Tampered nonce fails hash match & PoW.
        let mut tampered = genesis.clone();
        tampered.nonce += 1;
        assert!(!tampered.self_proving());

        // Forged hash claiming impossible difficulty target fails PoW.
        let mut fake_bits = genesis;
        fake_bits.bits = 0x0300_0001;
        fake_bits.hash = fake_bits.computed_hash().unwrap();
        assert!(!fake_bits.self_proving());
    }
}
