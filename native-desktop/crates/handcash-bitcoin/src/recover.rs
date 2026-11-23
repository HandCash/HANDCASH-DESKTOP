// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Recover-from-transaction scan: find the 1-sat outputs of one transaction
//! that pay this wallet's address. Port of `scriptPaysAddress` in
//! `src/wallet/ordinalOwnership.ts` and the output filter of
//! `src/wallet/recoverFromTx.ts`. Read-only: no keys, no signing, no writes.

use crate::ord::has_ord_envelope;
use crate::tx::Transaction;

const OP_FALSE: u8 = 0x00;
const OP_IF: u8 = 0x63;
const OP_NOTIF: u8 = 0x64;
const OP_ENDIF: u8 = 0x68;
const OP_RETURN: u8 = 0x6a;

/// Normalise and validate a pasted txid (64 hex chars, lowercased).
pub fn parse_recover_txid(raw: &str) -> Result<String, String> {
    let txid = raw.trim().to_ascii_lowercase();
    if txid.len() == 64 && txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(txid)
    } else {
        Err("Enter a 64-character transaction id.".into())
    }
}

/// Index just past the opcode at `at`, or `None` when its push runs off the end.
fn op_end(bytes: &[u8], at: usize) -> Option<usize> {
    let op = bytes[at];
    let (head, len) = match op {
        1..=75 => (1usize, op as usize),
        0x4c => (2, *bytes.get(at + 1)? as usize),
        0x4d => {
            let lo = *bytes.get(at + 1)? as usize;
            let hi = *bytes.get(at + 2)? as usize;
            (3, lo | (hi << 8))
        }
        0x4e => {
            let b = bytes.get(at + 1..at + 5)?;
            (5, u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
        }
        _ => (1, 0),
    };
    let end = at.checked_add(head)?.checked_add(len)?;
    (end <= bytes.len()).then_some(end)
}

/// Index just past an `OP_FALSE OP_IF … OP_ENDIF` branch at `at`, or `None`.
fn skipped_branch_end(bytes: &[u8], at: usize) -> Option<usize> {
    if bytes.get(at) != Some(&OP_FALSE) || bytes.get(at + 1) != Some(&OP_IF) {
        return None;
    }
    let mut depth = 1usize;
    let mut i = at + 2;
    while i < bytes.len() {
        let op = bytes[i];
        if op == OP_IF || op == OP_NOTIF {
            depth += 1;
        } else if op == OP_ENDIF {
            depth -= 1;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i = op_end(bytes, i)?;
    }
    None
}

/// True when `script` is a key spend to `lock` (a P2PKH locking script):
/// exactly one P2PKH lock read opcode by opcode, beside only skipped
/// `OP_FALSE OP_IF … OP_ENDIF` branches (the `ord` envelope) and trailing
/// `OP_RETURN` data. The template inside push data is not ownership.
pub fn script_pays_lock(script: &[u8], lock: &[u8]) -> bool {
    if script.is_empty() || lock.is_empty() {
        return false;
    }
    let mut paid = false;
    let mut at = 0usize;
    while at < script.len() {
        if let Some(branch) = skipped_branch_end(script, at) {
            at = branch;
            continue;
        }
        if !paid && script[at..].starts_with(lock) {
            paid = true;
            at += lock.len();
            continue;
        }
        return paid && script[at] == OP_RETURN;
    }
    paid
}

/// One 1-sat output of the scanned transaction locked to this wallet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverableOutput {
    pub outpoint: String,
    pub vout: u32,
    /// Carries an `ord` inscription envelope (a candidate item or token).
    pub inscribed: bool,
}

/// Every 1-sat output of `tx` whose script pays `lock`.
pub fn find_recoverable_outputs(txid: &str, tx: &Transaction, lock: &[u8]) -> Vec<RecoverableOutput> {
    tx.outputs
        .iter()
        .enumerate()
        .filter(|(_, out)| out.satoshis == 1 && script_pays_lock(&out.locking_script, lock))
        .map(|(vout, out)| RecoverableOutput {
            outpoint: format!("{txid}.{vout}"),
            vout: vout as u32,
            inscribed: has_ord_envelope(&out.locking_script),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::p2pkh_locking_script;
    use crate::tx::TxOutput;

    fn lock() -> Vec<u8> {
        p2pkh_locking_script(&[0x11; 20])
    }

    fn envelope() -> Vec<u8> {
        // OP_FALSE OP_IF "ord" OP_1 "text/plain" OP_0 "hi" OP_ENDIF
        let mut s = vec![OP_FALSE, OP_IF, 3, b'o', b'r', b'd', 0x51, 10];
        s.extend_from_slice(b"text/plain");
        s.extend_from_slice(&[0x00, 2, b'h', b'i', OP_ENDIF]);
        s
    }

    #[test]
    fn parses_txid() {
        let id = "AB".repeat(32);
        assert_eq!(parse_recover_txid(&format!("  {id} ")).unwrap(), "ab".repeat(32));
        assert!(parse_recover_txid("abc").is_err());
        assert!(parse_recover_txid(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn plain_p2pkh_pays() {
        assert!(script_pays_lock(&lock(), &lock()));
    }

    #[test]
    fn envelope_on_either_side_pays() {
        let mut before = envelope();
        before.extend_from_slice(&lock());
        assert!(script_pays_lock(&before, &lock()));
        let mut after = lock();
        after.extend_from_slice(&envelope());
        assert!(script_pays_lock(&after, &lock()));
    }

    #[test]
    fn trailing_op_return_pays() {
        let mut s = lock();
        s.extend_from_slice(&[OP_RETURN, 2, 0xde, 0xad]);
        assert!(script_pays_lock(&s, &lock()));
    }

    #[test]
    fn template_inside_push_data_does_not_pay() {
        let l = lock();
        let mut s = vec![l.len() as u8];
        s.extend_from_slice(&l);
        assert!(!script_pays_lock(&s, &l));
    }

    #[test]
    fn other_contract_or_double_lock_does_not_pay() {
        let mut prefix = vec![0x51, 0x75]; // OP_1 OP_DROP
        prefix.extend_from_slice(&lock());
        assert!(!script_pays_lock(&prefix, &lock()));
        let mut twice = lock();
        twice.extend_from_slice(&lock());
        assert!(!script_pays_lock(&twice, &lock()));
        assert!(!script_pays_lock(&p2pkh_locking_script(&[0x22; 20]), &lock()));
    }

    #[test]
    fn unterminated_envelope_does_not_pay() {
        let mut s = envelope();
        s.pop(); // drop OP_ENDIF
        s.extend_from_slice(&lock());
        assert!(!script_pays_lock(&s, &lock()));
    }

    #[test]
    fn finds_only_one_sat_outputs_to_us() {
        let mut inscribed = envelope();
        inscribed.extend_from_slice(&lock());
        let tx = Transaction {
            version: 1,
            inputs: vec![],
            outputs: vec![
                TxOutput { satoshis: 1, locking_script: inscribed },
                TxOutput { satoshis: 500, locking_script: lock() },
                TxOutput { satoshis: 1, locking_script: p2pkh_locking_script(&[0x22; 20]) },
                TxOutput { satoshis: 1, locking_script: lock() },
            ],
            lock_time: 0,
        };
        let id = "ab".repeat(32);
        let found = find_recoverable_outputs(&id, &tx, &lock());
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].vout, 0);
        assert!(found[0].inscribed);
        assert_eq!(found[1].outpoint, format!("{id}.3"));
        assert!(!found[1].inscribed);
    }
}
