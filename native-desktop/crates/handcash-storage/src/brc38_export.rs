// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! BRC-38 JSON exporter from per-account SQLite WAL (`AccountStore`) and `ToolboxDb`.
//!
//! Produces a canonical BRC-38 JSON document (`brc: 38`, `schema: "brc-38"`, no null fields)
//! ready for `handcash_primitives::brc39::encrypt_brc39` and `Brc39Archive::write_snapshot`.
#![allow(clippy::type_complexity)]

use crate::store::{AccountStore, StorageError};
use crate::toolbox_db::ToolboxDb;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Export the current state of `AccountStore` as a valid BRC-38 JSON string (no null values).
pub fn export_brc38_json(store: &AccountStore, exported_at_ms: i64) -> Result<String, StorageError> {
    store.with_writer(|conn| {
        let mut basket_id_by_name: HashMap<String, i64> = HashMap::new();
        let mut output_baskets: Vec<Value> = Vec::new();
        let mut next_basket_id = 1i64;

        let mut ensure_basket = |name: &str| -> i64 {
            if let Some(&id) = basket_id_by_name.get(name) {
                return id;
            }
            let id = next_basket_id;
            next_basket_id += 1;
            basket_id_by_name.insert(name.to_string(), id);
            output_baskets.push(json!({
                "basketId": id,
                "name": name,
            }));
            id
        };
        ensure_basket("default");
        ensure_basket("1sat");

        let mut blob_cache: HashMap<String, String> = HashMap::new();
        let mut load_blob_b64 = |hash_opt: Option<String>| -> Option<String> {
            let h = hash_opt?;
            if let Some(cached) = blob_cache.get(&h) {
                return Some(cached.clone());
            }
            let bytes: Vec<u8> = conn
                .query_row("SELECT data FROM blobs WHERE sha256 = ?1", [&h], |r| r.get(0))
                .ok()?;
            let b64 = BASE64.encode(&bytes);
            blob_cache.insert(h, b64.clone());
            Some(b64)
        };

        let mut tx_stmt = conn.prepare(
            "SELECT txid, status, is_outgoing, satoshis, description,
                    block_height, merkle_root, raw_blob_hash, beef_blob_hash, bump_blob_hash, created_at_ms
             FROM transactions
             ORDER BY created_at_ms ASC, txid ASC",
        )?;
        let tx_rows: Vec<(
            String,
            String,
            i64,
            i64,
            String,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
        )> = tx_stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut proven_txs = Vec::new();
        let mut transactions = Vec::new();
        let mut tx_row_id_by_txid: HashMap<String, i64> = HashMap::new();
        let mut next_proven_id = 1i64;

        for (
            idx,
            (
                txid,
                status,
                is_outgoing,
                satoshis,
                description,
                block_height,
                merkle_root,
                raw_hash,
                beef_hash,
                bump_hash,
                created_at_ms,
            ),
        ) in tx_rows.into_iter().enumerate()
        {
            let tx_row_id = (idx + 1) as i64;
            tx_row_id_by_txid.insert(txid.clone(), tx_row_id);
            let raw_b64 = load_blob_b64(raw_hash);
            let beef_b64 = load_blob_b64(beef_hash);
            let bump_b64 = load_blob_b64(bump_hash);

            let mut proven_id_opt = None;
            if status == "mined" || block_height.is_some() || bump_b64.is_some() {
                let pid = next_proven_id;
                next_proven_id += 1;
                proven_id_opt = Some(pid);
                let mut p_obj = Map::new();
                p_obj.insert("provenTxId".into(), Value::from(pid));
                p_obj.insert("txid".into(), Value::from(txid.clone()));
                if let Some(h) = block_height {
                    p_obj.insert("height".into(), Value::from(h));
                }
                if let Some(mr) = merkle_root {
                    p_obj.insert("merkleRoot".into(), Value::from(mr));
                }
                if let Some(ref rb) = raw_b64 {
                    p_obj.insert("rawTx".into(), Value::from(rb.clone()));
                }
                if let Some(bp) = bump_b64 {
                    p_obj.insert("merklePath".into(), Value::from(bp));
                }
                proven_txs.push(Value::Object(p_obj));
            }

            let brc38_status = match status.as_str() {
                "mined" => "completed",
                "abandoned" | "proven_rejected" => "failed",
                _ => "unproven",
            };
            let mut t_obj = Map::new();
            t_obj.insert("transactionId".into(), Value::from(tx_row_id));
            t_obj.insert("txid".into(), Value::from(txid));
            t_obj.insert("status".into(), Value::from(brc38_status));
            t_obj.insert("isOutgoing".into(), Value::from(is_outgoing != 0));
            t_obj.insert("satoshis".into(), Value::from(satoshis));
            t_obj.insert("description".into(), Value::from(description));
            t_obj.insert("created_at".into(), Value::from(created_at_ms.to_string()));
            if let Some(pid) = proven_id_opt {
                t_obj.insert("provenTxId".into(), Value::from(pid));
            }
            if let Some(rb) = raw_b64 {
                t_obj.insert("rawTx".into(), Value::from(rb));
            }
            if let Some(bf) = beef_b64 {
                t_obj.insert("inputBEEF".into(), Value::from(bf));
            }
            transactions.push(Value::Object(t_obj));
        }

        let mut utxo_stmt = conn.prepare(
            "SELECT txid, vout, satoshis, basket, state, is_change,
                    derivation_json, script_blob_hash, spent_by_txid, created_at_ms
             FROM utxos
             ORDER BY created_at_ms ASC, outpoint ASC",
        )?;
        let utxo_rows: Vec<(
            String,
            u32,
            i64,
            String,
            String,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
        )> = utxo_stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut outputs = Vec::with_capacity(utxo_rows.len());
        for (
            idx,
            (
                txid,
                vout,
                satoshis,
                basket,
                state,
                is_change,
                derivation_json,
                script_hash,
                spent_by_txid,
                created_at_ms,
            ),
        ) in utxo_rows.into_iter().enumerate()
        {
            let output_id = if created_at_ms > 0 {
                created_at_ms
            } else {
                (idx + 1) as i64
            };
            let basket_id = ensure_basket(&basket);
            let spendable = state == "spendable" || state == "reserved";
            let mut o_obj = Map::new();
            o_obj.insert("outputId".into(), Value::from(output_id));
            o_obj.insert("txid".into(), Value::from(txid.clone()));
            if let Some(&tx_row_id) = tx_row_id_by_txid.get(&txid) {
                o_obj.insert("transactionId".into(), Value::from(tx_row_id));
            }
            o_obj.insert("vout".into(), Value::from(vout));
            o_obj.insert("satoshis".into(), Value::from(satoshis));
            o_obj.insert("basketId".into(), Value::from(basket_id));
            o_obj.insert("spendable".into(), Value::from(spendable));
            o_obj.insert("change".into(), Value::from(is_change != 0));
            if let Some(dj) = derivation_json.filter(|s| !s.is_empty()) {
                o_obj.insert("customInstructions".into(), Value::from(dj));
            }
            if let Some(sb) = load_blob_b64(script_hash) {
                o_obj.insert("lockingScript".into(), Value::from(sb));
            }
            if let Some(spent_txid) = spent_by_txid {
                if let Some(&spent_row_id) = tx_row_id_by_txid.get(&spent_txid) {
                    o_obj.insert("spentBy".into(), Value::from(spent_row_id));
                }
            }
            outputs.push(Value::Object(o_obj));
        }

        let doc = json!({
            "brc": 38,
            "schema": "brc-38",
            "exportedAt": exported_at_ms,
            "tables": {
                "outputBaskets": output_baskets,
                "provenTxs": proven_txs,
                "provenTxReqs": [],
                "transactions": transactions,
                "outputs": outputs,
            }
        });
        Ok(doc.to_string())
    })
}

/// Export the current state of a Wallet Toolbox SQLite database (`ToolboxDb`) as a valid BRC-38 JSON string (no null values).
pub fn export_brc38_from_toolbox(tb: &ToolboxDb, exported_at_ms: i64) -> Result<String, String> {
    let baskets_res = tb.execute_read("findOutputBaskets", &json!({}), None)?;
    let mut output_baskets = Vec::new();
    if let Some(arr) = baskets_res.as_array() {
        for b in arr {
            if let (Some(id), Some(name)) = (b.get("basketId").and_then(Value::as_i64), b.get("name").and_then(Value::as_str)) {
                output_baskets.push(json!({
                    "basketId": id,
                    "name": name,
                }));
            }
        }
    }
    if output_baskets.is_empty() {
        output_baskets.push(json!({ "basketId": 1, "name": "default" }));
        output_baskets.push(json!({ "basketId": 2, "name": "1sat" }));
    }

    let ptx_res = tb.execute_read("findProvenTxs", &json!({}), None)?;
    let mut proven_txs = Vec::new();
    if let Some(arr) = ptx_res.as_array() {
        for p in arr {
            let Some(pid) = p.get("provenTxId").and_then(Value::as_i64) else {
                continue;
            };
            let Some(txid) = p.get("txid").and_then(Value::as_str) else {
                continue;
            };
            let mut obj = Map::new();
            obj.insert("provenTxId".into(), Value::from(pid));
            obj.insert("txid".into(), Value::from(txid));
            if let Some(h) = p.get("height").and_then(Value::as_i64) {
                obj.insert("height".into(), Value::from(h));
            }
            if let Some(mr) = p.get("merkleRoot").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                obj.insert("merkleRoot".into(), Value::from(mr));
            }
            if let Some(rt) = p.get("rawTx").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                obj.insert("rawTx".into(), Value::from(rt));
            }
            if let Some(mp) = p.get("merklePath").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                obj.insert("merklePath".into(), Value::from(mp));
            }
            proven_txs.push(Value::Object(obj));
        }
    }

    let txs_res = tb.execute_read("findTransactions", &json!({}), None)?;
    let mut transactions = Vec::new();
    if let Some(arr) = txs_res.as_array() {
        for t in arr {
            let Some(tid) = t.get("transactionId").and_then(Value::as_i64) else {
                continue;
            };
            let Some(txid) = t.get("txid").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                continue;
            };
            let mut obj = Map::new();
            obj.insert("transactionId".into(), Value::from(tid));
            obj.insert("txid".into(), Value::from(txid));
            let status = t.get("status").and_then(Value::as_str).unwrap_or("unproven");
            obj.insert("status".into(), Value::from(status));
            obj.insert(
                "isOutgoing".into(),
                Value::from(t.get("isOutgoing").and_then(Value::as_bool).unwrap_or(false)),
            );
            obj.insert(
                "satoshis".into(),
                Value::from(t.get("satoshis").and_then(Value::as_i64).unwrap_or(0)),
            );
            obj.insert(
                "description".into(),
                Value::from(t.get("description").and_then(Value::as_str).unwrap_or("")),
            );
            if let Some(ca) = t.get("created_at").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                obj.insert("created_at".into(), Value::from(ca));
            }
            if let Some(pid) = t.get("provenTxId").and_then(Value::as_i64) {
                obj.insert("provenTxId".into(), Value::from(pid));
            }
            if let Some(rt) = t.get("rawTx").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                obj.insert("rawTx".into(), Value::from(rt));
            }
            if let Some(bf) = t.get("inputBEEF").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                obj.insert("inputBEEF".into(), Value::from(bf));
            }
            transactions.push(Value::Object(obj));
        }
    }

    let outs_res = tb.execute_read("findOutputs", &json!({ "includeLockingScripts": true }), None)?;
    let mut outputs = Vec::new();
    if let Some(arr) = outs_res.as_array() {
        for o in arr {
            let Some(oid) = o.get("outputId").and_then(Value::as_i64) else {
                continue;
            };
            let mut obj = Map::new();
            obj.insert("outputId".into(), Value::from(oid));
            if let Some(tid) = o.get("transactionId").and_then(Value::as_i64) {
                obj.insert("transactionId".into(), Value::from(tid));
            }
            if let Some(txid) = o.get("txid").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                obj.insert("txid".into(), Value::from(txid));
            }
            obj.insert(
                "vout".into(),
                Value::from(o.get("vout").and_then(Value::as_i64).unwrap_or(0)),
            );
            obj.insert(
                "satoshis".into(),
                Value::from(o.get("satoshis").and_then(Value::as_i64).unwrap_or(0)),
            );
            obj.insert(
                "basketId".into(),
                Value::from(o.get("basketId").and_then(Value::as_i64).unwrap_or(1)),
            );
            obj.insert(
                "spendable".into(),
                Value::from(o.get("spendable").and_then(Value::as_bool).unwrap_or(false)),
            );
            obj.insert(
                "change".into(),
                Value::from(o.get("change").and_then(Value::as_bool).unwrap_or(false)),
            );
            if let Some(ci) = o
                .get("customInstructions")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                obj.insert("customInstructions".into(), Value::from(ci));
            }
            if let Some(ls) = o
                .get("lockingScript")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                obj.insert("lockingScript".into(), Value::from(ls));
            }
            if let Some(sb) = o.get("spentBy").and_then(Value::as_i64) {
                obj.insert("spentBy".into(), Value::from(sb));
            }
            outputs.push(Value::Object(obj));
        }
    }

    let doc = json!({
        "brc": 38,
        "schema": "brc-38",
        "exportedAt": exported_at_ms,
        "tables": {
            "outputBaskets": output_baskets,
            "provenTxs": proven_txs,
            "provenTxReqs": [],
            "transactions": transactions,
            "outputs": outputs,
        }
    });
    Ok(doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brc38_import::import_brc38_json;
    use handcash_primitives::brc39::validate_brc38_json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn export_and_import_brc38_roundtrip_preserves_state_and_validates_brc39() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p1 = std::env::temp_dir().join(format!("hc-brc38-exp1-{nanos}.sqlite3"));
        let p2 = std::env::temp_dir().join(format!("hc-brc38-exp2-{nanos}.sqlite3"));
        let s1 = AccountStore::open(&p1, 1).unwrap();
        let s2 = AccountStore::open(&p2, 1).unwrap();

        let txid1 = "cc".repeat(32);
        let raw_b64 = BASE64.encode(b"sample-raw-tx");
        let script_b64 = BASE64.encode(b"sample-script");
        let seed_doc = json!({
            "brc": 38,
            "schema": "brc-38",
            "tables": {
                "outputBaskets": [
                    { "basketId": 1, "name": "default" },
                    { "basketId": 2, "name": "1sat" }
                ],
                "provenTxs": [
                    { "provenTxId": 1, "txid": txid1, "height": 850000, "rawTx": raw_b64 }
                ],
                "transactions": [
                    { "transactionId": 1, "txid": txid1, "status": "completed", "provenTxId": 1, "isOutgoing": false, "satoshis": 42000, "description": "Receive" }
                ],
                "outputs": [
                    { "outputId": 10, "transactionId": 1, "vout": 0, "satoshis": 42000, "basketId": 1, "spendable": true, "change": true, "lockingScript": script_b64 },
                    { "outputId": 11, "transactionId": 1, "vout": 1, "satoshis": 1, "basketId": 2, "spendable": true, "change": false, "lockingScript": script_b64 }
                ]
            }
        });
        import_brc38_json(&s1, &seed_doc.to_string(), 5_000).unwrap();

        let exported = export_brc38_json(&s1, 6_000).unwrap();
        // Must pass strict BRC-39 structural & no-null validation.
        validate_brc38_json(&exported).unwrap();

        let stats = import_brc38_json(&s2, &exported, 7_000).unwrap();
        assert_eq!(stats.transactions, 1);
        assert_eq!(stats.utxos, 2);
        assert_eq!(stats.items, 1);
        assert_eq!(s2.balance_summary().unwrap().spendable_sats, 42_000);
        assert_eq!(s2.balance_summary().unwrap().item_count, 1);

        let _ = std::fs::remove_file(&p1);
        let _ = std::fs::remove_file(&p2);
    }
}
