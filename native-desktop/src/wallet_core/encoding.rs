// Copyright HandCash. Licensed under the Apache License, Version 2.0.
// Meridian M1 leaf primitives: strict ASCII hex encoding and SHA-256 / HMAC-SHA-256
// backed by audited permissive Rust crates (`sha2`, `ring`).

use ring::hmac;
use sha2::{Digest, Sha256};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodingError {
    OddLength(usize),
    InvalidHexByte { index: usize, byte: u8 },
}

impl fmt::Display for EncodingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OddLength(len) => write!(f, "hex input must have even length (got {len})"),
            Self::InvalidHexByte { index, byte } => {
                write!(f, "invalid ASCII hex byte 0x{byte:02x} at offset {index}")
            }
        }
    }
}

impl std::error::Error for EncodingError {}

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// Encode bytes as lowercase, two ASCII hexadecimal digits per byte.
pub fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX_LOWER[(b >> 4) as usize] as char);
        out.push(HEX_LOWER[(b & 0x0f) as usize] as char);
    }
    out
}

#[inline]
fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode strict even-length ASCII hexadecimal only.
/// Rejects whitespace, `0x` prefixes, odd lengths and non-hex bytes; preserves zero bytes.
pub fn decode_hex(input: &str) -> Result<Vec<u8>, EncodingError> {
    let raw = input.as_bytes();
    if !raw.len().is_multiple_of(2) {
        return Err(EncodingError::OddLength(raw.len()));
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    for (pair_idx, pair) in raw.as_chunks::<2>().0.iter().enumerate() {
        let hi = hex_nibble(pair[0]).ok_or(EncodingError::InvalidHexByte {
            index: pair_idx * 2,
            byte: pair[0],
        })?;
        let lo = hex_nibble(pair[1]).ok_or(EncodingError::InvalidHexByte {
            index: pair_idx * 2 + 1,
            byte: pair[1],
        })?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

/// Single SHA-256 digest.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Double SHA-256 digest (`SHA256(SHA256(data))`).
pub fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = sha256(data);
    sha256(&first)
}

/// HMAC-SHA-256 MAC.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let tag = hmac::sign(&signing_key, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrips_all_256_byte_values_and_preserves_zeros() {
        let all: Vec<u8> = (0u8..=255).collect();
        let encoded = encode_hex(&all);
        assert_eq!(encoded.len(), 512);
        assert!(encoded.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        assert_eq!(decode_hex(&encoded).unwrap(), all);

        assert_eq!(encode_hex(&[]), "");
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_hex("0000ff00").unwrap(), vec![0, 0, 255, 0]);
        assert_eq!(decode_hex("DeAdBeEf").unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn hex_rejects_odd_whitespace_prefix_and_non_hex() {
        assert_eq!(decode_hex("a"), Err(EncodingError::OddLength(1)));
        assert_eq!(decode_hex("abc"), Err(EncodingError::OddLength(3)));
        assert!(matches!(
            decode_hex(" 00"),
            Err(EncodingError::OddLength(3))
        ));
        assert!(matches!(
            decode_hex("00 "),
            Err(EncodingError::OddLength(3))
        ));
        assert_eq!(
            decode_hex(" 00 "),
            Err(EncodingError::InvalidHexByte { index: 0, byte: b' ' })
        );
        assert_eq!(
            decode_hex("0x00"),
            Err(EncodingError::InvalidHexByte { index: 1, byte: b'x' })
        );
        assert_eq!(
            decode_hex("00zz"),
            Err(EncodingError::InvalidHexByte { index: 2, byte: b'z' })
        );
    }

    #[test]
    fn sha256_and_double_sha256_match_independent_nist_vectors() {
        assert_eq!(
            encode_hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            encode_hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            encode_hex(&double_sha256(b"")),
            "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc4231_test_case_2() {
        // RFC 4231 Test Case 2: Key = "Jefe", Data = "what do ya want for nothing?"
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            encode_hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }
}
