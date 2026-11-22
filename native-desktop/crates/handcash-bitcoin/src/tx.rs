// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Bitcoin transaction parser, serializer, txid computation, and BRC-67 finality check.

use crate::{reverse_32, write_varint, BitcoinError, Reader};
use handcash_primitives::encoding::{decode_hex, double_sha256, encode_hex};
use serde::{Deserialize, Serialize};

const MAX_TX_ITEMS: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxInput {
    /// Display-order lowercase 64-hex previous transaction id.
    pub prev_txid: String,
    pub prev_vout: u32,
    pub unlocking_script: Vec<u8>,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxOutput {
    pub satoshis: u64,
    pub locking_script: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub version: u32,
    pub inputs: Vec<TxInput>,
    pub outputs: Vec<TxOutput>,
    pub lock_time: u32,
}

impl Transaction {
    /// Parse a transaction from a complete byte slice (rejects trailing bytes).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BitcoinError> {
        let mut r = Reader::new(bytes);
        let tx = Self::read_from(&mut r)?;
        if r.remaining() > 0 {
            return Err(BitcoinError::TrailingBytes(r.remaining()));
        }
        Ok(tx)
    }

    /// Parse a transaction sequentially from a `Reader` (used inside BEEF streams).
    pub fn read_from(r: &mut Reader<'_>) -> Result<Self, BitcoinError> {
        let version = r.read_u32_le()?;
        let in_count = r.read_varint()?;
        if in_count > MAX_TX_ITEMS {
            return Err(BitcoinError::InvalidVarint);
        }
        let mut inputs = Vec::with_capacity((in_count as usize).min(1024));
        for _ in 0..in_count {
            let prev_raw = r.read_exact::<32>()?;
            let prev_txid = encode_hex(&reverse_32(prev_raw));
            let prev_vout = r.read_u32_le()?;
            let unlocking_script = r.read_varbytes()?.to_vec();
            let sequence = r.read_u32_le()?;
            inputs.push(TxInput {
                prev_txid,
                prev_vout,
                unlocking_script,
                sequence,
            });
        }

        let out_count = r.read_varint()?;
        if out_count > MAX_TX_ITEMS {
            return Err(BitcoinError::InvalidVarint);
        }
        let mut outputs = Vec::with_capacity((out_count as usize).min(1024));
        for _ in 0..out_count {
            let satoshis = r.read_u64_le()?;
            let locking_script = r.read_varbytes()?.to_vec();
            outputs.push(TxOutput {
                satoshis,
                locking_script,
            });
        }

        let lock_time = r.read_u32_le()?;
        Ok(Self {
            version,
            inputs,
            outputs,
            lock_time,
        })
    }

    /// Serialize to canonical Bitcoin wire bytes.
    pub fn to_bytes(&self) -> Result<Vec<u8>, BitcoinError> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.version.to_le_bytes());
        write_varint(&mut out, self.inputs.len() as u64);
        for inp in &self.inputs {
            let decoded =
                decode_hex(&inp.prev_txid).map_err(|e| BitcoinError::InvalidHex(e.to_string()))?;
            if decoded.len() != 32 {
                return Err(BitcoinError::InvalidHex("prev_txid must be 32 bytes".into()));
            }
            let mut raw = [0u8; 32];
            raw.copy_from_slice(&decoded);
            out.extend_from_slice(&reverse_32(raw));
            out.extend_from_slice(&inp.prev_vout.to_le_bytes());
            write_varint(&mut out, inp.unlocking_script.len() as u64);
            out.extend_from_slice(&inp.unlocking_script);
            out.extend_from_slice(&inp.sequence.to_le_bytes());
        }
        write_varint(&mut out, self.outputs.len() as u64);
        for o in &self.outputs {
            out.extend_from_slice(&o.satoshis.to_le_bytes());
            write_varint(&mut out, o.locking_script.len() as u64);
            out.extend_from_slice(&o.locking_script);
        }
        out.extend_from_slice(&self.lock_time.to_le_bytes());
        Ok(out)
    }

    /// Internal wire-order txid bytes (`double_sha256(serialized)`).
    pub fn txid_internal_bytes(&self) -> Result<[u8; 32], BitcoinError> {
        let bytes = self.to_bytes()?;
        Ok(double_sha256(&bytes))
    }

    /// Canonical display-order lowercase 64-hex txid.
    pub fn txid_hex(&self) -> Result<String, BitcoinError> {
        let internal = self.txid_internal_bytes()?;
        Ok(encode_hex(&reverse_32(internal)))
    }

    /// BRC-67 finality check for unconfirmed transactions: either `lock_time == 0`
    /// or every input has `sequence == 0xffffffff`.
    pub fn is_final(&self) -> bool {
        self.lock_time == 0 || self.inputs.iter().all(|i| i.sequence == u32::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_roundtrips_and_hashes_transaction_and_checks_finality() {
        let tx = Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev_txid: "11".repeat(32),
                prev_vout: 0,
                unlocking_script: vec![0x51],
                sequence: 0xffff_ffff,
            }],
            outputs: vec![TxOutput {
                satoshis: 1,
                locking_script: vec![0x76, 0xa9, 0x14, 0x00, 0x88, 0xac],
            }],
            lock_time: 0,
        };
        let bytes = tx.to_bytes().unwrap();
        let parsed = Transaction::from_bytes(&bytes).unwrap();
        assert_eq!(parsed, tx);
        assert_eq!(parsed.txid_hex().unwrap().len(), 64);
        assert!(parsed.is_final());

        let mut non_final = tx.clone();
        non_final.lock_time = 900_000;
        non_final.inputs[0].sequence = 0xffff_fffe;
        assert!(!non_final.is_final());
    }
}
