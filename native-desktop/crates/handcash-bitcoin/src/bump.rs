// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! BRC-74 BUMP (Bitcoin Unified Merkle Path) parser & SPV merkle-root verifier.

use crate::header::BlockHeader;
use crate::{reverse_32, write_varint, BitcoinError, Reader};
use handcash_primitives::encoding::{decode_hex, double_sha256, encode_hex};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const FLAG_HASH: u8 = 0x00;
pub const FLAG_DUPLICATE: u8 = 0x01;
pub const FLAG_TXID: u8 = 0x02;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BumpLeaf {
    pub offset: u64,
    pub hash: Option<[u8; 32]>, // internal wire byte order
    pub txid: bool,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bump {
    pub block_height: u64,
    pub path: Vec<Vec<BumpLeaf>>,
}

impl Bump {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BitcoinError> {
        let mut r = Reader::new(bytes);
        let bump = Self::read_from(&mut r)?;
        if r.remaining() > 0 {
            return Err(BitcoinError::TrailingBytes(r.remaining()));
        }
        Ok(bump)
    }

    pub fn read_from(r: &mut Reader<'_>) -> Result<Self, BitcoinError> {
        let block_height = r.read_varint()?;
        let tree_height = r.read_u8()? as usize;
        if tree_height == 0 || tree_height > 64 {
            return Err(BitcoinError::InvalidBump(format!(
                "invalid tree height {tree_height}"
            )));
        }
        let mut path = Vec::with_capacity(tree_height);
        for _ in 0..tree_height {
            let n_leaves = r.read_varint()?;
            if n_leaves > 100_000 {
                return Err(BitcoinError::InvalidBump("too many leaves".into()));
            }
            let mut level = Vec::with_capacity((n_leaves as usize).min(256));
            for _ in 0..n_leaves {
                let offset = r.read_varint()?;
                let flags = r.read_u8()?;
                let duplicate = (flags & FLAG_DUPLICATE) != 0;
                let txid = (flags & FLAG_TXID) != 0;
                let hash = if duplicate {
                    None
                } else {
                    Some(r.read_exact::<32>()?)
                };
                level.push(BumpLeaf {
                    offset,
                    hash,
                    txid,
                    duplicate,
                });
            }
            path.push(level);
        }
        Ok(Self { block_height, path })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        write_varint(&mut out, self.block_height);
        out.push(self.path.len() as u8);
        for level in &self.path {
            write_varint(&mut out, level.len() as u64);
            for leaf in level {
                write_varint(&mut out, leaf.offset);
                let mut flags = FLAG_HASH;
                if leaf.duplicate {
                    flags |= FLAG_DUPLICATE;
                }
                if leaf.txid {
                    flags |= FLAG_TXID;
                }
                out.push(flags);
                if !leaf.duplicate {
                    if let Some(h) = leaf.hash {
                        out.extend_from_slice(&h);
                    }
                }
            }
        }
        out
    }

    /// Compute the display-order lowercase 64-hex merkle root for `txid_hex` from this BUMP.
    pub fn compute_merkle_root(&self, txid_hex: &str) -> Result<String, BitcoinError> {
        let decoded =
            decode_hex(txid_hex.trim()).map_err(|e| BitcoinError::InvalidHex(e.to_string()))?;
        if decoded.len() != 32 {
            return Err(BitcoinError::InvalidHex("txid must be 32 bytes".into()));
        }
        let mut txid_be = [0u8; 32];
        txid_be.copy_from_slice(&decoded);
        let txid_le = reverse_32(txid_be);

        let level0 = self
            .path
            .first()
            .ok_or_else(|| BitcoinError::InvalidBump("empty path".into()))?;
        let start_leaf = level0
            .iter()
            .find(|l| l.hash == Some(txid_le))
            .ok_or_else(|| {
                BitcoinError::SpvFailed(format!("txid {txid_hex} not found at BUMP level 0"))
            })?;

        // Special case: single-tx coinbase block (tree_height == 1 and offset == 0).
        if self.path.len() == 1 && level0.len() == 1 && start_leaf.offset == 0 {
            return Ok(encode_hex(&reverse_32(txid_le)));
        }

        let mut working_offset = start_leaf.offset;
        let mut working_hash = txid_le;

        for level in &self.path {
            let mut by_offset: HashMap<u64, &BumpLeaf> = HashMap::with_capacity(level.len());
            for leaf in level {
                by_offset.insert(leaf.offset, leaf);
            }
            let sibling_offset = working_offset ^ 1;
            let sibling = by_offset.get(&sibling_offset).ok_or_else(|| {
                BitcoinError::SpvFailed(format!(
                    "missing sibling at offset {sibling_offset} in BUMP"
                ))
            })?;
            let sibling_hash = if sibling.duplicate {
                working_hash
            } else {
                sibling.hash.ok_or_else(|| {
                    BitcoinError::InvalidBump("non-duplicate leaf missing hash".into())
                })?
            };
            let mut pair = [0u8; 64];
            if (working_offset & 1) == 0 {
                pair[0..32].copy_from_slice(&working_hash);
                pair[32..64].copy_from_slice(&sibling_hash);
            } else {
                pair[0..32].copy_from_slice(&sibling_hash);
                pair[32..64].copy_from_slice(&working_hash);
            }
            working_hash = double_sha256(&pair);
            working_offset >>= 1;
        }

        Ok(encode_hex(&reverse_32(working_hash)))
    }

    /// Cryptographically verify `txid_hex` against a self-proving `BlockHeader`.
    pub fn verify_against_header(
        &self,
        txid_hex: &str,
        header: &BlockHeader,
    ) -> Result<String, BitcoinError> {
        if !header.self_proving() {
            return Err(BitcoinError::SpvFailed(
                "block header failed PoW self-verification".into(),
            ));
        }
        if header.height != self.block_height {
            return Err(BitcoinError::SpvFailed(format!(
                "BUMP height {} does not match header height {}",
                self.block_height, header.height
            )));
        }
        let computed = self.compute_merkle_root(txid_hex)?;
        if computed != header.merkle_root.trim().to_ascii_lowercase() {
            return Err(BitcoinError::SpvFailed(format!(
                "computed merkle root {computed} != header merkle root {}",
                header.merkle_root
            )));
        }
        Ok(computed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_bump_and_computes_exact_merkle_root() {
        let tx0 = [0x11u8; 32];
        let tx1 = [0x22u8; 32];
        let tx2 = [0x33u8; 32];

        let mut p01 = [0u8; 64];
        p01[0..32].copy_from_slice(&tx0);
        p01[32..64].copy_from_slice(&tx1);
        let h01 = double_sha256(&p01);

        let mut p22 = [0u8; 64];
        p22[0..32].copy_from_slice(&tx2);
        p22[32..64].copy_from_slice(&tx2);
        let h22 = double_sha256(&p22);

        let mut root_pair = [0u8; 64];
        root_pair[0..32].copy_from_slice(&h01);
        root_pair[32..64].copy_from_slice(&h22);
        let expected_root = encode_hex(&reverse_32(double_sha256(&root_pair)));

        let bump = Bump {
            block_height: 850_000,
            path: vec![
                vec![
                    BumpLeaf {
                        offset: 2,
                        hash: Some(tx2),
                        txid: true,
                        duplicate: false,
                    },
                    BumpLeaf {
                        offset: 3,
                        hash: None,
                        txid: false,
                        duplicate: true,
                    },
                ],
                vec![BumpLeaf {
                    offset: 0,
                    hash: Some(h01),
                    txid: false,
                    duplicate: false,
                }],
            ],
        };

        let raw = bump.to_bytes();
        let parsed = Bump::from_bytes(&raw).unwrap();
        assert_eq!(parsed, bump);

        let tx2_display = encode_hex(&reverse_32(tx2));
        assert_eq!(
            parsed.compute_merkle_root(&tx2_display).unwrap(),
            expected_root
        );
    }
}
