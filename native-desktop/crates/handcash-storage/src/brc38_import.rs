// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Non-destructive BRC-38 JSON -> SQLite WAL bootstrap importer.
//!
//! Splits legacy fat BRC-38 rows (`outputs`, `transactions`, `provenTxs`, `provenTxReqs`)
//! into hot indexed SQLite metadata tables + deduplicated SHA-256 cold blobs.

use crate::store::{AccountStore, StorageError, UtxoState};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use handcash_primitives::encoding::{encode_hex, sha256};
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Brc38ImportStats {
    pub transactions: usize,
    pub utxos: usize,
    pub items: usize,
    pub blobs_written: usize,
    pub skipped_retired_proof_reqs: usize,
}

fn decode_b64(val: Option<&Value>) -> Option<Vec<u8>> {
    let s = val?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    BASE64.decode(s).ok()
}

fn parse_ts_ms(val: Option<&Value>, fallback: i64) -> i64 {
    let Some(v) = val else {
        return fallback;
    };
    if let Some(n) = v.as_i64() {
        return n;
    }
    if let Some(s) = v.as_str() {
        // Lightweight ISO-8601 prefix parse fallback to monotonic hash/fallback if non-numeric.
        if let Ok(n) = s.parse::<i64>() {
            return n;
        }
    }
    fallback
}

struct ProvenMeta {
    height: Option<i64>,
    merkle_root: Option<String>,
    raw_hash: Option<String>,
    bump_hash: Option<String>,
}

/// Import a BRC-38 JSON document into SQLite WAL tables + deduplicated cold blobs.
/// Never overwrites `spent` UTXOs or downgrades `proven_brc150` items.
pub fn import_brc38_json(
    store: &AccountStore,
    json: &str,
    now_ms: i64,
) -> Result<Brc38ImportStats, StorageError> {
    let root: Value = serde_json::from_str(json)
        .map_err(|e| StorageError::InvalidInput(format!("invalid BRC-38 JSON: {e}")))?;
    let Some(tables) = root.get("tables").and_then(|t| t.as_object()) else {
        return Err(StorageError::InvalidInput(
            "BRC-38 document missing tables object".into(),
        ));
    };

    let mut stats = Brc38ImportStats::default();

    store.with_writer(|conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // 1. Basket ID -> Basket Name map.
        let mut baskets: HashMap<i64, String> = HashMap::new();
        if let Some(rows) = tables.get("outputBaskets").and_then(|v| v.as_array()) {
            for row in rows {
                if let (Some(id), Some(name)) = (
                    row.get("basketId").and_then(|v| v.as_i64()),
                    row.get("name").and_then(|v| v.as_str()),
                ) {
                    baskets.insert(id, name.to_string());
                }
            }
        }

        // 2. ProvenTxs: store rawTx & merklePath once in cold blobs, indexed by provenTxId.
        let mut proven_by_id: HashMap<i64, ProvenMeta> = HashMap::new();
        if let Some(rows) = tables.get("provenTxs").and_then(|v| v.as_array()) {
            for row in rows {
                let Some(pid) = row.get("provenTxId").and_then(|v| v.as_i64()) else {
                    continue;
                };
                if row.get("txid").and_then(|v| v.as_str()).is_none() {
                    continue;
                }
                let height = row.get("height").and_then(|v| v.as_i64());
                let merkle_root = row
                    .get("merkleRoot")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let raw_hash = decode_b64(row.get("rawTx")).map(|b| {
                    let h = encode_hex(&sha256(&b));
                    let inserted = tx
                        .execute(
                            "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                             VALUES (?1, 'raw_tx', ?2, ?3, ?4)",
                            params![h, b.len() as i64, b, now_ms],
                        )
                        .unwrap_or(0);
                    if inserted > 0 {
                        stats.blobs_written += 1;
                    }
                    h
                });
                let bump_hash = decode_b64(row.get("merklePath")).map(|b| {
                    let h = encode_hex(&sha256(&b));
                    let inserted = tx
                        .execute(
                            "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                             VALUES (?1, 'bump', ?2, ?3, ?4)",
                            params![h, b.len() as i64, b, now_ms],
                        )
                        .unwrap_or(0);
                    if inserted > 0 {
                        stats.blobs_written += 1;
                    }
                    h
                });
                proven_by_id.insert(
                    pid,
                    ProvenMeta {
                        height,
                        merkle_root,
                        raw_hash,
                        bump_hash,
                    },
                );
            }
        }

        // 3. Transactions table + transactionId -> txid map.
        let mut txid_by_row_id: HashMap<i64, String> = HashMap::new();
        let mut tx_status_by_row_id: HashMap<i64, String> = HashMap::new();
        if let Some(rows) = tables.get("transactions").and_then(|v| v.as_array()) {
            for (idx, row) in rows.iter().enumerate() {
                let row_id = row.get("transactionId").and_then(|v| v.as_i64()).unwrap_or(0);
                let Some(txid_raw) = row.get("txid").and_then(|v| v.as_str()) else {
                    continue;
                };
                let txid = txid_raw.trim().to_ascii_lowercase();
                if txid.is_empty() {
                    continue;
                }
                if row_id > 0 {
                    txid_by_row_id.insert(row_id, txid.clone());
                }
                let raw_status = row
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unproven");
                let proven_id = row.get("provenTxId").and_then(|v| v.as_i64());
                let proven = proven_id.and_then(|id| proven_by_id.get(&id));
                let status = if proven.is_some() || raw_status == "completed" {
                    "mined"
                } else if raw_status == "failed" {
                    "abandoned"
                } else {
                    "signed"
                };
                if row_id > 0 {
                    tx_status_by_row_id.insert(row_id, status.to_string());
                }

                let is_outgoing = row.get("isOutgoing").and_then(|v| v.as_bool()).unwrap_or(false);
                let satoshis = row.get("satoshis").and_then(|v| v.as_i64()).unwrap_or(0);
                let description = row
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let ts = parse_ts_ms(row.get("created_at"), now_ms - (rows.len() - idx) as i64);

                let raw_hash = proven
                    .and_then(|p| p.raw_hash.clone())
                    .or_else(|| {
                        decode_b64(row.get("rawTx")).map(|b| {
                            let h = encode_hex(&sha256(&b));
                            if tx
                                .execute(
                                    "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                                     VALUES (?1, 'raw_tx', ?2, ?3, ?4)",
                                    params![h, b.len() as i64, b, now_ms],
                                )
                                .unwrap_or(0)
                                > 0
                            {
                                stats.blobs_written += 1;
                            }
                            h
                        })
                    });
                let beef_hash = decode_b64(row.get("inputBEEF")).map(|b| {
                    let h = encode_hex(&sha256(&b));
                    if tx
                        .execute(
                            "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                             VALUES (?1, 'beef', ?2, ?3, ?4)",
                            params![h, b.len() as i64, b, now_ms],
                        )
                        .unwrap_or(0)
                        > 0
                    {
                        stats.blobs_written += 1;
                    }
                    h
                });
                let bump_hash = proven.and_then(|p| p.bump_hash.clone());
                let height = proven.and_then(|p| p.height);
                let merkle_root = proven.and_then(|p| p.merkle_root.clone());

                tx.execute(
                    "INSERT INTO transactions (
                        txid, status, is_outgoing, satoshis, fee_sats, description,
                        block_height, merkle_root, raw_blob_hash, beef_blob_hash, bump_blob_hash,
                        created_at_ms, updated_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                     ON CONFLICT(txid) DO UPDATE SET
                        status = CASE WHEN transactions.status = 'mined' THEN 'mined' ELSE excluded.status END,
                        block_height = COALESCE(transactions.block_height, excluded.block_height),
                        merkle_root = COALESCE(transactions.merkle_root, excluded.merkle_root),
                        raw_blob_hash = COALESCE(transactions.raw_blob_hash, excluded.raw_blob_hash),
                        beef_blob_hash = COALESCE(transactions.beef_blob_hash, excluded.beef_blob_hash),
                        bump_blob_hash = COALESCE(transactions.bump_blob_hash, excluded.bump_blob_hash),
                        updated_at_ms = excluded.updated_at_ms",
                    params![
                        txid,
                        status,
                        if is_outgoing { 1 } else { 0 },
                        satoshis,
                        description,
                        height,
                        merkle_root,
                        raw_hash,
                        beef_hash,
                        bump_hash,
                        ts,
                        now_ms,
                    ],
                )?;

                let act_id = format!("tx:{txid}");
                let dir = if is_outgoing { "out" } else { "in" };
                tx.execute(
                    "INSERT OR REPLACE INTO activity_view (
                        activity_id, txid, kind, direction, satoshis, status,
                        title, counterparty, app_origin, sort_ts_ms
                     ) VALUES (?1, ?2, 'tx', ?3, ?4, ?5, ?6, NULL, NULL, ?7)",
                    params![act_id, txid, dir, satoshis, status, description, ts],
                )?;
                stats.transactions += 1;
            }
        }

        // 4. Proof requests: skip retired completed+proven ones immediately (stops 36MB bloat).
        if let Some(rows) = tables.get("provenTxReqs").and_then(|v| v.as_array()) {
            for row in rows {
                let status = row.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let notified = row.get("notified").and_then(|v| v.as_bool()).unwrap_or(false)
                    || row.get("notified").and_then(|v| v.as_i64()) == Some(1);
                let proven_id = row.get("provenTxId").and_then(|v| v.as_i64());
                if status == "completed" && notified && proven_id.is_some_and(|id| proven_by_id.contains_key(&id)) {
                    stats.skipped_retired_proof_reqs += 1;
                    continue;
                }
                if let Some(txid) = row.get("txid").and_then(|v| v.as_str()) {
                    let txid_lc = txid.trim().to_ascii_lowercase();
                    tx.execute(
                        "INSERT OR IGNORE INTO proof_requests (txid, state, attempts, next_retry_at_ms, notified, updated_at_ms)
                         VALUES (?1, ?2, 0, ?3, ?4, ?3)",
                        params![txid_lc, if status == "completed" { "completed" } else { "pending" }, now_ms, if notified { 1 } else { 0 }],
                    )?;
                }
            }
        }

        // 5. Outputs -> hot `utxos` + `items` (for 1sat / bntft / bntnft) + cold `blobs` for scripts.
        if let Some(rows) = tables.get("outputs").and_then(|v| v.as_array()) {
            for (idx, row) in rows.iter().enumerate() {
                let tx_row_id = row.get("transactionId").and_then(|v| v.as_i64()).unwrap_or(0);
                let txid = row
                    .get("txid")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_ascii_lowercase())
                    .or_else(|| txid_by_row_id.get(&tx_row_id).cloned());
                let Some(txid) = txid else {
                    continue;
                };
                let vout = row.get("vout").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let outpoint = format!("{txid}.{vout}");
                let satoshis = row.get("satoshis").and_then(|v| v.as_i64()).unwrap_or(0).max(0);
                let basket = row
                    .get("basketId")
                    .and_then(|v| v.as_i64())
                    .and_then(|id| baskets.get(&id).cloned())
                    .unwrap_or_else(|| "default".into());
                let spendable = row.get("spendable").and_then(|v| v.as_bool()).unwrap_or(false)
                    || row.get("spendable").and_then(|v| v.as_i64()) == Some(1);
                let is_change = row.get("change").and_then(|v| v.as_bool()).unwrap_or(false)
                    || row.get("change").and_then(|v| v.as_i64()) == Some(1);
                let spent_by_row = row.get("spentBy").and_then(|v| v.as_i64());
                let spent_by_txid = spent_by_row.and_then(|id| txid_by_row_id.get(&id).cloned());
                let creator_status = tx_status_by_row_id
                    .get(&tx_row_id)
                    .map(String::as_str)
                    .unwrap_or("mined");

                let state = if spent_by_row.is_some() {
                    UtxoState::Spent
                } else if spendable {
                    UtxoState::Spendable
                } else if is_change && creator_status == "signed" {
                    UtxoState::UnconfirmedChange
                } else {
                    UtxoState::Spent
                };

                let script_hash = decode_b64(row.get("lockingScript")).map(|b| {
                    let h = encode_hex(&sha256(&b));
                    if tx
                        .execute(
                            "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                             VALUES (?1, 'script', ?2, ?3, ?4)",
                            params![h, b.len() as i64, b, now_ms],
                        )
                        .unwrap_or(0)
                        > 0
                    {
                        stats.blobs_written += 1;
                    }
                    h
                });

                let derivation_json = row
                    .get("customInstructions")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let output_id = row.get("outputId").and_then(|v| v.as_i64()).unwrap_or(idx as i64);

                tx.execute(
                    "INSERT INTO utxos (
                        outpoint, txid, vout, satoshis, basket, state, is_change,
                        derivation_json, script_blob_hash, spent_by_txid, created_at_ms, updated_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                     ON CONFLICT(outpoint) DO UPDATE SET
                        state = CASE WHEN utxos.state = 'spent' THEN 'spent' ELSE excluded.state END,
                        spent_by_txid = COALESCE(utxos.spent_by_txid, excluded.spent_by_txid),
                        updated_at_ms = excluded.updated_at_ms",
                    params![
                        outpoint,
                        txid,
                        vout,
                        satoshis,
                        basket,
                        state.as_str(),
                        if is_change { 1 } else { 0 },
                        derivation_json,
                        script_hash,
                        spent_by_txid,
                        output_id,
                        now_ms,
                    ],
                )?;
                stats.utxos += 1;

                if matches!(basket.as_str(), "1sat" | "bntft" | "bntnft") {
                    tx.execute(
                        "INSERT OR IGNORE INTO items (
                            outpoint, origin_outpoint, basket, authenticity_status,
                            authenticity_reason, name, mime, sort_key, updated_at_ms
                         ) VALUES (?1, ?1, ?2, 'unproven', 'imported_brc38', '', '', ?3, ?4)",
                        params![outpoint, basket, output_id, now_ms],
                    )?;
                    stats.items += 1;
                }
            }
        }

        tx.commit()?;
        Ok(stats)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn imports_brc38_splitting_cold_blobs_and_skipping_retired_proof_reqs() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("hc-brc38-import-{nanos}.sqlite3"));
        let store = AccountStore::open(&path, 2).unwrap();

        let txid1 = "aa".repeat(32);
        let raw_b64 = BASE64.encode(b"fake-raw-tx-bytes");
        let script_b64 = BASE64.encode(b"fake-locking-script");
        let doc = serde_json::json!({
            "brc": 38,
            "schema": "brc-38",
            "tables": {
                "outputBaskets": [
                    { "basketId": 1, "name": "default" },
                    { "basketId": 2, "name": "1sat" }
                ],
                "provenTxs": [
                    { "provenTxId": 10, "txid": txid1, "height": 900000, "merkleRoot": "bb".repeat(32), "rawTx": raw_b64 }
                ],
                "provenTxReqs": [
                    { "provenTxReqId": 99, "txid": txid1, "status": "completed", "notified": true, "provenTxId": 10, "rawTx": raw_b64 }
                ],
                "transactions": [
                    { "transactionId": 5, "txid": txid1, "status": "completed", "provenTxId": 10, "isOutgoing": false, "satoshis": 25000, "description": "Deposit" }
                ],
                "outputs": [
                    { "outputId": 101, "transactionId": 5, "vout": 0, "satoshis": 25000, "basketId": 1, "spendable": true, "change": true, "lockingScript": script_b64 },
                    { "outputId": 102, "transactionId": 5, "vout": 1, "satoshis": 1, "basketId": 2, "spendable": true, "change": false, "lockingScript": script_b64 }
                ]
            }
        });

        let stats = import_brc38_json(&store, &doc.to_string(), 10_000).unwrap();
        assert_eq!(stats.transactions, 1);
        assert_eq!(stats.utxos, 2);
        assert_eq!(stats.items, 1);
        assert_eq!(stats.skipped_retired_proof_reqs, 1);
        // raw_tx + 1 deduplicated lockingScript (shared by both outputs!).
        assert_eq!(stats.blobs_written, 2);

        let bal = store.balance_summary().unwrap();
        assert_eq!(bal.spendable_sats, 25_000);
        assert_eq!(bal.item_count, 1);
        assert_eq!(
            store.get_tx_source_bytes(&txid1).unwrap(),
            Some(("raw".into(), b"fake-raw-tx-bytes".to_vec()))
        );

        let _ = std::fs::remove_file(&path);
    }
}
