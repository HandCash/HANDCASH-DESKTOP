// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Write, atomic reservation, CAS, purge, and bulk-migration operations for `ToolboxDb`.
//! All writes run on the single serialized writer connection.

use crate::toolbox_db::blobs::{
    encode_b64, extract_wire_bytes_field, get_cold_blob_len, put_cold_blob,
};
use crate::toolbox_db::ops_read::{
    hydrate_output_script, read_output_row, val_to_bool, OpResult, OutputRowRaw,
    MANAGED_AUTO_SPENDABLE_SQL, OUTPUT_SELECT_COLS,
};
use crate::toolbox_db::schema::{now_iso, parse_iso_or_now, parse_optional_iso};
use rusqlite::{params, types::Value as SqlVal, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

fn db_err(ctx: &str, err: rusqlite::Error) -> String {
    format!("{ctx}: {err}")
}

fn obj_of<'a>(val: &'a Value, field: &str) -> Result<&'a Map<String, Value>, String> {
    val.get(field)
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("missing object field '{field}'"))
}

fn str_or(obj: &Map<String, Value>, key: &str, default: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or(default)
        .to_string()
}

fn opt_str(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|v| if v.is_null() { None } else { v.as_str() })
        .map(ToString::to_string)
}

fn i64_or(obj: &Map<String, Value>, key: &str, default: i64) -> i64 {
    obj.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
}

fn opt_i64(obj: &Map<String, Value>, key: &str) -> Option<i64> {
    obj.get(key).and_then(|v| v.as_i64())
}

fn positive_opt_i64(obj: &Map<String, Value>, key: &str) -> Option<i64> {
    obj.get(key).and_then(|v| v.as_i64()).filter(|&n| n > 0)
}

fn bool_i64(obj: &Map<String, Value>, key: &str, default: bool) -> i64 {
    let b = obj.get(key).and_then(val_to_bool).unwrap_or(default);
    if b {
        1
    } else {
        0
    }
}

fn opt_bool_i64(obj: &Map<String, Value>, key: &str) -> Option<i64> {
    obj.get(key)
        .and_then(|v| if v.is_null() { None } else { val_to_bool(v) })
        .map(|b| if b { 1 } else { 0 })
}

// ─── Settings & Meta & Managed Change Default Migration ───────────────────────

pub fn ensure_settings(conn: &Connection, params_obj: &Value) -> OpResult {
    let existing = crate::toolbox_db::ops_read::read_settings(conn)?;
    if !existing.is_null() {
        migrate_managed_change_defaults(conn)?;
        return Ok(existing);
    }
    let storage_identity_key = params_obj
        .get("storageIdentityKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("migrate must be called with storageIdentityKey before first access")?;
    let storage_name = params_obj
        .get("storageName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("migrate must be called with storageName before first access")?;
    let chain = params_obj
        .get("chain")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    let max_output_script = params_obj
        .get("maxOutputScript")
        .and_then(|v| v.as_i64())
        .unwrap_or(1024);
    let now = now_iso();
    conn.execute(
        "INSERT OR IGNORE INTO settings (storage_identity_key, created_at, updated_at, storage_name, chain, dbtype, max_output_script)
         VALUES (?1, ?2, ?3, ?4, ?5, 'SQLite', ?6)",
        params![
            storage_identity_key,
            now,
            now,
            storage_name,
            chain,
            max_output_script
        ],
    )
    .map_err(|e| db_err("ensureSettings", e))?;
    migrate_managed_change_defaults(conn)?;
    crate::toolbox_db::ops_read::read_settings(conn)
}

/// Mirror `StorageIdb.migrateManagedChangeDefaults` (legacy 1000-sat default → 10000).
pub fn migrate_managed_change_defaults(conn: &Connection) -> Result<(), String> {
    let now = now_iso();
    conn.execute(
        "UPDATE output_baskets
         SET minimum_desired_utxo_value = 10000, updated_at = ?1
         WHERE name = 'default'
           AND number_of_desired_utxos = 32
           AND minimum_desired_utxo_value = 1000",
        params![now],
    )
    .map_err(|e| db_err("migrateManagedChangeDefaults", e))?;
    Ok(())
}

pub fn set_meta(conn: &Connection, params_obj: &Value) -> OpResult {
    let key = params_obj
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("missing key")?;
    let value = params_obj
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("missing value")?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| db_err("setMeta", e))?;
    Ok(Value::Bool(true))
}

// ─── Dynamic UPDATE Builder ───────────────────────────────────────────────────

struct UpdateBuilder {
    sets: Vec<String>,
    args: Vec<SqlVal>,
}

impl UpdateBuilder {
    fn new(update: &Map<String, Value>) -> Self {
        let updated_at = parse_iso_or_now(update.get("updated_at"));
        let mut b = Self {
            sets: vec!["updated_at = ?".into()],
            args: vec![SqlVal::Text(updated_at)],
        };
        if let Some(ca) = parse_optional_iso(update.get("created_at")) {
            b.sets.push("created_at = ?".into());
            b.args.push(SqlVal::Text(ca));
        }
        b
    }

    fn set_str(&mut self, col: &str, u: &Map<String, Value>, key: &str) {
        let Some(v) = u.get(key) else { return };
        self.sets.push(format!("{col} = ?"));
        if v.is_null() {
            self.args.push(SqlVal::Null);
        } else if let Some(s) = v.as_str() {
            self.args.push(SqlVal::Text(s.to_string()));
        } else {
            self.args.push(SqlVal::Null);
        }
    }

    fn set_i64(&mut self, col: &str, u: &Map<String, Value>, key: &str) {
        let Some(v) = u.get(key) else { return };
        self.sets.push(format!("{col} = ?"));
        if v.is_null() {
            self.args.push(SqlVal::Null);
        } else if let Some(n) = v.as_i64() {
            self.args.push(SqlVal::Integer(n));
        } else {
            self.args.push(SqlVal::Null);
        }
    }

    fn set_bool(&mut self, col: &str, u: &Map<String, Value>, key: &str) {
        let Some(v) = u.get(key) else { return };
        self.sets.push(format!("{col} = ?"));
        if v.is_null() {
            self.args.push(SqlVal::Null);
        } else if let Some(b) = val_to_bool(v) {
            self.args.push(SqlVal::Integer(if b { 1 } else { 0 }));
        } else {
            self.args.push(SqlVal::Integer(0));
        }
    }

    fn set_date(&mut self, col: &str, u: &Map<String, Value>, key: &str) {
        let Some(v) = u.get(key) else { return };
        self.sets.push(format!("{col} = ?"));
        if v.is_null() {
            self.args.push(SqlVal::Null);
        } else if let Some(iso) = parse_optional_iso(Some(v)) {
            self.args.push(SqlVal::Text(iso));
        } else {
            self.args.push(SqlVal::Null);
        }
    }

    fn set_blob(
        &mut self,
        conn: &Connection,
        col: &str,
        u: &Map<String, Value>,
        b64_key: &str,
        raw_key: &str,
    ) -> Result<(), String> {
        let Some(opt_bytes) = extract_wire_bytes_field(u, b64_key, raw_key)? else {
            return Ok(());
        };
        self.sets.push(format!("{col} = ?"));
        match opt_bytes {
            None => self.args.push(SqlVal::Null),
            Some(bytes) => {
                let hash = put_cold_blob(conn, &bytes).map_err(|e| db_err("update blob", e))?;
                self.args.push(SqlVal::Text(hash));
            }
        }
        Ok(())
    }

    fn exec_by_ids(
        mut self,
        conn: &Connection,
        table: &str,
        id_col: &str,
        ids: &[i64],
    ) -> Result<usize, String> {
        if ids.is_empty() {
            return Ok(0);
        }
        let ph = vec!["?"; ids.len()].join(",");
        for id in ids {
            self.args.push(SqlVal::Integer(*id));
        }
        let sql = format!(
            "UPDATE {table} SET {} WHERE {id_col} IN ({ph})",
            self.sets.join(", ")
        );
        conn.execute(&sql, rusqlite::params_from_iter(self.args.iter()))
            .map_err(|e| db_err(&format!("update {table}"), e))
    }
}

fn extract_ids(params_obj: &Value) -> Result<Vec<i64>, String> {
    if let Some(n) = params_obj.get("id").and_then(|v| v.as_i64()) {
        return Ok(vec![n]);
    }
    if let Some(arr) = params_obj.get("id").and_then(|v| v.as_array()) {
        return Ok(arr.iter().filter_map(|v| v.as_i64()).collect());
    }
    if let Some(arr) = params_obj.get("ids").and_then(|v| v.as_array()) {
        return Ok(arr.iter().filter_map(|v| v.as_i64()).collect());
    }
    Err("missing id".into())
}

// ─── Inserts ──────────────────────────────────────────────────────────────────

pub fn insert_user(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "userId");
    let ik = str_or(row, "identityKey", "");
    let active = str_or(row, "activeStorage", "");
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO users (user_id, created_at, updated_at, identity_key, active_storage) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, ca, ua, ik, active],
        )
        .map_err(|e| db_err("insertUser", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO users (created_at, updated_at, identity_key, active_storage) VALUES (?1, ?2, ?3, ?4)",
            params![ca, ua, ik, active],
        )
        .map_err(|e| db_err("insertUser", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_output_basket(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "basketId");
    let uid = i64_or(row, "userId", 0);
    let name = str_or(row, "name", "");
    let desired = i64_or(row, "numberOfDesiredUTXOs", 0);
    let min_val = i64_or(row, "minimumDesiredUTXOValue", 0);
    let del = bool_i64(row, "isDeleted", false);
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO output_baskets (basket_id, created_at, updated_at, user_id, name, number_of_desired_utxos, minimum_desired_utxo_value, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, ca, ua, uid, name, desired, min_val, del],
        )
        .map_err(|e| db_err("insertOutputBasket", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO output_baskets (created_at, updated_at, user_id, name, number_of_desired_utxos, minimum_desired_utxo_value, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![ca, ua, uid, name, desired, min_val, del],
        )
        .map_err(|e| db_err("insertOutputBasket", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_proven_tx(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "provenTxId");
    let txid = str_or(row, "txid", "");
    let height = i64_or(row, "height", 0);
    let index = i64_or(row, "index", 0);
    let mp_bytes = extract_wire_bytes_field(row, "merklePathB64", "merklePath")?
        .flatten()
        .unwrap_or_default();
    let rt_bytes = extract_wire_bytes_field(row, "rawTxB64", "rawTx")?
        .flatten()
        .unwrap_or_default();
    let mp_hash = put_cold_blob(conn, &mp_bytes).map_err(|e| db_err("insertProvenTx mp", e))?;
    let rt_hash = put_cold_blob(conn, &rt_bytes).map_err(|e| db_err("insertProvenTx rt", e))?;
    let block_hash = str_or(row, "blockHash", "");
    let merkle_root = str_or(row, "merkleRoot", "");
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO proven_txs (proven_tx_id, created_at, updated_at, txid, height, tx_index, merkle_path_hash, raw_tx_hash, block_hash, merkle_root)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, ca, ua, txid, height, index, mp_hash, rt_hash, block_hash, merkle_root],
        )
        .map_err(|e| db_err("insertProvenTx", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO proven_txs (created_at, updated_at, txid, height, tx_index, merkle_path_hash, raw_tx_hash, block_hash, merkle_root)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![ca, ua, txid, height, index, mp_hash, rt_hash, block_hash, merkle_root],
        )
        .map_err(|e| db_err("insertProvenTx", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_proven_tx_req(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "provenTxReqId");
    let ptx_id = opt_i64(row, "provenTxId");
    let status = str_or(row, "status", "unknown");
    let attempts = i64_or(row, "attempts", 0);
    let notified = bool_i64(row, "notified", false);
    let txid = str_or(row, "txid", "");
    let batch = opt_str(row, "batch");
    let history = str_or(row, "history", "{}");
    let notify = str_or(row, "notify", "{}");
    let rt_bytes = extract_wire_bytes_field(row, "rawTxB64", "rawTx")?
        .flatten()
        .unwrap_or_default();
    let rt_hash = put_cold_blob(conn, &rt_bytes).map_err(|e| db_err("insertProvenTxReq rt", e))?;
    let beef_hash = match extract_wire_bytes_field(row, "inputBEEFB64", "inputBEEF")?.flatten() {
        Some(b) => Some(put_cold_blob(conn, &b).map_err(|e| db_err("insertProvenTxReq beef", e))?),
        None => None,
    };
    let was_broadcast = opt_bool_i64(row, "wasBroadcast");
    let rebroadcast_attempts = opt_i64(row, "rebroadcastAttempts");
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO proven_tx_reqs (proven_tx_req_id, created_at, updated_at, proven_tx_id, status, attempts, notified, txid, batch, history, notify, raw_tx_hash, input_beef_hash, was_broadcast, rebroadcast_attempts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![id, ca, ua, ptx_id, status, attempts, notified, txid, batch, history, notify, rt_hash, beef_hash, was_broadcast, rebroadcast_attempts],
        )
        .map_err(|e| db_err("insertProvenTxReq", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO proven_tx_reqs (created_at, updated_at, proven_tx_id, status, attempts, notified, txid, batch, history, notify, raw_tx_hash, input_beef_hash, was_broadcast, rebroadcast_attempts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![ca, ua, ptx_id, status, attempts, notified, txid, batch, history, notify, rt_hash, beef_hash, was_broadcast, rebroadcast_attempts],
        )
        .map_err(|e| db_err("insertProvenTxReq", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_transaction(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "transactionId");
    let uid = i64_or(row, "userId", 0);
    let ptx_id = opt_i64(row, "provenTxId");
    let status = str_or(row, "status", "unprocessed");
    let reference = str_or(row, "reference", "");
    let is_outgoing = bool_i64(row, "isOutgoing", false);
    let satoshis = i64_or(row, "satoshis", 0);
    let description = str_or(row, "description", "");
    let version = opt_i64(row, "version");
    let lock_time = opt_i64(row, "lockTime");
    let txid = opt_str(row, "txid");
    let input_beef_hash =
        match extract_wire_bytes_field(row, "inputBEEFB64", "inputBEEF")?.flatten() {
            Some(b) => Some(put_cold_blob(conn, &b).map_err(|e| db_err("insertTx beef", e))?),
            None => None,
        };
    let raw_tx_hash = match extract_wire_bytes_field(row, "rawTxB64", "rawTx")?.flatten() {
        Some(b) => Some(put_cold_blob(conn, &b).map_err(|e| db_err("insertTx rawTx", e))?),
        None => None,
    };
    let reclaim_hash = match extract_wire_bytes_field(
        row,
        "noSendExpiryReclaimRawTxB64",
        "noSendExpiryReclaimRawTx",
    )?
    .flatten()
    {
        Some(b) => Some(put_cold_blob(conn, &b).map_err(|e| db_err("insertTx reclaimRawTx", e))?),
        None => None,
    };
    let nse_mode = opt_str(row, "noSendExpiryMode");
    let nse_val = opt_i64(row, "noSendExpiryValue");
    let nse_deadline = opt_i64(row, "noSendExpiryDeadline");
    let nse_state = opt_str(row, "noSendExpiryState");
    let nse_anchor_txid = opt_str(row, "noSendExpiryAnchorTxid");
    let nse_anchor_vout = opt_i64(row, "noSendExpiryAnchorVout");
    let nse_released = opt_i64(row, "noSendExpiryReleasedAt");
    let nse_observed = opt_i64(row, "noSendExpiryObservedAt");
    let nse_reclaim_txid = opt_str(row, "noSendExpiryReclaimTxid");
    let nse_reclaim_prefix = opt_str(row, "noSendExpiryReclaimDerivationPrefix");
    let nse_reclaim_suffix = opt_str(row, "noSendExpiryReclaimDerivationSuffix");
    let nse_reclaim_sats = opt_i64(row, "noSendExpiryReclaimSatoshis");

    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO transactions (
                transaction_id, created_at, updated_at, user_id, proven_tx_id, status, reference,
                is_outgoing, satoshis, description, version, lock_time, txid,
                input_beef_hash, raw_tx_hash,
                no_send_expiry_mode, no_send_expiry_value, no_send_expiry_deadline, no_send_expiry_state,
                no_send_expiry_anchor_txid, no_send_expiry_anchor_vout, no_send_expiry_released_at,
                no_send_expiry_observed_at, no_send_expiry_reclaim_txid, no_send_expiry_reclaim_raw_tx_hash,
                no_send_expiry_reclaim_derivation_prefix, no_send_expiry_reclaim_derivation_suffix,
                no_send_expiry_reclaim_satoshis
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)",
            params![
                id, ca, ua, uid, ptx_id, status, reference, is_outgoing, satoshis, description,
                version, lock_time, txid, input_beef_hash, raw_tx_hash,
                nse_mode, nse_val, nse_deadline, nse_state, nse_anchor_txid, nse_anchor_vout,
                nse_released, nse_observed, nse_reclaim_txid, reclaim_hash,
                nse_reclaim_prefix, nse_reclaim_suffix, nse_reclaim_sats
            ],
        )
        .map_err(|e| db_err("insertTransaction", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO transactions (
                created_at, updated_at, user_id, proven_tx_id, status, reference,
                is_outgoing, satoshis, description, version, lock_time, txid,
                input_beef_hash, raw_tx_hash,
                no_send_expiry_mode, no_send_expiry_value, no_send_expiry_deadline, no_send_expiry_state,
                no_send_expiry_anchor_txid, no_send_expiry_anchor_vout, no_send_expiry_released_at,
                no_send_expiry_observed_at, no_send_expiry_reclaim_txid, no_send_expiry_reclaim_raw_tx_hash,
                no_send_expiry_reclaim_derivation_prefix, no_send_expiry_reclaim_derivation_suffix,
                no_send_expiry_reclaim_satoshis
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)",
            params![
                ca, ua, uid, ptx_id, status, reference, is_outgoing, satoshis, description,
                version, lock_time, txid, input_beef_hash, raw_tx_hash,
                nse_mode, nse_val, nse_deadline, nse_state, nse_anchor_txid, nse_anchor_vout,
                nse_released, nse_observed, nse_reclaim_txid, reclaim_hash,
                nse_reclaim_prefix, nse_reclaim_suffix, nse_reclaim_sats
            ],
        )
        .map_err(|e| db_err("insertTransaction", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_output(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "outputId");
    let uid = i64_or(row, "userId", 0);
    let tx_id = i64_or(row, "transactionId", 0);
    let basket_id = opt_i64(row, "basketId");
    let spendable = bool_i64(row, "spendable", false);
    let change = bool_i64(row, "change", false);
    let desc = str_or(row, "outputDescription", "");
    let vout = i64_or(row, "vout", 0);
    let satoshis = i64_or(row, "satoshis", 0);
    let provided_by = str_or(row, "providedBy", "you");
    let purpose = str_or(row, "purpose", "");
    let typ = str_or(row, "type", "");
    let txid = opt_str(row, "txid");
    let sender_ik = opt_str(row, "senderIdentityKey");
    let deriv_prefix = opt_str(row, "derivationPrefix");
    let deriv_suffix = opt_str(row, "derivationSuffix");
    let custom_instr = opt_str(row, "customInstructions");
    let spent_by = opt_i64(row, "spentBy");
    let seq_num = opt_i64(row, "sequenceNumber");
    let spend_desc = opt_str(row, "spendingDescription");
    let script_len = opt_i64(row, "scriptLength");
    let script_off = opt_i64(row, "scriptOffset");
    let script_hash =
        match extract_wire_bytes_field(row, "lockingScriptB64", "lockingScript")?.flatten() {
            Some(b) => Some(put_cold_blob(conn, &b).map_err(|e| db_err("insertOutput script", e))?),
            None => None,
        };

    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO outputs (
                output_id, created_at, updated_at, user_id, transaction_id, basket_id,
                spendable, change_flag, output_description, vout, satoshis, provided_by, purpose, type,
                txid, sender_identity_key, derivation_prefix, derivation_suffix, custom_instructions,
                spent_by, sequence_number, spending_description, script_length, script_offset, locking_script_hash
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
            params![
                id, ca, ua, uid, tx_id, basket_id, spendable, change, desc, vout, satoshis,
                provided_by, purpose, typ, txid, sender_ik, deriv_prefix, deriv_suffix,
                custom_instr, spent_by, seq_num, spend_desc, script_len, script_off, script_hash
            ],
        )
        .map_err(|e| db_err("insertOutput", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO outputs (
                created_at, updated_at, user_id, transaction_id, basket_id,
                spendable, change_flag, output_description, vout, satoshis, provided_by, purpose, type,
                txid, sender_identity_key, derivation_prefix, derivation_suffix, custom_instructions,
                spent_by, sequence_number, spending_description, script_length, script_offset, locking_script_hash
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
            params![
                ca, ua, uid, tx_id, basket_id, spendable, change, desc, vout, satoshis,
                provided_by, purpose, typ, txid, sender_ik, deriv_prefix, deriv_suffix,
                custom_instr, spent_by, seq_num, spend_desc, script_len, script_off, script_hash
            ],
        )
        .map_err(|e| db_err("insertOutput", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_output_tag(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "outputTagId");
    let uid = i64_or(row, "userId", 0);
    let tag = str_or(row, "tag", "");
    let del = bool_i64(row, "isDeleted", false);
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO output_tags (output_tag_id, created_at, updated_at, user_id, tag, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, ca, ua, uid, tag, del],
        )
        .map_err(|e| db_err("insertOutputTag", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO output_tags (created_at, updated_at, user_id, tag, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![ca, ua, uid, tag, del],
        )
        .map_err(|e| db_err("insertOutputTag", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_output_tag_map(conn: &Connection, row: &Map<String, Value>) -> Result<(), String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let tag_id = i64_or(row, "outputTagId", 0);
    let output_id = i64_or(row, "outputId", 0);
    let del = bool_i64(row, "isDeleted", false);
    conn.execute(
        "INSERT INTO output_tags_map (output_tag_id, output_id, created_at, updated_at, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![tag_id, output_id, ca, ua, del],
    )
    .map_err(|e| db_err("insertOutputTagMap", e))?;
    Ok(())
}

pub fn insert_tx_label(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "txLabelId");
    let uid = i64_or(row, "userId", 0);
    let label = str_or(row, "label", "");
    let del = bool_i64(row, "isDeleted", false);
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO tx_labels (tx_label_id, created_at, updated_at, user_id, label, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, ca, ua, uid, label, del],
        )
        .map_err(|e| db_err("insertTxLabel", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO tx_labels (created_at, updated_at, user_id, label, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![ca, ua, uid, label, del],
        )
        .map_err(|e| db_err("insertTxLabel", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_tx_label_map(conn: &Connection, row: &Map<String, Value>) -> Result<(), String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let label_id = i64_or(row, "txLabelId", 0);
    let tx_id = i64_or(row, "transactionId", 0);
    let del = bool_i64(row, "isDeleted", false);
    conn.execute(
        "INSERT INTO tx_labels_map (tx_label_id, transaction_id, created_at, updated_at, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![label_id, tx_id, ca, ua, del],
    )
    .map_err(|e| db_err("insertTxLabelMap", e))?;
    Ok(())
}

pub fn insert_commission(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "commissionId");
    let uid = i64_or(row, "userId", 0);
    let tx_id = i64_or(row, "transactionId", 0);
    let satoshis = i64_or(row, "satoshis", 0);
    let key_offset = str_or(row, "keyOffset", "");
    let is_redeemed = bool_i64(row, "isRedeemed", false);
    let ls_bytes = extract_wire_bytes_field(row, "lockingScriptB64", "lockingScript")?
        .flatten()
        .unwrap_or_default();
    let ls_hash = put_cold_blob(conn, &ls_bytes).map_err(|e| db_err("insertCommission ls", e))?;
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO commissions (commission_id, created_at, updated_at, user_id, transaction_id, satoshis, key_offset, is_redeemed, locking_script_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, ca, ua, uid, tx_id, satoshis, key_offset, is_redeemed, ls_hash],
        )
        .map_err(|e| db_err("insertCommission", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO commissions (created_at, updated_at, user_id, transaction_id, satoshis, key_offset, is_redeemed, locking_script_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![ca, ua, uid, tx_id, satoshis, key_offset, is_redeemed, ls_hash],
        )
        .map_err(|e| db_err("insertCommission", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_certificate(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "certificateId");
    let uid = i64_or(row, "userId", 0);
    let typ = str_or(row, "type", "");
    let sn = str_or(row, "serialNumber", "");
    let certifier = str_or(row, "certifier", "");
    let subject = str_or(row, "subject", "");
    let verifier = opt_str(row, "verifier");
    let rev = str_or(row, "revocationOutpoint", "");
    let sig = str_or(row, "signature", "");
    let del = bool_i64(row, "isDeleted", false);

    let cert_id = if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO certificates (certificate_id, created_at, updated_at, user_id, type, serial_number, certifier, subject, verifier, revocation_outpoint, signature, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![id, ca, ua, uid, typ, sn, certifier, subject, verifier, rev, sig, del],
        )
        .map_err(|e| db_err("insertCertificate", e))?;
        id
    } else {
        conn.execute(
            "INSERT INTO certificates (created_at, updated_at, user_id, type, serial_number, certifier, subject, verifier, revocation_outpoint, signature, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![ca, ua, uid, typ, sn, certifier, subject, verifier, rev, sig, del],
        )
        .map_err(|e| db_err("insertCertificate", e))?;
        conn.last_insert_rowid()
    };

    if let Some(fields) = row.get("fields").and_then(|v| v.as_array()) {
        for field in fields {
            if let Some(fobj) = field.as_object() {
                let mut fclone = fobj.clone();
                fclone.insert("certificateId".into(), json!(cert_id));
                fclone.insert("userId".into(), json!(uid));
                insert_certificate_field(conn, &fclone)?;
            }
        }
    }
    Ok(cert_id)
}

pub fn insert_certificate_field(conn: &Connection, row: &Map<String, Value>) -> Result<(), String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let cert_id = i64_or(row, "certificateId", 0);
    let field_name = str_or(row, "fieldName", "");
    let uid = i64_or(row, "userId", 0);
    let field_value = str_or(row, "fieldValue", "");
    let master_key = str_or(row, "masterKey", "");
    conn.execute(
        "INSERT INTO certificate_fields (certificate_id, field_name, created_at, updated_at, user_id, field_value, master_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![cert_id, field_name, ca, ua, uid, field_value, master_key],
    )
    .map_err(|e| db_err("insertCertificateField", e))?;
    Ok(())
}

pub fn insert_sync_state(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "syncStateId");
    let uid = i64_or(row, "userId", 0);
    let sik = str_or(row, "storageIdentityKey", "");
    let sname = str_or(row, "storageName", "");
    let status = str_or(row, "status", "unknown");
    let init = bool_i64(row, "init", false);
    let ref_num = str_or(row, "refNum", "");
    let sync_map = str_or(row, "syncMap", "{}");
    let when_at = parse_optional_iso(row.get("when"));
    let satoshis = opt_i64(row, "satoshis");
    let err_local = opt_str(row, "errorLocal");
    let err_other = opt_str(row, "errorOther");
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO sync_states (sync_state_id, created_at, updated_at, user_id, storage_identity_key, storage_name, status, init, ref_num, sync_map, when_at, satoshis, error_local, error_other)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![id, ca, ua, uid, sik, sname, status, init, ref_num, sync_map, when_at, satoshis, err_local, err_other],
        )
        .map_err(|e| db_err("insertSyncState", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO sync_states (created_at, updated_at, user_id, storage_identity_key, storage_name, status, init, ref_num, sync_map, when_at, satoshis, error_local, error_other)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![ca, ua, uid, sik, sname, status, init, ref_num, sync_map, when_at, satoshis, err_local, err_other],
        )
        .map_err(|e| db_err("insertSyncState", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_monitor_event(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "id");
    let event = str_or(row, "event", "");
    let details = opt_str(row, "details");
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO monitor_events (id, created_at, updated_at, event, details) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, ca, ua, event, details],
        )
        .map_err(|e| db_err("insertMonitorEvent", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO monitor_events (created_at, updated_at, event, details) VALUES (?1, ?2, ?3, ?4)",
            params![ca, ua, event, details],
        )
        .map_err(|e| db_err("insertMonitorEvent", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_action_batch(conn: &Connection, row: &Map<String, Value>) -> Result<i64, String> {
    let ca = parse_iso_or_now(row.get("created_at"));
    let ua = parse_iso_or_now(row.get("updated_at"));
    let id_opt = positive_opt_i64(row, "actionBatchId");
    let uid = i64_or(row, "userId", 0);
    let batch_id = str_or(row, "batchId", "");
    let status = str_or(row, "status", "active");
    let expires_at = parse_iso_or_now(row.get("expiresAt"));
    let hard_expires_at = parse_iso_or_now(row.get("hardExpiresAt"));
    let manifest_digest = opt_str(row, "manifestDigest");
    let manifest = opt_str(row, "manifest");
    let upload_digests = opt_str(row, "uploadDigests");
    let result = opt_str(row, "result");
    if let Some(id) = id_opt {
        conn.execute(
            "INSERT INTO action_batches (action_batch_id, created_at, updated_at, user_id, batch_id, status, expires_at, hard_expires_at, manifest_digest, manifest, upload_digests, result)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id, ca, ua, uid, batch_id, status, expires_at, hard_expires_at, manifest_digest, manifest, upload_digests, result],
        )
        .map_err(|e| db_err("insertActionBatch", e))?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO action_batches (created_at, updated_at, user_id, batch_id, status, expires_at, hard_expires_at, manifest_digest, manifest, upload_digests, result)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![ca, ua, uid, batch_id, status, expires_at, hard_expires_at, manifest_digest, manifest, upload_digests, result],
        )
        .map_err(|e| db_err("insertActionBatch", e))?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn insert_outputs_batch(conn: &Connection, params_obj: &Value) -> OpResult {
    let rows = params_obj
        .get("rows")
        .and_then(|v| v.as_array())
        .ok_or("missing rows")?;
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        let obj = row.as_object().ok_or("output row must be object")?;
        ids.push(json!(insert_output(conn, obj)?));
    }
    Ok(Value::Array(ids))
}

// ─── Updates ──────────────────────────────────────────────────────────────────

pub fn update_user(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_str("identity_key", u, "identityKey");
    b.set_str("active_storage", u, "activeStorage");
    Ok(json!(b.exec_by_ids(conn, "users", "user_id", &ids)?))
}

pub fn update_output_basket(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_str("name", u, "name");
    b.set_i64("number_of_desired_utxos", u, "numberOfDesiredUTXOs");
    b.set_i64("minimum_desired_utxo_value", u, "minimumDesiredUTXOValue");
    b.set_bool("is_deleted", u, "isDeleted");
    Ok(json!(b.exec_by_ids(
        conn,
        "output_baskets",
        "basket_id",
        &ids
    )?))
}

pub fn update_output(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_i64("transaction_id", u, "transactionId");
    b.set_i64("basket_id", u, "basketId");
    b.set_bool("spendable", u, "spendable");
    b.set_bool("change_flag", u, "change");
    b.set_str("output_description", u, "outputDescription");
    b.set_i64("vout", u, "vout");
    b.set_i64("satoshis", u, "satoshis");
    b.set_str("provided_by", u, "providedBy");
    b.set_str("purpose", u, "purpose");
    b.set_str("type", u, "type");
    b.set_str("txid", u, "txid");
    b.set_str("sender_identity_key", u, "senderIdentityKey");
    b.set_str("derivation_prefix", u, "derivationPrefix");
    b.set_str("derivation_suffix", u, "derivationSuffix");
    b.set_str("custom_instructions", u, "customInstructions");
    b.set_i64("spent_by", u, "spentBy");
    b.set_i64("sequence_number", u, "sequenceNumber");
    b.set_str("spending_description", u, "spendingDescription");
    b.set_i64("script_length", u, "scriptLength");
    b.set_i64("script_offset", u, "scriptOffset");
    b.set_blob(
        conn,
        "locking_script_hash",
        u,
        "lockingScriptB64",
        "lockingScript",
    )?;
    Ok(json!(b.exec_by_ids(conn, "outputs", "output_id", &ids)?))
}

pub fn update_transaction(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_i64("proven_tx_id", u, "provenTxId");
    b.set_str("status", u, "status");
    b.set_str("reference", u, "reference");
    b.set_bool("is_outgoing", u, "isOutgoing");
    b.set_i64("satoshis", u, "satoshis");
    b.set_str("description", u, "description");
    b.set_i64("version", u, "version");
    b.set_i64("lock_time", u, "lockTime");
    b.set_str("txid", u, "txid");
    b.set_blob(conn, "input_beef_hash", u, "inputBEEFB64", "inputBEEF")?;
    b.set_blob(conn, "raw_tx_hash", u, "rawTxB64", "rawTx")?;
    b.set_str("no_send_expiry_mode", u, "noSendExpiryMode");
    b.set_i64("no_send_expiry_value", u, "noSendExpiryValue");
    b.set_i64("no_send_expiry_deadline", u, "noSendExpiryDeadline");
    b.set_str("no_send_expiry_state", u, "noSendExpiryState");
    b.set_str("no_send_expiry_anchor_txid", u, "noSendExpiryAnchorTxid");
    b.set_i64("no_send_expiry_anchor_vout", u, "noSendExpiryAnchorVout");
    b.set_i64("no_send_expiry_released_at", u, "noSendExpiryReleasedAt");
    b.set_i64("no_send_expiry_observed_at", u, "noSendExpiryObservedAt");
    b.set_str("no_send_expiry_reclaim_txid", u, "noSendExpiryReclaimTxid");
    b.set_blob(
        conn,
        "no_send_expiry_reclaim_raw_tx_hash",
        u,
        "noSendExpiryReclaimRawTxB64",
        "noSendExpiryReclaimRawTx",
    )?;
    b.set_str(
        "no_send_expiry_reclaim_derivation_prefix",
        u,
        "noSendExpiryReclaimDerivationPrefix",
    );
    b.set_str(
        "no_send_expiry_reclaim_derivation_suffix",
        u,
        "noSendExpiryReclaimDerivationSuffix",
    );
    b.set_i64(
        "no_send_expiry_reclaim_satoshis",
        u,
        "noSendExpiryReclaimSatoshis",
    );
    Ok(json!(b.exec_by_ids(
        conn,
        "transactions",
        "transaction_id",
        &ids
    )?))
}

pub fn update_proven_tx(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_str("txid", u, "txid");
    b.set_i64("height", u, "height");
    b.set_i64("tx_index", u, "index");
    b.set_blob(conn, "merkle_path_hash", u, "merklePathB64", "merklePath")?;
    b.set_blob(conn, "raw_tx_hash", u, "rawTxB64", "rawTx")?;
    b.set_str("block_hash", u, "blockHash");
    b.set_str("merkle_root", u, "merkleRoot");
    Ok(json!(b.exec_by_ids(
        conn,
        "proven_txs",
        "proven_tx_id",
        &ids
    )?))
}

pub fn update_proven_tx_req(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("proven_tx_id", u, "provenTxId");
    b.set_str("status", u, "status");
    b.set_i64("attempts", u, "attempts");
    b.set_bool("notified", u, "notified");
    b.set_str("txid", u, "txid");
    b.set_str("batch", u, "batch");
    b.set_str("history", u, "history");
    b.set_str("notify", u, "notify");
    b.set_blob(conn, "raw_tx_hash", u, "rawTxB64", "rawTx")?;
    b.set_blob(conn, "input_beef_hash", u, "inputBEEFB64", "inputBEEF")?;
    b.set_bool("was_broadcast", u, "wasBroadcast");
    b.set_i64("rebroadcast_attempts", u, "rebroadcastAttempts");
    Ok(json!(b.exec_by_ids(
        conn,
        "proven_tx_reqs",
        "proven_tx_req_id",
        &ids
    )?))
}

pub fn update_output_tag(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_str("tag", u, "tag");
    b.set_bool("is_deleted", u, "isDeleted");
    Ok(json!(b.exec_by_ids(
        conn,
        "output_tags",
        "output_tag_id",
        &ids
    )?))
}

pub fn update_output_tag_map(conn: &Connection, params_obj: &Value) -> OpResult {
    let output_id = params_obj
        .get("outputId")
        .and_then(|v| v.as_i64())
        .ok_or("missing outputId")?;
    let tag_id = params_obj
        .get("tagId")
        .and_then(|v| v.as_i64())
        .ok_or("missing tagId")?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_bool("is_deleted", u, "isDeleted");
    b.args.push(SqlVal::Integer(tag_id));
    b.args.push(SqlVal::Integer(output_id));
    let sql = format!(
        "UPDATE output_tags_map SET {} WHERE output_tag_id = ? AND output_id = ?",
        b.sets.join(", ")
    );
    let n = conn
        .execute(&sql, rusqlite::params_from_iter(b.args.iter()))
        .map_err(|e| db_err("updateOutputTagMap", e))?;
    Ok(json!(n))
}

pub fn update_tx_label(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_str("label", u, "label");
    b.set_bool("is_deleted", u, "isDeleted");
    Ok(json!(b.exec_by_ids(conn, "tx_labels", "tx_label_id", &ids)?))
}

pub fn update_tx_label_map(conn: &Connection, params_obj: &Value) -> OpResult {
    let transaction_id = params_obj
        .get("transactionId")
        .and_then(|v| v.as_i64())
        .ok_or("missing transactionId")?;
    let tx_label_id = params_obj
        .get("txLabelId")
        .and_then(|v| v.as_i64())
        .ok_or("missing txLabelId")?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_bool("is_deleted", u, "isDeleted");
    b.args.push(SqlVal::Integer(tx_label_id));
    b.args.push(SqlVal::Integer(transaction_id));
    let sql = format!(
        "UPDATE tx_labels_map SET {} WHERE tx_label_id = ? AND transaction_id = ?",
        b.sets.join(", ")
    );
    let n = conn
        .execute(&sql, rusqlite::params_from_iter(b.args.iter()))
        .map_err(|e| db_err("updateTxLabelMap", e))?;
    Ok(json!(n))
}

pub fn update_commission(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_i64("transaction_id", u, "transactionId");
    b.set_i64("satoshis", u, "satoshis");
    b.set_str("key_offset", u, "keyOffset");
    b.set_bool("is_redeemed", u, "isRedeemed");
    b.set_blob(
        conn,
        "locking_script_hash",
        u,
        "lockingScriptB64",
        "lockingScript",
    )?;
    Ok(json!(b.exec_by_ids(
        conn,
        "commissions",
        "commission_id",
        &ids
    )?))
}

pub fn update_certificate(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_str("type", u, "type");
    b.set_str("serial_number", u, "serialNumber");
    b.set_str("certifier", u, "certifier");
    b.set_str("subject", u, "subject");
    b.set_str("verifier", u, "verifier");
    b.set_str("revocation_outpoint", u, "revocationOutpoint");
    b.set_str("signature", u, "signature");
    b.set_bool("is_deleted", u, "isDeleted");
    Ok(json!(b.exec_by_ids(
        conn,
        "certificates",
        "certificate_id",
        &ids
    )?))
}

pub fn update_certificate_field(conn: &Connection, params_obj: &Value) -> OpResult {
    let cert_id = params_obj
        .get("certificateId")
        .and_then(|v| v.as_i64())
        .ok_or("missing certificateId")?;
    let field_name = params_obj
        .get("fieldName")
        .and_then(|v| v.as_str())
        .ok_or("missing fieldName")?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_str("field_value", u, "fieldValue");
    b.set_str("master_key", u, "masterKey");
    b.args.push(SqlVal::Integer(cert_id));
    b.args.push(SqlVal::Text(field_name.to_string()));
    let sql = format!(
        "UPDATE certificate_fields SET {} WHERE certificate_id = ? AND field_name = ?",
        b.sets.join(", ")
    );
    let n = conn
        .execute(&sql, rusqlite::params_from_iter(b.args.iter()))
        .map_err(|e| db_err("updateCertificateField", e))?;
    Ok(json!(n))
}

pub fn update_sync_state(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_i64("user_id", u, "userId");
    b.set_str("storage_identity_key", u, "storageIdentityKey");
    b.set_str("storage_name", u, "storageName");
    b.set_str("status", u, "status");
    b.set_bool("init", u, "init");
    b.set_str("ref_num", u, "refNum");
    b.set_str("sync_map", u, "syncMap");
    b.set_date("when_at", u, "when");
    b.set_i64("satoshis", u, "satoshis");
    b.set_str("error_local", u, "errorLocal");
    b.set_str("error_other", u, "errorOther");
    Ok(json!(b.exec_by_ids(
        conn,
        "sync_states",
        "sync_state_id",
        &ids
    )?))
}

pub fn update_monitor_event(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_str("event", u, "event");
    b.set_str("details", u, "details");
    Ok(json!(b.exec_by_ids(conn, "monitor_events", "id", &ids)?))
}

pub fn update_action_batch(conn: &Connection, params_obj: &Value) -> OpResult {
    let ids = extract_ids(params_obj)?;
    let u = obj_of(params_obj, "update")?;
    let mut b = UpdateBuilder::new(u);
    b.set_str("status", u, "status");
    b.set_date("expires_at", u, "expiresAt");
    b.set_date("hard_expires_at", u, "hardExpiresAt");
    b.set_str("manifest_digest", u, "manifestDigest");
    b.set_str("manifest", u, "manifest");
    b.set_str("upload_digests", u, "uploadDigests");
    b.set_str("result", u, "result");
    Ok(json!(b.exec_by_ids(
        conn,
        "action_batches",
        "action_batch_id",
        &ids
    )?))
}

pub fn delete_action_batch(conn: &Connection, params_obj: &Value) -> OpResult {
    let id = params_obj
        .get("actionBatchId")
        .and_then(|v| v.as_i64())
        .ok_or("missing actionBatchId")?;
    conn.execute(
        "DELETE FROM action_batches WHERE action_batch_id = ?1",
        params![id],
    )
    .map_err(|e| db_err("deleteActionBatch", e))?;
    Ok(Value::Bool(true))
}

pub fn reserve_action_batch_outputs(conn: &Connection, params_obj: &Value) -> OpResult {
    let rows = params_obj
        .get("reservations")
        .and_then(|v| v.as_array())
        .ok_or("missing reservations")?;
    for row in rows {
        let obj = row.as_object().ok_or("reservation must be object")?;
        let output_id = i64_or(obj, "outputId", 0);
        let ab_id = i64_or(obj, "actionBatchId", 0);
        let ca = parse_iso_or_now(obj.get("created_at"));
        let ua = parse_iso_or_now(obj.get("updated_at"));
        conn.execute(
            "INSERT INTO action_batch_outputs (output_id, action_batch_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![output_id, ab_id, ca, ua],
        )
        .map_err(|e| db_err("reserveActionBatchOutputs", e))?;
    }
    Ok(Value::Bool(true))
}

pub fn delete_action_batch_output_reservations(conn: &Connection, params_obj: &Value) -> OpResult {
    let id = params_obj
        .get("actionBatchId")
        .and_then(|v| v.as_i64())
        .ok_or("missing actionBatchId")?;
    conn.execute(
        "DELETE FROM action_batch_outputs WHERE action_batch_id = ?1",
        params![id],
    )
    .map_err(|e| db_err("deleteActionBatchOutputReservations", e))?;
    Ok(Value::Bool(true))
}

pub fn put_action_batch_blob_records(conn: &Connection, params_obj: &Value) -> OpResult {
    let blobs = params_obj
        .get("blobs")
        .and_then(|v| v.as_array())
        .ok_or("missing blobs")?;
    for blob in blobs {
        let obj = blob.as_object().ok_or("blob must be object")?;
        let ab_id = i64_or(obj, "actionBatchId", 0);
        let digest = str_or(obj, "digest", "");
        let blob_id = i64_or(obj, "actionBatchBlobId", 0);
        let ca = parse_iso_or_now(obj.get("created_at"));
        let ua = parse_iso_or_now(obj.get("updated_at"));
        let bytes = extract_wire_bytes_field(obj, "bytesB64", "bytes")?
            .flatten()
            .unwrap_or_default();
        let bhash = put_cold_blob(conn, &bytes).map_err(|e| db_err("putActionBatchBlob", e))?;
        conn.execute(
            "INSERT INTO action_batch_blobs (action_batch_id, digest, action_batch_blob_id, created_at, updated_at, bytes_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(action_batch_id, digest) DO UPDATE SET
               action_batch_blob_id = excluded.action_batch_blob_id,
               updated_at = excluded.updated_at,
               bytes_hash = excluded.bytes_hash",
            params![ab_id, digest, blob_id, ca, ua, bhash],
        )
        .map_err(|e| db_err("putActionBatchBlobRecords", e))?;
    }
    Ok(Value::Bool(true))
}

pub fn delete_action_batch_blob_records(conn: &Connection, params_obj: &Value) -> OpResult {
    let id = params_obj
        .get("actionBatchId")
        .and_then(|v| v.as_i64())
        .ok_or("missing actionBatchId")?;
    conn.execute(
        "DELETE FROM action_batch_blobs WHERE action_batch_id = ?1",
        params![id],
    )
    .map_err(|e| db_err("deleteActionBatchBlobRecords", e))?;
    Ok(Value::Bool(true))
}

// ─── Atomic Specialized Operations ────────────────────────────────────────────

/// Atomic BRC-177 no-send expiry state transition (CAS).
pub fn compare_and_set_no_send_expiry_state(conn: &Connection, params_obj: &Value) -> OpResult {
    let transaction_id = params_obj
        .get("transactionId")
        .and_then(|v| v.as_i64())
        .ok_or("missing transactionId")?;
    let expected = params_obj
        .get("expected")
        .and_then(|v| v.as_str())
        .ok_or("missing expected")?;
    let next = params_obj
        .get("next")
        .and_then(|v| v.as_str())
        .ok_or("missing next")?;
    let now = now_iso();
    let changed = conn
        .execute(
            "UPDATE transactions SET no_send_expiry_state = ?1, updated_at = ?2
             WHERE transaction_id = ?3 AND no_send_expiry_state = ?4",
            params![next, now, transaction_id, expected],
        )
        .map_err(|e| db_err("compareAndSetNoSendExpiryState", e))?;
    Ok(Value::Bool(changed == 1))
}

/// Atomic canonical change allocation (`exact -> least-over -> largest-under`),
/// excluding `action_batch_outputs` reservations, marking `spendable = 0, spent_by = transactionId`,
/// and hydrating `lockingScript` for the chosen output.
pub fn allocate_change_input(
    conn: &Connection,
    params_obj: &Value,
    in_tx: bool,
) -> OpResult {
    let user_id = params_obj
        .get("userId")
        .and_then(|v| v.as_i64())
        .ok_or("missing userId")?;
    let basket_id = params_obj
        .get("basketId")
        .and_then(|v| v.as_i64())
        .ok_or("missing basketId")?;
    let target_satoshis = params_obj
        .get("targetSatoshis")
        .and_then(|v| v.as_i64())
        .ok_or("missing targetSatoshis")?;
    let exact_satoshis = params_obj.get("exactSatoshis").and_then(|v| v.as_i64());
    let exclude_sending = params_obj
        .get("excludeSending")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let transaction_id = params_obj
        .get("transactionId")
        .and_then(|v| v.as_i64())
        .ok_or("missing transactionId")?;

    let status_clause = if exclude_sending {
        "t.status IN ('completed','unproven')"
    } else {
        "t.status IN ('completed','unproven','sending')"
    };

    if !in_tx {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| db_err("allocateChangeInput begin", e))?;
    }

    let result: OpResult = (|| {
        let base_where = format!(
            "FROM outputs o
             INNER JOIN transactions t ON t.transaction_id = o.transaction_id
             WHERE o.user_id = ?1
               AND o.basket_id = ?2
               AND {MANAGED_AUTO_SPENDABLE_SQL}
               AND t.user_id = ?1
               AND {status_clause}
               AND NOT EXISTS (
                   SELECT 1 FROM action_batch_outputs abo WHERE abo.output_id = o.output_id
               )"
        );

        let mut chosen: Option<OutputRowRaw> = None;

        // 1. Exact satoshis match (lowest output_id)
        if let Some(exact) = exact_satoshis {
            let sql = format!(
                "SELECT {OUTPUT_SELECT_COLS} {base_where} AND o.satoshis = ?3 ORDER BY o.output_id ASC LIMIT 1"
            );
            chosen = conn
                .query_row(&sql, params![user_id, basket_id, exact], read_output_row)
                .optional()
                .map_err(|e| db_err("allocateChangeInput exact", e))?;
        }

        // 2. Least over targetSatoshis (lowest satoshis >= target, then lowest output_id)
        if chosen.is_none() {
            let sql = format!(
                "SELECT {OUTPUT_SELECT_COLS} {base_where} AND o.satoshis >= ?3 ORDER BY o.satoshis ASC, o.output_id ASC LIMIT 1"
            );
            chosen = conn
                .query_row(
                    &sql,
                    params![user_id, basket_id, target_satoshis],
                    read_output_row,
                )
                .optional()
                .map_err(|e| db_err("allocateChangeInput over", e))?;
        }

        // 3. Largest under targetSatoshis (highest satoshis < target, then highest output_id)
        if chosen.is_none() {
            let sql = format!(
                "SELECT {OUTPUT_SELECT_COLS} {base_where} AND o.satoshis < ?3 ORDER BY o.satoshis DESC, o.output_id DESC LIMIT 1"
            );
            chosen = conn
                .query_row(
                    &sql,
                    params![user_id, basket_id, target_satoshis],
                    read_output_row,
                )
                .optional()
                .map_err(|e| db_err("allocateChangeInput under", e))?;
        }

        let Some(mut output) = chosen else {
            return Ok(Value::Null);
        };

        let now = now_iso();
        conn.execute(
            "UPDATE outputs SET spendable = 0, spent_by = ?1, updated_at = ?2 WHERE output_id = ?3",
            params![transaction_id, now, output.output_id],
        )
        .map_err(|e| db_err("allocateChangeInput update", e))?;

        let mut tx_raw_cache = HashMap::new();
        if let Some(bytes) = hydrate_output_script(conn, &output, &mut tx_raw_cache)? {
            output
                .json
                .insert("lockingScriptB64".into(), Value::String(encode_b64(&bytes)));
        }
        Ok(Value::Object(output.json))
    })();

    if !in_tx {
        match &result {
            Ok(_) => {
                conn.execute_batch("COMMIT")
                    .map_err(|e| db_err("allocateChangeInput commit", e))?;
            }
            Err(_) => {
                let _ = conn.execute_batch("ROLLBACK");
            }
        }
    }
    result
}

/// Atomic single-statement purge of retired `proven_tx_reqs` whose proof already exists in `proven_txs`.
pub fn purge_retired_proof_reqs(conn: &Connection, params_obj: &Value) -> OpResult {
    let cutoff_iso = parse_optional_iso(params_obj.get("cutoff"))
        .ok_or("missing cutoff timestamp")?;

    let mut stmt = conn
        .prepare(
            "SELECT r.proven_tx_req_id, r.raw_tx_hash, r.input_beef_hash, length(r.history)
             FROM proven_tx_reqs r
             WHERE r.status = 'completed'
               AND r.notified = 1
               AND r.proven_tx_id IS NOT NULL
               AND r.proven_tx_id > 0
               AND r.updated_at <= ?1
               AND EXISTS (SELECT 1 FROM proven_txs p WHERE p.proven_tx_id = r.proven_tx_id)",
        )
        .map_err(|e| db_err("purgeRetiredProofReqs select", e))?;
    let candidates: Vec<(i64, String, Option<String>, i64)> = stmt
        .query_map(params![cutoff_iso], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| db_err("purgeRetiredProofReqs query", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| db_err("purgeRetiredProofReqs row", e))?;

    if candidates.is_empty() {
        return Ok(json!({ "purged": 0, "bytes": 0 }));
    }

    let mut total_bytes: usize = 0;
    for (_, raw_hash, beef_hash, hist_len) in &candidates {
        total_bytes += get_cold_blob_len(conn, raw_hash).unwrap_or(0);
        if let Some(bh) = beef_hash {
            total_bytes += get_cold_blob_len(conn, bh).unwrap_or(0);
        }
        total_bytes += (*hist_len).max(0) as usize;
    }

    let mut purged = 0usize;
    for chunk in candidates.chunks(500) {
        let ph = vec!["?"; chunk.len()].join(",");
        let args: Vec<SqlVal> = chunk.iter().map(|c| SqlVal::Integer(c.0)).collect();
        let sql = format!("DELETE FROM proven_tx_reqs WHERE proven_tx_req_id IN ({ph})");
        purged += conn
            .execute(&sql, rusqlite::params_from_iter(args.iter()))
            .map_err(|e| db_err("purgeRetiredProofReqs delete", e))?;
    }
    Ok(json!({ "purged": purged, "bytes": total_bytes }))
}

// ─── Chunked Non-Destructive IndexedDB → SQLite Migration ─────────────────────

pub fn import_migration_chunk(conn: &Connection, params_obj: &Value) -> OpResult {
    let table = params_obj
        .get("table")
        .and_then(|v| v.as_str())
        .ok_or("missing table")?;
    let rows = params_obj
        .get("rows")
        .and_then(|v| v.as_array())
        .ok_or("missing rows")?;

    let mut imported = 0usize;
    for row in rows {
        let obj = row.as_object().ok_or("migration row must be object")?;
        match table {
            "settings" => {
                let sik = str_or(obj, "storageIdentityKey", "");
                if sik.is_empty() {
                    continue;
                }
                let ca = parse_iso_or_now(obj.get("created_at"));
                let ua = parse_iso_or_now(obj.get("updated_at"));
                let sname = str_or(obj, "storageName", "");
                let chain = str_or(obj, "chain", "main");
                let max_os = i64_or(obj, "maxOutputScript", 1024);
                conn.execute("DELETE FROM settings", [])
                    .map_err(|e| db_err("migrate settings clear", e))?;
                conn.execute(
                    "INSERT INTO settings (storage_identity_key, created_at, updated_at, storage_name, chain, dbtype, max_output_script)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'SQLite', ?6)",
                    params![sik, ca, ua, sname, chain, max_os],
                )
                .map_err(|e| db_err("migrate settings insert", e))?;
            }
            "users" => {
                let _ = insert_user(conn, obj)?;
            }
            "output_baskets" => {
                let _ = insert_output_basket(conn, obj)?;
            }
            "proven_txs" => {
                let _ = insert_proven_tx(conn, obj)?;
            }
            "proven_tx_reqs" => {
                let _ = insert_proven_tx_req(conn, obj)?;
            }
            "transactions" => {
                let _ = insert_transaction(conn, obj)?;
            }
            "outputs" => {
                let _ = insert_output(conn, obj)?;
            }
            "output_tags" => {
                let _ = insert_output_tag(conn, obj)?;
            }
            "output_tags_map" => {
                insert_output_tag_map(conn, obj)?;
            }
            "tx_labels" => {
                let _ = insert_tx_label(conn, obj)?;
            }
            "tx_labels_map" => {
                insert_tx_label_map(conn, obj)?;
            }
            "commissions" => {
                let _ = insert_commission(conn, obj)?;
            }
            "certificates" => {
                // Fields are migrated separately via certificate_fields store; strip embedded fields if present.
                let mut clean = obj.clone();
                clean.remove("fields");
                let _ = insert_certificate(conn, &clean)?;
            }
            "certificate_fields" => {
                insert_certificate_field(conn, obj)?;
            }
            "sync_states" => {
                let _ = insert_sync_state(conn, obj)?;
            }
            "monitor_events" => {
                let _ = insert_monitor_event(conn, obj)?;
            }
            "action_batches" => {
                let _ = insert_action_batch(conn, obj)?;
            }
            "action_batch_outputs" => {
                let output_id = i64_or(obj, "outputId", 0);
                let ab_id = i64_or(obj, "actionBatchId", 0);
                let ca = parse_iso_or_now(obj.get("created_at"));
                let ua = parse_iso_or_now(obj.get("updated_at"));
                conn.execute(
                    "INSERT OR REPLACE INTO action_batch_outputs (output_id, action_batch_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![output_id, ab_id, ca, ua],
                )
                .map_err(|e| db_err("migrate action_batch_outputs", e))?;
            }
            "action_batch_blobs" => {
                let ab_id = i64_or(obj, "actionBatchId", 0);
                let digest = str_or(obj, "digest", "");
                let blob_id = i64_or(obj, "actionBatchBlobId", 0);
                let ca = parse_iso_or_now(obj.get("created_at"));
                let ua = parse_iso_or_now(obj.get("updated_at"));
                let bytes = extract_wire_bytes_field(obj, "bytesB64", "bytes")?
                    .flatten()
                    .unwrap_or_default();
                let bhash =
                    put_cold_blob(conn, &bytes).map_err(|e| db_err("migrate blob", e))?;
                conn.execute(
                    "INSERT OR REPLACE INTO action_batch_blobs (action_batch_id, digest, action_batch_blob_id, created_at, updated_at, bytes_hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![ab_id, digest, blob_id, ca, ua, bhash],
                )
                .map_err(|e| db_err("migrate action_batch_blobs", e))?;
            }
            other => return Err(format!("unknown migration table '{other}'")),
        }
        imported += 1;
    }
    Ok(json!({ "imported": imported }))
}

/// Dispatch any write operation on `&Connection`.
pub fn dispatch_write(
    conn: &Connection,
    op: &str,
    params_obj: &Value,
    in_tx: bool,
) -> OpResult {
    match op {
        "ensureSettings" => ensure_settings(conn, params_obj),
        "setMeta" => set_meta(conn, params_obj),
        "insertUser" => Ok(json!(insert_user(conn, obj_of(params_obj, "row")?)?)),
        "insertOutputBasket" => Ok(json!(insert_output_basket(
            conn,
            obj_of(params_obj, "row")?
        )?)),
        "insertProvenTx" => Ok(json!(insert_proven_tx(conn, obj_of(params_obj, "row")?)?)),
        "insertProvenTxReq" => Ok(json!(insert_proven_tx_req(
            conn,
            obj_of(params_obj, "row")?
        )?)),
        "insertTransaction" => Ok(json!(insert_transaction(
            conn,
            obj_of(params_obj, "row")?
        )?)),
        "insertOutput" => Ok(json!(insert_output(conn, obj_of(params_obj, "row")?)?)),
        "insertOutputs" => insert_outputs_batch(conn, params_obj),
        "insertOutputTag" => Ok(json!(insert_output_tag(conn, obj_of(params_obj, "row")?)?)),
        "insertOutputTagMap" => {
            insert_output_tag_map(conn, obj_of(params_obj, "row")?)?;
            Ok(Value::Bool(true))
        }
        "insertTxLabel" => Ok(json!(insert_tx_label(conn, obj_of(params_obj, "row")?)?)),
        "insertTxLabelMap" => {
            insert_tx_label_map(conn, obj_of(params_obj, "row")?)?;
            Ok(Value::Bool(true))
        }
        "insertCommission" => Ok(json!(insert_commission(
            conn,
            obj_of(params_obj, "row")?
        )?)),
        "insertCertificate" => Ok(json!(insert_certificate(
            conn,
            obj_of(params_obj, "row")?
        )?)),
        "insertCertificateField" => {
            insert_certificate_field(conn, obj_of(params_obj, "row")?)?;
            Ok(Value::Bool(true))
        }
        "insertSyncState" => Ok(json!(insert_sync_state(conn, obj_of(params_obj, "row")?)?)),
        "insertMonitorEvent" => Ok(json!(insert_monitor_event(
            conn,
            obj_of(params_obj, "row")?
        )?)),
        "insertActionBatch" => Ok(json!(insert_action_batch(
            conn,
            obj_of(params_obj, "row")?
        )?)),
        "updateUser" => update_user(conn, params_obj),
        "updateOutputBasket" => update_output_basket(conn, params_obj),
        "updateOutput" => update_output(conn, params_obj),
        "updateTransaction" => update_transaction(conn, params_obj),
        "updateProvenTx" => update_proven_tx(conn, params_obj),
        "updateProvenTxReq" => update_proven_tx_req(conn, params_obj),
        "updateOutputTag" => update_output_tag(conn, params_obj),
        "updateOutputTagMap" => update_output_tag_map(conn, params_obj),
        "updateTxLabel" => update_tx_label(conn, params_obj),
        "updateTxLabelMap" => update_tx_label_map(conn, params_obj),
        "updateCommission" => update_commission(conn, params_obj),
        "updateCertificate" => update_certificate(conn, params_obj),
        "updateCertificateField" => update_certificate_field(conn, params_obj),
        "updateSyncState" => update_sync_state(conn, params_obj),
        "updateMonitorEvent" => update_monitor_event(conn, params_obj),
        "updateActionBatch" => update_action_batch(conn, params_obj),
        "deleteActionBatch" => delete_action_batch(conn, params_obj),
        "reserveActionBatchOutputs" => reserve_action_batch_outputs(conn, params_obj),
        "deleteActionBatchOutputReservations" => {
            delete_action_batch_output_reservations(conn, params_obj)
        }
        "putActionBatchBlobRecords" => put_action_batch_blob_records(conn, params_obj),
        "deleteActionBatchBlobRecords" => delete_action_batch_blob_records(conn, params_obj),
        "compareAndSetNoSendExpiryState" => compare_and_set_no_send_expiry_state(conn, params_obj),
        "allocateChangeInput" => allocate_change_input(conn, params_obj, in_tx),
        "purgeRetiredProofReqs" => purge_retired_proof_reqs(conn, params_obj),
        "importMigrationChunk" => import_migration_chunk(conn, params_obj),
        other => Err(format!("unknown toolbox write op '{other}'")),
    }
}
