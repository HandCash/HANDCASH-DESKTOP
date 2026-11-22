// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure-Rust BSV BIP-143 sighash, P2PKH / BRC-29 locking & unlocking scripts,
//! transaction fee estimation, and low-S ECDSA transaction signing.

use crate::tx::{Transaction, TxInput, TxOutput};
use crate::{reverse_32, write_varint, BitcoinError};
use handcash_primitives::encoding::{decode_hex, double_sha256};
use handcash_primitives::keys::{
    decode_p2pkh_address, hash160, sign_ecdsa_der, verify_ecdsa_der, SecretKeyBytes,
};

pub const SIGHASH_ALL: u32 = 0x01;
pub const SIGHASH_NONE: u32 = 0x02;
pub const SIGHASH_SINGLE: u32 = 0x03;
pub const SIGHASH_FORKID: u32 = 0x40;
pub const SIGHASH_ANYONECANPAY: u32 = 0x80;
pub const SIGHASH_ALL_FORKID: u32 = SIGHASH_ALL | SIGHASH_FORKID; // 0x41

/// Build a canonical P2PKH locking script (`OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG`).
pub fn p2pkh_locking_script(pubkey_hash: &[u8; 20]) -> Vec<u8> {
    let mut script = Vec::with_capacity(25);
    script.push(0x76); // OP_DUP
    script.push(0xa9); // OP_HASH160
    script.push(0x14); // push 20 bytes
    script.extend_from_slice(pubkey_hash);
    script.push(0x88); // OP_EQUALVERIFY
    script.push(0xac); // OP_CHECKSIG
    script
}

/// Build a P2PKH locking script directly from a 33-byte compressed public key.
pub fn p2pkh_locking_script_from_pubkey(pubkey: &[u8]) -> Vec<u8> {
    p2pkh_locking_script(&hash160(pubkey))
}

/// Decode a Base58Check Bitcoin address into its P2PKH locking script.
pub fn address_to_locking_script(address: &str) -> Result<Vec<u8>, BitcoinError> {
    let (_, h160) = decode_p2pkh_address(address)
        .map_err(|e| BitcoinError::InvalidHex(e.to_string()))?;
    Ok(p2pkh_locking_script(&h160))
}

/// Push data using canonical Bitcoin script minimal push opcodes.
pub fn push_script_data(out: &mut Vec<u8>, data: &[u8]) {
    let len = data.len();
    if len <= 75 {
        out.push(len as u8);
    } else if len <= 0xff {
        out.push(0x4c);
        out.push(len as u8);
    } else if len <= 0xffff {
        out.push(0x4d);
        out.extend_from_slice(&(len as u16).to_le_bytes());
    } else {
        out.push(0x4e);
        out.extend_from_slice(&(len as u32).to_le_bytes());
    }
    out.extend_from_slice(data);
}

/// Build the BIP-143 signature preimage (BSV `SIGHASH_FORKID`) for `input_index`.
pub fn bip143_preimage(
    tx: &Transaction,
    input_index: usize,
    prev_locking_script: &[u8],
    prev_satoshis: u64,
    sighash_type: u32,
) -> Result<Vec<u8>, BitcoinError> {
    let input = tx
        .inputs
        .get(input_index)
        .ok_or(BitcoinError::UnexpectedEof)?;
    let base_scope = sighash_type & 0x1f;
    let anyone_can_pay = (sighash_type & SIGHASH_ANYONECANPAY) != 0;

    let hash_prevouts = if anyone_can_pay {
        [0u8; 32]
    } else {
        let mut buf = Vec::with_capacity(tx.inputs.len() * 36);
        for inp in &tx.inputs {
            let raw = decode_hex(&inp.prev_txid)
                .map_err(|e| BitcoinError::InvalidHex(e.to_string()))?;
            if raw.len() != 32 {
                return Err(BitcoinError::InvalidHex("prev_txid must be 32 bytes".into()));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&raw);
            buf.extend_from_slice(&reverse_32(arr));
            buf.extend_from_slice(&inp.prev_vout.to_le_bytes());
        }
        double_sha256(&buf)
    };

    let hash_sequence = if anyone_can_pay
        || base_scope == SIGHASH_SINGLE
        || base_scope == SIGHASH_NONE
    {
        [0u8; 32]
    } else {
        let mut buf = Vec::with_capacity(tx.inputs.len() * 4);
        for inp in &tx.inputs {
            buf.extend_from_slice(&inp.sequence.to_le_bytes());
        }
        double_sha256(&buf)
    };

    let hash_outputs = if base_scope != SIGHASH_SINGLE && base_scope != SIGHASH_NONE {
        let mut buf = Vec::new();
        for o in &tx.outputs {
            buf.extend_from_slice(&o.satoshis.to_le_bytes());
            write_varint(&mut buf, o.locking_script.len() as u64);
            buf.extend_from_slice(&o.locking_script);
        }
        double_sha256(&buf)
    } else if base_scope == SIGHASH_SINGLE && input_index < tx.outputs.len() {
        let o = &tx.outputs[input_index];
        let mut buf = Vec::new();
        buf.extend_from_slice(&o.satoshis.to_le_bytes());
        write_varint(&mut buf, o.locking_script.len() as u64);
        buf.extend_from_slice(&o.locking_script);
        double_sha256(&buf)
    } else {
        [0u8; 32]
    };

    let raw_prev = decode_hex(&input.prev_txid)
        .map_err(|e| BitcoinError::InvalidHex(e.to_string()))?;
    if raw_prev.len() != 32 {
        return Err(BitcoinError::InvalidHex("prev_txid must be 32 bytes".into()));
    }
    let mut prev_arr = [0u8; 32];
    prev_arr.copy_from_slice(&raw_prev);

    let mut preimage = Vec::with_capacity(156 + prev_locking_script.len());
    preimage.extend_from_slice(&tx.version.to_le_bytes());
    preimage.extend_from_slice(&hash_prevouts);
    preimage.extend_from_slice(&hash_sequence);
    preimage.extend_from_slice(&reverse_32(prev_arr));
    preimage.extend_from_slice(&input.prev_vout.to_le_bytes());
    write_varint(&mut preimage, prev_locking_script.len() as u64);
    preimage.extend_from_slice(prev_locking_script);
    preimage.extend_from_slice(&prev_satoshis.to_le_bytes());
    preimage.extend_from_slice(&input.sequence.to_le_bytes());
    preimage.extend_from_slice(&hash_outputs);
    preimage.extend_from_slice(&tx.lock_time.to_le_bytes());
    preimage.extend_from_slice(&sighash_type.to_le_bytes());
    Ok(preimage)
}

/// Compute the 32-byte BIP-143 sighash (`double_sha256(preimage)`).
pub fn bip143_sighash(
    tx: &Transaction,
    input_index: usize,
    prev_locking_script: &[u8],
    prev_satoshis: u64,
    sighash_type: u32,
) -> Result<[u8; 32], BitcoinError> {
    let pre = bip143_preimage(tx, input_index, prev_locking_script, prev_satoshis, sighash_type)?;
    Ok(double_sha256(&pre))
}

/// Sign a single P2PKH input with low-S DER ECDSA + `sighash_type` byte + compressed pubkey.
pub fn sign_p2pkh_input(
    tx: &mut Transaction,
    input_index: usize,
    privkey: &SecretKeyBytes,
    prev_locking_script: &[u8],
    prev_satoshis: u64,
    sighash_type: u32,
) -> Result<(), BitcoinError> {
    let digest = bip143_sighash(tx, input_index, prev_locking_script, prev_satoshis, sighash_type)?;
    let mut sig = sign_ecdsa_der(privkey, &digest)
        .map_err(|e| BitcoinError::SpvFailed(e.to_string()))?;
    sig.push((sighash_type & 0xff) as u8);
    let pubkey = privkey
        .public_key_compressed()
        .map_err(|e| BitcoinError::SpvFailed(e.to_string()))?;
    let mut unlocking = Vec::with_capacity(sig.len() + pubkey.len() + 4);
    push_script_data(&mut unlocking, &sig);
    push_script_data(&mut unlocking, &pubkey);
    tx.inputs[input_index].unlocking_script = unlocking;
    Ok(())
}

/// Verify a P2PKH input's unlocking signature against `prev_locking_script` and `prev_satoshis`.
pub fn verify_p2pkh_input(
    tx: &Transaction,
    input_index: usize,
    prev_locking_script: &[u8],
    prev_satoshis: u64,
) -> Result<bool, BitcoinError> {
    let unlocking = &tx
        .inputs
        .get(input_index)
        .ok_or(BitcoinError::UnexpectedEof)?
        .unlocking_script;
    if unlocking.len() < 40 {
        return Ok(false);
    }
    let sig_len = unlocking[0] as usize;
    if unlocking.len() < 1 + sig_len + 1 {
        return Ok(false);
    }
    let sig_full = &unlocking[1..1 + sig_len];
    if sig_full.len() < 8 {
        return Ok(false);
    }
    let sighash_type = sig_full[sig_full.len() - 1] as u32;
    let der = &sig_full[..sig_full.len() - 1];
    let pk_len = unlocking[1 + sig_len] as usize;
    if unlocking.len() != 1 + sig_len + 1 + pk_len {
        return Ok(false);
    }
    let pk = &unlocking[2 + sig_len..];
    let digest = bip143_sighash(tx, input_index, prev_locking_script, prev_satoshis, sighash_type)?;
    verify_ecdsa_der(pk, &digest, der).map_err(|e| BitcoinError::SpvFailed(e.to_string()))
}

/// Input specification for building & signing a P2PKH / BRC-29 BSV transaction.
pub struct SigningInputSpec {
    pub prev_txid: String,
    pub prev_vout: u32,
    pub satoshis: u64,
    pub locking_script: Vec<u8>,
    pub privkey: SecretKeyBytes,
}

/// Estimate fee at `sat_per_kb` (default BSV fee rate: 100 sat/kB = 0.1 sat/byte, minimum 1 sat).
pub fn estimate_p2pkh_fee(num_inputs: usize, outputs: &[TxOutput], sat_per_kb: u64) -> u64 {
    let mut bytes = 10usize + num_inputs * 148;
    for o in outputs {
        bytes += 9 + o.locking_script.len();
    }
    let fee = ((bytes as u64).saturating_mul(sat_per_kb)).div_ceil(1000);
    fee.max(1)
}

/// Build and sign a complete BSV transaction with optional change output.
pub fn build_and_sign_p2pkh_tx(
    inputs: &[SigningInputSpec],
    mut outputs: Vec<TxOutput>,
    change_locking_script: Option<Vec<u8>>,
    sat_per_kb: u64,
) -> Result<(Transaction, u64, Option<u64>), BitcoinError> {
    if inputs.is_empty() {
        return Err(BitcoinError::InvalidHex("transaction requires at least one input".into()));
    }
    let total_in: u64 = inputs.iter().map(|i| i.satoshis).sum();
    let total_out: u64 = outputs.iter().map(|o| o.satoshis).sum();

    let fee_no_change = estimate_p2pkh_fee(inputs.len(), &outputs, sat_per_kb);
    if total_in < total_out.saturating_add(fee_no_change) {
        return Err(BitcoinError::SpvFailed(format!(
            "insufficient funds: have {total_in} sats, need {} sats",
            total_out.saturating_add(fee_no_change)
        )));
    }

    let mut change_sats = None;
    let fee;
    if let Some(change_script) = change_locking_script {
        let mut with_change = outputs.clone();
        with_change.push(TxOutput {
            satoshis: 0,
            locking_script: change_script.clone(),
        });
        let fee_with_change = estimate_p2pkh_fee(inputs.len(), &with_change, sat_per_kb);
        let remainder = total_in.saturating_sub(total_out.saturating_add(fee_with_change));
        if remainder >= 1 {
            outputs.push(TxOutput {
                satoshis: remainder,
                locking_script: change_script,
            });
            change_sats = Some(remainder);
            fee = fee_with_change;
        } else {
            fee = total_in.saturating_sub(total_out);
        }
    } else {
        fee = total_in.saturating_sub(total_out);
    }

    let mut tx = Transaction {
        version: 1,
        inputs: inputs
            .iter()
            .map(|i| TxInput {
                prev_txid: i.prev_txid.clone(),
                prev_vout: i.prev_vout,
                unlocking_script: Vec::new(),
                sequence: 0xffff_ffff,
            })
            .collect(),
        outputs,
        lock_time: 0,
    };

    for (idx, spec) in inputs.iter().enumerate() {
        sign_p2pkh_input(
            &mut tx,
            idx,
            &spec.privkey,
            &spec.locking_script,
            spec.satoshis,
            SIGHASH_ALL_FORKID,
        )?;
    }

    Ok((tx, fee, change_sats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use handcash_primitives::encoding::encode_hex;

    #[test]
    fn bip143_sighash_and_p2pkh_signing_match_bsv_sdk_golden_vector() {
        let root = SecretKeyBytes::from_hex(&"11".repeat(32)).unwrap();
        let peer = SecretKeyBytes::from_hex(&"22".repeat(32)).unwrap();

        let prev_script = address_to_locking_script(&root.p2pkh_address(false).unwrap()).unwrap();
        let out_script = address_to_locking_script(&peer.p2pkh_address(false).unwrap()).unwrap();
        assert_eq!(
            encode_hex(&prev_script),
            "76a914fc7250a211deddc70ee5a2738de5f07817351cef88ac"
        );
        assert_eq!(
            encode_hex(&out_script),
            "76a914531260aa2a199e228c537dfa42c82bea2c7c1f4d88ac"
        );

        let mut tx = Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev_txid: "aa".repeat(32),
                prev_vout: 1,
                unlocking_script: vec![],
                sequence: 0xffff_ffff,
            }],
            outputs: vec![TxOutput {
                satoshis: 49_500,
                locking_script: out_script,
            }],
            lock_time: 0,
        };

        let sighash =
            bip143_sighash(&tx, 0, &prev_script, 50_000, SIGHASH_ALL_FORKID).unwrap();
        assert_eq!(
            encode_hex(&sighash),
            "ad79aea002e472193e819f305073812e5b1174aa5345f19bdb1b2dd8e8b78e7d"
        );

        sign_p2pkh_input(&mut tx, 0, &root, &prev_script, 50_000, SIGHASH_ALL_FORKID).unwrap();
        assert!(verify_p2pkh_input(&tx, 0, &prev_script, 50_000).unwrap());

        // End-to-end builder + change output verification
        let (built, fee, change) = build_and_sign_p2pkh_tx(
            &[SigningInputSpec {
                prev_txid: "bb".repeat(32),
                prev_vout: 0,
                satoshis: 10_000,
                locking_script: prev_script.clone(),
                privkey: root,
            }],
            vec![TxOutput {
                satoshis: 4_000,
                locking_script: address_to_locking_script(&peer.p2pkh_address(false).unwrap())
                    .unwrap(),
            }],
            Some(prev_script.clone()),
            100,
        )
        .unwrap();
        assert!(fee > 0 && fee < 100);
        assert_eq!(change, Some(10_000 - 4_000 - fee));
        assert_eq!(built.outputs.len(), 2);
        assert!(verify_p2pkh_input(&built, 0, &prev_script, 10_000).unwrap());
    }
}
