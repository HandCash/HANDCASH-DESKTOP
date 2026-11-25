// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Meridian M1 leaf primitives: strict ASCII hex encoding, SHA-256, double SHA-256,
//! HMAC-SHA-256, and HKDF-SHA-256.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::fmt;

type HmacSha256 = Hmac<Sha256>;

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
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any size");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// HKDF-SHA-256 32-byte key derivation.
pub fn hkdf_sha256_32(salt: Option<&[u8]>, ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .expect("32 bytes is always within HKDF-SHA-256 max length");
    okm
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrips_all_256_byte_values_and_preserves_zeros() {
        let all: Vec<u8> = (0u8..=255).collect();
        let encoded = encode_hex(&all);
        assert_eq!(encoded.len(), 512);
        assert!(encoded
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        assert_eq!(decode_hex(&encoded).unwrap(), all);

        assert_eq!(encode_hex(&[]), "");
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_hex("0000ff00").unwrap(), vec![0, 0, 255, 0]);
        assert_eq!(
            decode_hex("DeAdBeEf").unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
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
            Err(EncodingError::InvalidHexByte {
                index: 0,
                byte: b' '
            })
        );
        assert_eq!(
            decode_hex("0x00"),
            Err(EncodingError::InvalidHexByte {
                index: 1,
                byte: b'x'
            })
        );
        assert_eq!(
            decode_hex("00zz"),
            Err(EncodingError::InvalidHexByte {
                index: 2,
                byte: b'z'
            })
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
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            encode_hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hkdf_sha256_is_deterministic_and_domain_separated() {
        let a = hkdf_sha256_32(Some(b"salt"), b"ikm", b"handcash-delta-v1");
        let b = hkdf_sha256_32(Some(b"salt"), b"ikm", b"handcash-delta-v1");
        let c = hkdf_sha256_32(Some(b"salt"), b"ikm", b"handcash-other-v1");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    // Ported 1:1 from `src/wallet/hexBinary.test.ts`
    #[test]
    fn hex_binary_u32_le_and_txid_byte_order_roundtrip() {
        assert_eq!(encode_hex(&0u32.to_le_bytes()), "00000000");
        assert_eq!(encode_hex(&1u32.to_le_bytes()), "01000000");
        assert_eq!(encode_hex(&0x12345678u32.to_le_bytes()), "78563412");
        let b = decode_hex("01000000").unwrap();
        assert_eq!(u32::from_le_bytes(b.try_into().unwrap()), 1);

        let txid = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        let mut rev_bytes = decode_hex(txid).unwrap();
        rev_bytes.reverse();
        let rev = encode_hex(&rev_bytes);
        assert_eq!(
            rev,
            "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100"
        );
        let mut back = decode_hex(&rev).unwrap();
        back.reverse();
        assert_eq!(encode_hex(&back), txid);
        assert_eq!(encode_hex(&decode_hex("deadbeef").unwrap()), "deadbeef");
    }
}
