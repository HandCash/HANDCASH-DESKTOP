// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! BRC-150 1Sat provenance lineage verifier.
//!
//! Enforces strict FIFO one-sat continuity at every hop from tip back to origin:
//!   `sum(input sats before vin) == sum(output sats before vout)` AND `input[vin].sats == 1`.
//! Missing any hop, any preceding input's source tx, or the origin `ord` envelope
//! fails closed as `Unproven` (never promotes indexer data to proven).

use crate::beef::Beef;
use crate::ord::{parse_ord_envelope, OrdEnvelope};
use crate::tx::Transaction;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const DEFAULT_MAX_HOPS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Brc150Verdict {
    Proven {
        origin_outpoint: String,
        tip_outpoint: String,
        path: Vec<String>,
        content_type: String,
        name: Option<String>,
        issuer: Option<String>,
        #[serde(skip_serializing)]
        body_bytes: Vec<u8>,
    },
    Unproven {
        reason: String,
        missing_txid: Option<String>,
    },
}

pub fn parse_outpoint(outpoint: &str) -> Option<(String, u32)> {
    let trimmed = outpoint.trim().to_ascii_lowercase();
    let sep = trimmed.find('.').or_else(|| trimmed.find('_'))?;
    let (txid, rest) = trimmed.split_at(sep);
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let vout: u32 = rest[1..].parse().ok()?;
    Some((txid.to_string(), vout))
}

/// Resolve the satoshis locked by `tx.inputs[vin]` from its parent output in `beef`.
/// Returns `Err(missing_prev_txid)` if the parent tx is missing (fail closed).
pub fn input_satoshis(beef: &Beef, tx: &Transaction, vin: usize) -> Result<u64, String> {
    let inp = tx
        .inputs
        .get(vin)
        .ok_or_else(|| "vin out of range".to_string())?;
    let parent = beef
        .find_tx(&inp.prev_txid)
        .ok_or_else(|| inp.prev_txid.clone())?;
    let out = parent
        .outputs
        .get(inp.prev_vout as usize)
        .ok_or_else(|| format!("vout {} missing in {}", inp.prev_vout, inp.prev_txid))?;
    Ok(out.satoshis)
}

/// Exact 1Sat FIFO continuity: find the unique `vin` whose single satoshi lands on `vout`.
/// Fails closed if `outputs[vout].satoshis != 1` or any preceding input source tx is missing.
pub fn find_ordinal_parent_vin(
    beef: &Beef,
    tx: &Transaction,
    vout: u32,
) -> Result<Option<usize>, String> {
    let out = match tx.outputs.get(vout as usize) {
        Some(o) if o.satoshis == 1 => o,
        _ => return Ok(None),
    };
    let _ = out;
    let mut preceding_out: u64 = 0;
    for prev_out in tx.outputs.iter().take(vout as usize) {
        preceding_out = preceding_out.saturating_add(prev_out.satoshis);
    }

    let mut preceding_in: u64 = 0;
    for vin in 0..tx.inputs.len() {
        let in_sats = input_satoshis(beef, tx, vin)?;
        if in_sats == 1 && preceding_in == preceding_out {
            return Ok(Some(vin));
        }
        preceding_in = preceding_in.saturating_add(in_sats);
    }
    Ok(None)
}

/// Verify complete BRC-150 tip -> origin lineage strictly from `beef`.
pub fn verify_lineage(
    tip_outpoint: &str,
    expected_origin: Option<&str>,
    beef: &Beef,
    max_hops: usize,
) -> Brc150Verdict {
    let Some((mut cur_txid, mut cur_vout)) = parse_outpoint(tip_outpoint) else {
        return Brc150Verdict::Unproven {
            reason: "invalid tip outpoint".into(),
            missing_txid: None,
        };
    };
    let normalized_tip = format!("{cur_txid}.{cur_vout}");
    let normalized_expected = expected_origin
        .and_then(parse_outpoint)
        .map(|(t, v)| format!("{t}.{v}"));

    let cap = max_hops.clamp(1, 512);
    let mut path = Vec::new();
    let mut seen = HashSet::new();

    for _hop in 0..cap {
        let cur_op = format!("{cur_txid}.{cur_vout}");
        if !seen.insert(cur_op.clone()) {
            return Brc150Verdict::Unproven {
                reason: "cycle detected in ordinal lineage".into(),
                missing_txid: None,
            };
        }
        path.push(cur_op.clone());

        let Some(tx) = beef.find_tx(&cur_txid) else {
            return Brc150Verdict::Unproven {
                reason: format!("missing tx {cur_txid}"),
                missing_txid: Some(cur_txid),
            };
        };
        let Some(output) = tx.outputs.get(cur_vout as usize) else {
            return Brc150Verdict::Unproven {
                reason: format!("vout {cur_vout} missing in {cur_txid}"),
                missing_txid: None,
            };
        };
        if output.satoshis != 1 {
            return Brc150Verdict::Unproven {
                reason: format!("output {cur_op} is {} sat(s), not 1 sat", output.satoshis),
                missing_txid: None,
            };
        }

        // Check if this output carries the origin `ord` inscription envelope.
        if let Some(env) = parse_ord_envelope(&output.locking_script) {
            if let Some(ref exp) = normalized_expected {
                if exp != &cur_op {
                    return Brc150Verdict::Unproven {
                        reason: format!("found origin {cur_op}, expected {exp}"),
                        missing_txid: None,
                    };
                }
            }
            return build_proven(cur_op, normalized_tip, path, env);
        }

        // Otherwise walk one hop backward using strict FIFO one-sat continuity.
        match find_ordinal_parent_vin(beef, tx, cur_vout) {
            Ok(Some(parent_vin)) => {
                let inp = &tx.inputs[parent_vin];
                cur_txid = inp.prev_txid.clone();
                cur_vout = inp.prev_vout;
            }
            Ok(None) => {
                return Brc150Verdict::Unproven {
                    reason: format!("no 1-sat FIFO parent input for {cur_op}"),
                    missing_txid: None,
                };
            }
            Err(missing_txid) => {
                let is_hex_txid = missing_txid.len() == 64
                    && missing_txid.bytes().all(|b| b.is_ascii_hexdigit());
                return Brc150Verdict::Unproven {
                    reason: format!("missing parent input tx for {cur_op}: {missing_txid}"),
                    missing_txid: is_hex_txid.then_some(missing_txid),
                };
            }
        }
    }

    Brc150Verdict::Unproven {
        reason: format!("lineage exceeded {cap} hops without reaching ord origin"),
        missing_txid: None,
    }
}

fn build_proven(
    origin_outpoint: String,
    tip_outpoint: String,
    path: Vec<String>,
    env: OrdEnvelope,
) -> Brc150Verdict {
    let name = env.map_fields.get("name").cloned();
    let issuer = env.map_fields.get("issuer").cloned();
    Brc150Verdict::Proven {
        origin_outpoint,
        tip_outpoint,
        path,
        content_type: env.content_type,
        name,
        issuer,
        body_bytes: env.body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tx::{TxInput, TxOutput};

    fn make_ord_script() -> Vec<u8> {
        let mut s = vec![0x00, 0x63, 3];
        s.extend_from_slice(b"ord");
        s.push(0x51);
        s.push(10);
        s.extend_from_slice(b"text/plain");
        s.push(0x00);
        s.push(5);
        s.extend_from_slice(b"hello");
        s.push(0x68);
        s
    }

    #[test]
    fn proves_multi_hop_1sat_lineage_and_fails_closed_when_parent_missing() {
        // Mint tx: output 0 is 1-sat inscription.
        let mint = Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev_txid: "01".repeat(32),
                prev_vout: 0,
                unlocking_script: vec![],
                sequence: u32::MAX,
            }],
            outputs: vec![TxOutput {
                satoshis: 1,
                locking_script: make_ord_script(),
            }],
            lock_time: 0,
        };
        let mint_txid = mint.txid_hex().unwrap();

        // Transfer tx: input 0 spends mint.0 (1 sat), input 1 is funding (500 sats);
        // output 0 is transferred tip (1 sat), output 1 is change (400 sats).
        let transfer = Transaction {
            version: 1,
            inputs: vec![
                TxInput {
                    prev_txid: mint_txid.clone(),
                    prev_vout: 0,
                    unlocking_script: vec![],
                    sequence: u32::MAX,
                },
                TxInput {
                    prev_txid: "02".repeat(32),
                    prev_vout: 0,
                    unlocking_script: vec![],
                    sequence: u32::MAX,
                },
            ],
            outputs: vec![
                TxOutput {
                    satoshis: 1,
                    locking_script: vec![0x76, 0xa9],
                },
                TxOutput {
                    satoshis: 400,
                    locking_script: vec![0x76, 0xa9],
                },
            ],
            lock_time: 0,
        };
        let transfer_txid = transfer.txid_hex().unwrap();

        let mut beef = Beef::default();
        beef.merge_raw_tx(&mint.to_bytes().unwrap()).unwrap();
        beef.merge_raw_tx(&transfer.to_bytes().unwrap()).unwrap();

        let tip_op = format!("{transfer_txid}.0");
        let origin_op = format!("{mint_txid}.0");

        let verdict = verify_lineage(&tip_op, Some(&origin_op), &beef, DEFAULT_MAX_HOPS);
        match verdict {
            Brc150Verdict::Proven {
                origin_outpoint,
                path,
                content_type,
                body_bytes,
                ..
            } => {
                assert_eq!(origin_outpoint, origin_op);
                assert_eq!(path, vec![tip_op.clone(), origin_op.clone()]);
                assert_eq!(content_type, "text/plain");
                assert_eq!(body_bytes, b"hello");
            }
            other => panic!("expected Proven, got {other:?}"),
        }

        // Missing mint tx must fail closed as Unproven naming the missing txid.
        let mut incomplete = Beef::default();
        incomplete
            .merge_raw_tx(&transfer.to_bytes().unwrap())
            .unwrap();
        let bad = verify_lineage(&tip_op, Some(&origin_op), &incomplete, DEFAULT_MAX_HOPS);
        assert!(matches!(
            bad,
            Brc150Verdict::Unproven { missing_txid: Some(id), .. } if id == mint_txid
        ));
    }
}
