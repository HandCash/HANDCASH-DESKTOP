// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! BRC-62 / BRC-95 / BRC-96 BEEF & AtomicBEEF parser, merger, and SPV verifier.

use crate::bump::Bump;
use crate::header::BlockHeader;
use crate::tx::Transaction;
use crate::{reverse_32, BitcoinError, Reader};
use handcash_primitives::encoding::encode_hex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Wire version magic constants (LE u32: `0xefbe0001` / `0xefbe0002` / `0x01010101`).
pub const BEEF_V1_MAGIC: [u8; 4] = [0x01, 0x00, 0xbe, 0xef];
pub const BEEF_V2_MAGIC: [u8; 4] = [0x02, 0x00, 0xbe, 0xef];
pub const ATOMIC_BEEF_PREFIX: [u8; 4] = [0x01, 0x01, 0x01, 0x01];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeefTx {
    pub txid: String,
    pub tx: Option<Transaction>,
    pub bump_index: Option<usize>,
    pub is_txid_only: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beef {
    pub atomic_txid: Option<String>,
    pub bumps: Vec<Bump>,
    pub txs: HashMap<String, BeefTx>,
}

fn txid_raw(txid_hex: &str) -> Result<[u8; 32], BitcoinError> {
    let v = handcash_primitives::encoding::decode_hex(txid_hex)
        .map_err(|_| BitcoinError::InvalidHex("txid".into()))?;
    v.try_into()
        .map_err(|_| BitcoinError::InvalidHex("txid length".into()))
}

impl Beef {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BitcoinError> {
        let mut r = Reader::new(bytes);
        let mut atomic_txid = None;

        let mut magic = r.read_exact::<4>()?;
        if magic == ATOMIC_BEEF_PREFIX {
            let subj_raw = r.read_exact::<32>()?;
            atomic_txid = Some(encode_hex(&reverse_32(subj_raw)));
            magic = r.read_exact::<4>()?;
        }

        let is_v2 = match magic {
            BEEF_V1_MAGIC => false,
            BEEF_V2_MAGIC => true,
            other => {
                return Err(BitcoinError::InvalidMagic(encode_hex(&other)));
            }
        };

        let n_bumps = r.read_varint()? as usize;
        if n_bumps > 100_000 {
            return Err(BitcoinError::InvalidVarint);
        }
        let mut bumps = Vec::with_capacity(n_bumps.min(256));
        for _ in 0..n_bumps {
            bumps.push(Bump::read_from(&mut r)?);
        }

        let n_txs = r.read_varint()? as usize;
        if n_txs > 100_000 {
            return Err(BitcoinError::InvalidVarint);
        }
        let mut txs = HashMap::with_capacity(n_txs.min(256));

        for _ in 0..n_txs {
            if is_v2 {
                let format = r.read_u8()?;
                match format {
                    0 => {
                        // Raw tx without BUMP
                        let tx = Transaction::read_from(&mut r)?;
                        let txid = tx.txid_hex()?;
                        txs.insert(
                            txid.clone(),
                            BeefTx {
                                txid,
                                tx: Some(tx),
                                bump_index: None,
                                is_txid_only: false,
                            },
                        );
                    }
                    1 => {
                        // Raw tx with BUMP index
                        let bump_index = r.read_varint()? as usize;
                        if bump_index >= bumps.len() {
                            return Err(BitcoinError::InvalidBump("bump_index out of range".into()));
                        }
                        let tx = Transaction::read_from(&mut r)?;
                        let txid = tx.txid_hex()?;
                        txs.insert(
                            txid.clone(),
                            BeefTx {
                                txid,
                                tx: Some(tx),
                                bump_index: Some(bump_index),
                                is_txid_only: false,
                            },
                        );
                    }
                    2 => {
                        // TXID only (knownTxid stub)
                        let raw_id = r.read_exact::<32>()?;
                        let txid = encode_hex(&reverse_32(raw_id));
                        txs.entry(txid.clone()).or_insert(BeefTx {
                            txid,
                            tx: None,
                            bump_index: None,
                            is_txid_only: true,
                        });
                    }
                    other => {
                        return Err(BitcoinError::InvalidMagic(format!(
                            "unknown BEEF v2 tx format {other}"
                        )));
                    }
                }
            } else {
                // BEEF v1: raw tx followed by has_bump flag (0 or 1) + optional bump_index
                let tx = Transaction::read_from(&mut r)?;
                let txid = tx.txid_hex()?;
                let has_bump = r.read_u8()?;
                let bump_index = if has_bump != 0 {
                    let idx = r.read_varint()? as usize;
                    if idx >= bumps.len() {
                        return Err(BitcoinError::InvalidBump("bump_index out of range".into()));
                    }
                    Some(idx)
                } else {
                    None
                };
                txs.insert(
                    txid.clone(),
                    BeefTx {
                        txid,
                        tx: Some(tx),
                        bump_index,
                        is_txid_only: false,
                    },
                );
            }
        }

        Ok(Self {
            atomic_txid,
            bumps,
            txs,
        })
    }

    pub fn merge_raw_tx(&mut self, raw: &[u8]) -> Result<String, BitcoinError> {
        let tx = Transaction::from_bytes(raw)?;
        let txid = tx.txid_hex()?;
        self.txs
            .entry(txid.clone())
            .and_modify(|e| {
                if e.tx.is_none() {
                    e.tx = Some(tx.clone());
                    e.is_txid_only = false;
                }
            })
            .or_insert(BeefTx {
                txid: txid.clone(),
                tx: Some(tx),
                bump_index: None,
                is_txid_only: false,
            });
        Ok(txid)
    }

    pub fn merge_beef(&mut self, other: Beef) {
        let offset = self.bumps.len();
        self.bumps.extend(other.bumps);
        for (txid, mut entry) in other.txs {
            if let Some(idx) = entry.bump_index {
                entry.bump_index = Some(idx + offset);
            }
            self.txs
                .entry(txid)
                .and_modify(|existing| {
                    if existing.tx.is_none() && entry.tx.is_some() {
                        existing.tx = entry.tx.clone();
                        existing.is_txid_only = false;
                    }
                    if existing.bump_index.is_none() && entry.bump_index.is_some() {
                        existing.bump_index = entry.bump_index;
                    }
                })
                .or_insert(entry);
        }
    }

    pub fn find_tx(&self, txid: &str) -> Option<&Transaction> {
        self.txs
            .get(&txid.trim().to_ascii_lowercase())
            .and_then(|e| e.tx.as_ref())
    }

    /// Extended Format bytes for `txid`, taking each input's source output from the parent
    /// carried in this bundle. Errors when a parent is absent or txid-only (TS `toHexEF`).
    pub fn ef_bytes_for(&self, txid: &str) -> Result<Vec<u8>, BitcoinError> {
        let tx = self
            .find_tx(txid)
            .ok_or_else(|| BitcoinError::InvalidHex("transaction not found in beef".into()))?;
        let mut prevouts = Vec::with_capacity(tx.inputs.len());
        for inp in &tx.inputs {
            let parent = self.find_tx(&inp.prev_txid).ok_or_else(|| {
                BitcoinError::InvalidHex("source transaction not in beef".into())
            })?;
            let out = parent
                .outputs
                .get(inp.prev_vout as usize)
                .ok_or_else(|| BitcoinError::InvalidHex("source output out of range".into()))?;
            prevouts.push((out.satoshis, out.locking_script.as_slice()));
        }
        tx.to_ef_bytes(&prevouts)
    }

    /// BEEF v2 (BRC-96) bytes with transactions ordered parents-first.
    pub fn to_bytes(&self) -> Result<Vec<u8>, BitcoinError> {
        let mut out = Vec::new();
        out.extend_from_slice(&BEEF_V2_MAGIC);
        crate::write_varint(&mut out, self.bumps.len() as u64);
        for b in &self.bumps {
            out.extend_from_slice(&b.to_bytes());
        }
        let order = self.parents_first_order();
        crate::write_varint(&mut out, order.len() as u64);
        for txid in order {
            let e = &self.txs[txid];
            match (&e.tx, e.bump_index) {
                (Some(tx), Some(idx)) => {
                    out.push(1);
                    crate::write_varint(&mut out, idx as u64);
                    out.extend_from_slice(&tx.to_bytes()?);
                }
                (Some(tx), None) => {
                    out.push(0);
                    out.extend_from_slice(&tx.to_bytes()?);
                }
                (None, _) => {
                    out.push(2);
                    out.extend_from_slice(&reverse_32(txid_raw(txid)?));
                }
            }
        }
        Ok(out)
    }

    /// AtomicBEEF (BRC-95): `01010101` + subject txid (wire order) + BEEF v2.
    pub fn to_atomic_bytes(&self, subject_txid: &str) -> Result<Vec<u8>, BitcoinError> {
        let subject = subject_txid.trim().to_ascii_lowercase();
        if self.find_tx(&subject).is_none() {
            return Err(BitcoinError::InvalidHex("atomic subject not in beef".into()));
        }
        let mut out = Vec::new();
        out.extend_from_slice(&ATOMIC_BEEF_PREFIX);
        out.extend_from_slice(&reverse_32(txid_raw(&subject)?));
        out.extend_from_slice(&self.to_bytes()?);
        Ok(out)
    }

    /// Deterministic topological order: every in-bundle parent precedes its children.
    fn parents_first_order(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.txs.keys().map(String::as_str).collect();
        ids.sort_unstable();
        let mut done: HashSet<&str> = HashSet::new();
        let mut order = Vec::with_capacity(ids.len());
        for id in ids {
            self.visit_parents_first(id, &mut done, &mut order);
        }
        order
    }

    fn visit_parents_first<'a>(
        &'a self,
        id: &'a str,
        done: &mut HashSet<&'a str>,
        order: &mut Vec<&'a str>,
    ) {
        if !done.insert(id) {
            return;
        }
        if let Some(tx) = self.txs.get(id).and_then(|e| e.tx.as_ref()) {
            // Proven txs need no ancestry, but ordering their in-bundle parents first is harmless.
            for inp in &tx.inputs {
                if let Some((pid, _)) = self.txs.get_key_value(inp.prev_txid.as_str()) {
                    self.visit_parents_first(pid.as_str(), done, order);
                }
            }
        }
        order.push(id);
    }

    pub fn find_bump(&self, txid: &str) -> Option<&Bump> {
        let entry = self.txs.get(&txid.trim().to_ascii_lowercase())?;
        let idx = entry.bump_index?;
        self.bumps.get(idx)
    }

    /// Recursively SPV-verify `subject_txid` against PoW-verified block headers.
    /// A transaction is valid iff:
    /// - It carries a BUMP verified against a self-proving block header at `bump.block_height`, OR
    /// - Every one of its inputs has its parent transaction present in `self` and recursively valid
    ///   (and unconfirmed txs satisfy BRC-67 finality).
    pub fn verify_spv<F>(&self, subject_txid: &str, get_header: &F) -> Result<(), BitcoinError>
    where
        F: Fn(u64) -> Option<BlockHeader>,
    {
        let mut visited = HashSet::new();
        self.verify_tx_recursive(&subject_txid.trim().to_ascii_lowercase(), get_header, &mut visited)
    }

    fn verify_tx_recursive<F>(
        &self,
        txid: &str,
        get_header: &F,
        visited: &mut HashSet<String>,
    ) -> Result<(), BitcoinError>
    where
        F: Fn(u64) -> Option<BlockHeader>,
    {
        if !visited.insert(txid.to_string()) {
            return Ok(());
        }
        let entry = self
            .txs
            .get(txid)
            .ok_or_else(|| BitcoinError::SpvFailed(format!("missing tx {txid} in BEEF")))?;
        if let Some(bump_idx) = entry.bump_index {
            let bump = self
                .bumps
                .get(bump_idx)
                .ok_or_else(|| BitcoinError::InvalidBump("bump_index out of range".into()))?;
            let header = get_header(bump.block_height).ok_or_else(|| {
                BitcoinError::SpvFailed(format!("missing header for height {}", bump.block_height))
            })?;
            bump.verify_against_header(txid, &header)?;
            return Ok(());
        }
        let tx = entry
            .tx
            .as_ref()
            .ok_or_else(|| BitcoinError::SpvFailed(format!("txid-only stub {txid} has no proof")))?;
        if !tx.is_final() {
            return Err(BitcoinError::SpvFailed(format!(
                "unconfirmed tx {txid} is not final (BRC-67)"
            )));
        }
        if tx.inputs.is_empty() {
            return Err(BitcoinError::SpvFailed(format!(
                "unproven tx {txid} has no inputs"
            )));
        }
        for inp in &tx.inputs {
            self.verify_tx_recursive(&inp.prev_txid, get_header, visited)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bump::BumpLeaf;
    use crate::tx::{TxInput, TxOutput};
    use crate::write_varint;

    #[test]
    fn parses_beef_v2_and_atomic_beef_and_rejects_unproven_unfinal_tx() {
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
                locking_script: vec![0x76, 0xa9],
            }],
            lock_time: 0,
        };
        let tx_bytes = tx.to_bytes().unwrap();
        let txid_internal = tx.txid_internal_bytes().unwrap();
        let txid_hex = tx.txid_hex().unwrap();

        let bump = Bump {
            block_height: 0,
            path: vec![vec![BumpLeaf {
                offset: 0,
                hash: Some(txid_internal),
                txid: true,
                duplicate: false,
            }]],
        };
        let bump_bytes = bump.to_bytes();

        // Build AtomicBEEF(v2) manually.
        let mut raw = Vec::new();
        raw.extend_from_slice(&ATOMIC_BEEF_PREFIX);
        raw.extend_from_slice(&txid_internal);
        raw.extend_from_slice(&BEEF_V2_MAGIC);
        write_varint(&mut raw, 1); // 1 bump
        raw.extend_from_slice(&bump_bytes);
        write_varint(&mut raw, 1); // 1 tx
        raw.push(1); // format=1 (raw tx + bump index)
        write_varint(&mut raw, 0); // bump index 0
        raw.extend_from_slice(&tx_bytes);

        let parsed = Beef::from_bytes(&raw).unwrap();
        assert_eq!(parsed.atomic_txid.as_deref(), Some(txid_hex.as_str()));
        assert!(parsed.find_tx(&txid_hex).is_some());
        assert!(parsed.find_bump(&txid_hex).is_some());

        // Serializer reproduces the hand-built wire bytes exactly.
        assert_eq!(parsed.to_atomic_bytes(&txid_hex).unwrap(), raw);

        // Child spending the proven parent: parents-first order, EF, and round-trip.
        let child = Transaction {
            version: 1,
            inputs: vec![crate::tx::TxInput {
                prev_txid: txid_hex.clone(),
                prev_vout: 0,
                unlocking_script: vec![0x51],
                sequence: 0xffff_ffff,
            }],
            outputs: vec![TxOutput {
                satoshis: 1,
                locking_script: vec![0x6a],
            }],
            lock_time: 0,
        };
        let mut bundle = parsed.clone();
        let child_id = bundle.merge_raw_tx(&child.to_bytes().unwrap()).unwrap();
        let atomic = bundle.to_atomic_bytes(&child_id).unwrap();
        let back = Beef::from_bytes(&atomic).unwrap();
        assert_eq!(back.atomic_txid.as_deref(), Some(child_id.as_str()));
        assert_eq!(back.txs.len(), 2);
        assert!(back.find_bump(&txid_hex).is_some());
        let parent_pos = atomic
            .windows(tx_bytes.len())
            .position(|w| w == tx_bytes.as_slice())
            .unwrap();
        let child_pos = atomic
            .windows(child.to_bytes().unwrap().len())
            .position(|w| w == child.to_bytes().unwrap().as_slice())
            .unwrap();
        assert!(parent_pos < child_pos);
        let ef = back.ef_bytes_for(&child_id).unwrap();
        assert_eq!(&ef[4..10], &[0, 0, 0, 0, 0, 0xef]);
        assert!(bundle.to_atomic_bytes(&"00".repeat(32)).is_err());
    }
}
