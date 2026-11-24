// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Native Rust SQLite WAL storage engine for the HandCash Wallet Toolbox (`StorageRustSqlite`).
//!
//! Architecture:
//! - One SQLite WAL file per logical database name (`<base_dir>/<sha256(dbName)[..24]>.sqlite3`)
//! - 1 serialized writer `Connection` supporting ACID multi-call transactions (`BEGIN IMMEDIATE`)
//! - 4-connection concurrent WAL `ReaderPool` (`PRAGMA query_only = ON`) so concurrent UI reads
//!   (`listOutputs`, `findOutputs`, cash summary, activity ledger) never block on writers or each other
//! - SHA-256 content-addressed `cold_blobs` table keeping `lockingScript`, `rawTx`, `inputBEEF`,
//!   and `merklePath` completely off hot metadata B-tree pages.

pub mod blobs;
pub mod ops_read;
pub mod ops_write;
pub mod schema;

use ops_read::OpResult;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

const READ_POOL_SIZE: usize = 4;

/// Parse an ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SS[.sss]Z` or `YYYY-MM-DD HH:MM:SS`)
/// into Unix epoch milliseconds without external date crates.
fn parse_iso8601_utc_ms(s: &str) -> Option<i64> {
    let clean = s.trim().trim_end_matches('Z');
    let (date_part, time_part) = clean.split_once('T').or_else(|| clean.split_once(' '))?;
    let mut dp = date_part.split('-');
    let year: i64 = dp.next()?.parse().ok()?;
    let month: i64 = dp.next()?.parse().ok()?;
    let day: i64 = dp.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hms, frac_str) = match time_part.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (time_part, None),
    };
    let mut tp = hms.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let minute: i64 = tp.next()?.parse().ok()?;
    let second: i64 = tp.next().unwrap_or("0").parse().ok()?;
    let millis: i64 = match frac_str {
        Some(f) => {
            let digits: String = f.chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
            match digits.len() {
                0 => 0,
                1 => digits.parse::<i64>().unwrap_or(0) * 100,
                2 => digits.parse::<i64>().unwrap_or(0) * 10,
                _ => digits.parse::<i64>().unwrap_or(0),
            }
        }
        None => 0,
    };
    // Howard Hinnant's civil-from-days inverse algorithm (days since 1970-01-01).
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m_adj = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m_adj + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(secs * 1000 + millis)
}

/// Pool of read-only WAL SQLite connections with zero contention against the writer.
struct ReaderPool {
    conns: Mutex<Vec<Connection>>,
    available: Condvar,
}

impl ReaderPool {
    fn open(path: &Path, size: usize) -> Result<Self, String> {
        let mut conns = Vec::with_capacity(size);
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI;
        for _ in 0..size {
            let conn = Connection::open_with_flags(path, flags)
                .map_err(|e| format!("open toolbox reader: {e}"))?;
            schema::apply_reader_pragmas(&conn)
                .map_err(|e| format!("toolbox reader pragmas: {e}"))?;
            conns.push(conn);
        }
        Ok(Self {
            conns: Mutex::new(conns),
            available: Condvar::new(),
        })
    }

    fn with_conn<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&Connection) -> Result<R, String>,
    {
        let conn = {
            let mut guard = self.conns.lock().unwrap_or_else(|e| e.into_inner());
            while guard.is_empty() {
                guard = self.available.wait(guard).unwrap_or_else(|e| e.into_inner());
            }
            guard.pop().unwrap()
        };
        let res = f(&conn);
        {
            let mut guard = self.conns.lock().unwrap_or_else(|e| e.into_inner());
            guard.push(conn);
            self.available.notify_one();
        }
        res
    }
}

struct WriterInner {
    conn: Connection,
    active_tx: Option<u64>,
    next_tx_id: u64,
}

/// Single logical Wallet Toolbox SQLite WAL database.
pub struct ToolboxDb {
    db_name: String,
    path: PathBuf,
    writer: Mutex<WriterInner>,
    readers: ReaderPool,
}

impl ToolboxDb {
    pub fn open(path: PathBuf, db_name: String) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create toolbox db dir: {e}"))?;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&path, flags)
            .map_err(|e| format!("open toolbox writer: {e}"))?;
        schema::apply_writer_pragmas(&conn)
            .map_err(|e| format!("toolbox writer pragmas: {e}"))?;
        conn.execute_batch(schema::TOOLBOX_SCHEMA_SQL)
            .map_err(|e| format!("toolbox schema init: {e}"))?;
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
            [schema::TOOLBOX_SCHEMA_VERSION],
        )
        .map_err(|e| format!("toolbox meta init: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('db_name', ?1)",
            [&db_name],
        )
        .map_err(|e| format!("toolbox db_name meta: {e}"))?;

        let readers = ReaderPool::open(&path, READ_POOL_SIZE)?;
        Ok(Self {
            db_name,
            path,
            writer: Mutex::new(WriterInner {
                conn,
                active_tx: None,
                next_tx_id: 1,
            }),
            readers,
        })
    }

    pub fn db_name(&self) -> &str {
        &self.db_name
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read a native wallet snapshot (spendable balance, 1sat items, and recent transactions)
    /// directly from the Wallet Toolbox SQLite WAL database using the concurrent read pool.
    #[allow(clippy::type_complexity)]
    pub fn read_wallet_snapshot(
        &self,
        items_limit: i64,
        activity_limit: i64,
    ) -> Result<
        (
            crate::store::BalanceBreakdown,
            Vec<crate::store::ItemCardRow>,
            u64,
            Vec<crate::store::ActivityRow>,
            u64,
        ),
        String,
    > {
        self.readers.with_conn(|conn| {
            let (spendable_sats, spendable_utxo_count): (i64, i64) = conn
                .query_row(
                    "SELECT COALESCE(SUM(o.satoshis), 0), COUNT(*)
                     FROM outputs o
                     LEFT JOIN output_baskets b ON b.basket_id = o.basket_id
                     WHERE o.spendable = 1
                       AND o.spent_by IS NULL
                       AND (b.name = 'default' OR (o.basket_id IS NULL AND o.change_flag = 1))",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| format!("toolbox balance query: {e}"))?;

            let item_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM outputs o
                     JOIN output_baskets b ON b.basket_id = o.basket_id
                     WHERE o.spendable = 1
                       AND o.spent_by IS NULL
                       AND b.name != 'default'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            let mut item_stmt = conn
                .prepare(
                    "SELECT o.output_id, COALESCE(o.txid, ''), o.vout, b.name,
                            COALESCE(o.output_description, ''),
                            COALESCE(o.custom_instructions, ''),
                            o.locking_script_hash
                     FROM outputs o
                     JOIN output_baskets b ON b.basket_id = o.basket_id
                     WHERE o.spendable = 1
                       AND o.spent_by IS NULL
                       AND b.name != 'default'
                     ORDER BY o.output_id DESC
                     LIMIT ?1",
                )
                .map_err(|e| format!("toolbox items prepare: {e}"))?;

            let mut tag_stmt = conn
                .prepare(
                    "SELECT t.tag
                     FROM output_tags_map m
                     JOIN output_tags t ON t.output_tag_id = m.output_tag_id
                     WHERE m.output_id = ?1 AND m.is_deleted = 0 AND t.is_deleted = 0",
                )
                .ok();

            let raw_items: Vec<(i64, String, i64, String, String, String, Option<String>)> =
                item_stmt
                    .query_map([items_limit.max(1)], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    })
                    .map_err(|e| format!("toolbox items query: {e}"))?
                    .filter_map(Result::ok)
                    .collect();

            let mut items = Vec::with_capacity(raw_items.len());
            for (output_id, txid, vout, basket, desc, custom_instructions, locking_script_hash) in
                raw_items
            {
                let outpoint = if txid.is_empty() {
                    format!("out-{output_id}.{vout}")
                } else {
                    format!("{txid}.{vout}")
                };

                let mut origin_outpoint = outpoint.clone();
                let mut name = String::new();
                let mut mime = String::new();
                let mut issuer_key: Option<String> = None;

                if !custom_instructions.trim().is_empty() {
                    if let Ok(v) = serde_json::from_str::<Value>(&custom_instructions) {
                        if let Some(n) = v
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            name = n.to_string();
                        }
                        if let Some(o) = v
                            .get("origin")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            origin_outpoint = o.replace('_', ".");
                        }
                        if let Some(m) = v
                            .get("contentType")
                            .or_else(|| v.get("mime"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            mime = m.to_string();
                        }
                        if let Some(iss) = v
                            .get("issuerKey")
                            .or_else(|| v.get("issuer"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            issuer_key = Some(iss.to_string());
                        }
                    }
                }

                if let Some(ref mut stmt) = tag_stmt {
                    if let Ok(rows) = stmt.query_map([output_id], |r| r.get::<_, String>(0)) {
                        for tag in rows.filter_map(Result::ok) {
                            if let Some(val) = tag.strip_prefix("origin:") {
                                let clean = val.trim();
                                if !clean.is_empty() && origin_outpoint == outpoint {
                                    origin_outpoint = clean.replace('_', ".");
                                }
                            } else if let Some(val) = tag.strip_prefix("name:") {
                                let clean = val.trim();
                                if !clean.is_empty() && name.is_empty() {
                                    name = clean.to_string();
                                }
                            } else if let Some(val) = tag.strip_prefix("type:") {
                                let clean = val.trim();
                                if !clean.is_empty() && mime.is_empty() {
                                    mime = clean.to_string();
                                }
                            } else if let Some(val) = tag.strip_prefix("issuer:") {
                                let clean = val.trim();
                                if !clean.is_empty() && issuer_key.is_none() {
                                    issuer_key = Some(clean.to_string());
                                }
                            }
                        }
                    }
                }

                if name.is_empty() {
                    if !desc.trim().is_empty() {
                        name = desc;
                    } else {
                        name = format!("{basket} #{output_id}");
                    }
                }
                if mime.is_empty() {
                    mime = "application/octet-stream".into();
                }

                items.push(crate::store::ItemCardRow {
                    outpoint,
                    origin_outpoint,
                    basket,
                    authenticity_status: "unproven".into(),
                    authenticity_reason: None,
                    verified_at_ms: None,
                    issuer_key,
                    name,
                    mime,
                    art_blob_hash: locking_script_hash,
                    sort_key: output_id,
                });
            }

            let activity_total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM transactions WHERE status != 'failed'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            let mut tx_stmt = conn
                .prepare(
                    "SELECT transaction_id, txid, is_outgoing, satoshis, status, description, created_at
                     FROM transactions
                     WHERE status != 'failed'
                     ORDER BY transaction_id DESC
                     LIMIT ?1",
                )
                .map_err(|e| format!("toolbox activity prepare: {e}"))?;

            let activity: Vec<crate::store::ActivityRow> = tx_stmt
                .query_map([activity_limit.max(1)], |row| {
                    let tx_row_id: i64 = row.get(0)?;
                    let txid: Option<String> = row.get(1)?;
                    let is_outgoing: i64 = row.get(2)?;
                    let satoshis: i64 = row.get(3)?;
                    let status: String = row.get(4)?;
                    let description: String = row.get(5)?;
                    let created_at: String = row.get(6)?;
                    let direction = if is_outgoing != 0 || satoshis < 0 {
                        "outgoing"
                    } else {
                        "incoming"
                    };
                    let title = if description.trim().is_empty() {
                        if direction == "outgoing" {
                            "Sent BSV".into()
                        } else {
                            "Received BSV".into()
                        }
                    } else {
                        description
                    };
                    let sort_ts_ms = parse_iso8601_utc_ms(&created_at).unwrap_or(0);
                    Ok(crate::store::ActivityRow {
                        activity_id: format!("tx:{tx_row_id}"),
                        txid,
                        kind: "payment".into(),
                        direction: direction.into(),
                        satoshis,
                        status,
                        title,
                        counterparty: None,
                        app_origin: None,
                        sort_ts_ms,
                    })
                })
                .map_err(|e| format!("toolbox activity query: {e}"))?
                .filter_map(Result::ok)
                .collect();

            let spendable = spendable_sats.max(0) as u64;
            let balance = crate::store::BalanceBreakdown {
                spendable_sats: spendable,
                pending_change_sats: 0,
                displayed_sats: spendable,
                spendable_utxo_count: spendable_utxo_count.max(0) as u64,
                item_count: item_count.max(0) as u64,
            };

            Ok((
                balance,
                items,
                item_count.max(0) as u64,
                activity,
                activity_total.max(0) as u64,
            ))
        })
    }

    /// Read raw bytes from the content-addressed `cold_blobs` table using the concurrent read pool.
    pub fn read_cold_blob(&self, hash: &str) -> Option<Vec<u8>> {
        self.readers
            .with_conn(|conn| {
                let mut stmt = conn
                    .prepare("SELECT data FROM cold_blobs WHERE hash = ?1")
                    .map_err(|e| e.to_string())?;
                let bytes: Vec<u8> = stmt
                    .query_row([hash], |r| r.get(0))
                    .map_err(|e| e.to_string())?;
                Ok(bytes)
            })
            .ok()
    }

    pub fn begin_tx(&self) -> Result<u64, String> {
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = w.active_tx {
            return Err(format!("transaction {existing} already active on writer"));
        }
        w.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| format!("beginTx: {e}"))?;
        let id = w.next_tx_id;
        w.next_tx_id = w.next_tx_id.wrapping_add(1).max(1);
        w.active_tx = Some(id);
        Ok(id)
    }

    pub fn commit_tx(&self, trx_id: u64) -> Result<(), String> {
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if w.active_tx != Some(trx_id) {
            return Err(format!("commitTx: trxId {trx_id} is not active"));
        }
        let res = w
            .conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("commitTx: {e}"));
        w.active_tx = None;
        res
    }

    pub fn rollback_tx(&self, trx_id: u64) -> Result<(), String> {
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if w.active_tx != Some(trx_id) {
            return Ok(());
        }
        let _ = w.conn.execute_batch("ROLLBACK");
        w.active_tx = None;
        Ok(())
    }

    pub fn rollback_any_active_tx(&self) {
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if w.active_tx.take().is_some() {
            let _ = w.conn.execute_batch("ROLLBACK");
        }
    }

    /// Execute a read-only op concurrently on the WAL `ReaderPool` (unless `trx_id` is set,
    /// in which case it reads from the writer connection to observe uncommitted tx writes).
    pub fn execute_read(&self, op: &str, params_obj: &Value, trx_id: Option<u64>) -> OpResult {
        if let Some(tid) = trx_id {
            let w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            if w.active_tx != Some(tid) {
                return Err(format!("read op '{op}': trxId {tid} is not active"));
            }
            return dispatch_read(&w.conn, op, params_obj);
        }
        self.readers
            .with_conn(|conn| dispatch_read(conn, op, params_obj))
    }

    /// Execute a write op on the serialized writer connection.
    pub fn execute_write(&self, op: &str, params_obj: &Value, trx_id: Option<u64>) -> OpResult {
        let w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        match trx_id {
            Some(tid) => {
                if w.active_tx != Some(tid) {
                    return Err(format!("write op '{op}': trxId {tid} is not active"));
                }
                ops_write::dispatch_write(&w.conn, op, params_obj, true)
            }
            None => {
                if let Some(active) = w.active_tx {
                    return Err(format!(
                        "write op '{op}' attempted without trxId while transaction {active} is open"
                    ));
                }
                ops_write::dispatch_write(&w.conn, op, params_obj, false)
            }
        }
    }
}

pub fn is_read_op(op: &str) -> bool {
    matches!(
        op,
        "readSettings"
            | "getMeta"
            | "identitySummary"
            | "tableCounts"
            | "findUsers"
            | "countUsers"
            | "findOutputBaskets"
            | "countOutputBaskets"
            | "findOutputTags"
            | "countOutputTags"
            | "findOutputTagMaps"
            | "countOutputTagMaps"
            | "getTagsForOutputId"
            | "findTxLabels"
            | "countTxLabels"
            | "findTxLabelMaps"
            | "countTxLabelMaps"
            | "getLabelsForTransactionId"
            | "findCertificateFields"
            | "countCertificateFields"
            | "findCertificates"
            | "countCertificates"
            | "findCommissions"
            | "countCommissions"
            | "findMonitorEvents"
            | "countMonitorEvents"
            | "findSyncStates"
            | "countSyncStates"
            | "findProvenTxs"
            | "countProvenTxs"
            | "findProvenTxReqs"
            | "countProvenTxReqs"
            | "getProvenOrRawTxs"
            | "getRawTxOfKnownValidTransaction"
            | "getRawTxsForScriptSlices"
            | "findTransactions"
            | "countTransactions"
            | "findTransactionStatusesByIds"
            | "findOutputs"
            | "countOutputs"
            | "findOutputsByIds"
            | "findOutputsByOutpoints"
            | "listOutputsFast"
            | "sumSpendableOutputs"
            | "readCashSummary"
            | "readPendingChangePage"
            | "countChangeInputs"
            | "findActionBatch"
            | "findExpiredActionBatches"
            | "findActionBatchOutputIds"
            | "findReservedActionBatchOutputIds"
            | "findActionBatchBlobRecords"
    )
}

pub fn dispatch_read(conn: &Connection, op: &str, params_obj: &Value) -> OpResult {
    match op {
        "readSettings" => ops_read::read_settings(conn),
        "getMeta" => ops_read::get_meta(conn, params_obj),
        "identitySummary" => ops_read::identity_summary(conn, params_obj),
        "tableCounts" => ops_read::table_counts(conn),
        "findUsers" => ops_read::find_users(conn, params_obj),
        "countUsers" => ops_read::count_users(conn, params_obj),
        "findOutputBaskets" => ops_read::find_output_baskets(conn, params_obj),
        "countOutputBaskets" => ops_read::count_output_baskets(conn, params_obj),
        "findOutputTags" => ops_read::find_output_tags(conn, params_obj),
        "countOutputTags" => ops_read::count_output_tags(conn, params_obj),
        "findOutputTagMaps" => ops_read::find_output_tag_maps(conn, params_obj),
        "countOutputTagMaps" => ops_read::count_output_tag_maps(conn, params_obj),
        "getTagsForOutputId" => ops_read::get_tags_for_output_id(conn, params_obj),
        "findTxLabels" => ops_read::find_tx_labels(conn, params_obj),
        "countTxLabels" => ops_read::count_tx_labels(conn, params_obj),
        "findTxLabelMaps" => ops_read::find_tx_label_maps(conn, params_obj),
        "countTxLabelMaps" => ops_read::count_tx_label_maps(conn, params_obj),
        "getLabelsForTransactionId" => ops_read::get_labels_for_transaction_id(conn, params_obj),
        "findCertificateFields" => ops_read::find_certificate_fields(conn, params_obj),
        "countCertificateFields" => ops_read::count_certificate_fields(conn, params_obj),
        "findCertificates" => ops_read::find_certificates(conn, params_obj),
        "countCertificates" => ops_read::count_certificates(conn, params_obj),
        "findCommissions" => ops_read::find_commissions(conn, params_obj),
        "countCommissions" => ops_read::count_commissions(conn, params_obj),
        "findMonitorEvents" => ops_read::find_monitor_events(conn, params_obj),
        "countMonitorEvents" => ops_read::count_monitor_events(conn, params_obj),
        "findSyncStates" => ops_read::find_sync_states(conn, params_obj),
        "countSyncStates" => ops_read::count_sync_states(conn, params_obj),
        "findProvenTxs" => ops_read::find_proven_txs(conn, params_obj),
        "countProvenTxs" => ops_read::count_proven_txs(conn, params_obj),
        "findProvenTxReqs" => ops_read::find_proven_tx_reqs(conn, params_obj),
        "countProvenTxReqs" => ops_read::count_proven_tx_reqs(conn, params_obj),
        "getProvenOrRawTxs" => ops_read::get_proven_or_raw_txs(conn, params_obj),
        "getRawTxOfKnownValidTransaction" => {
            ops_read::get_raw_tx_of_known_valid_transaction(conn, params_obj)
        }
        "getRawTxsForScriptSlices" => ops_read::get_raw_txs_for_script_slices(conn, params_obj),
        "findTransactions" => ops_read::find_transactions(conn, params_obj),
        "countTransactions" => ops_read::count_transactions(conn, params_obj),
        "findTransactionStatusesByIds" => {
            ops_read::find_transaction_statuses_by_ids(conn, params_obj)
        }
        "findOutputs" => ops_read::find_outputs(conn, params_obj),
        "countOutputs" => ops_read::count_outputs(conn, params_obj),
        "findOutputsByIds" => ops_read::find_outputs_by_ids(conn, params_obj),
        "findOutputsByOutpoints" => ops_read::find_outputs_by_outpoints(conn, params_obj),
        "listOutputsFast" => ops_read::list_outputs_fast(conn, params_obj),
        "sumSpendableOutputs" => ops_read::sum_spendable_outputs(conn, params_obj),
        "readCashSummary" => ops_read::read_cash_summary(conn, params_obj),
        "readPendingChangePage" => ops_read::read_pending_change_page(conn, params_obj),
        "countChangeInputs" => ops_read::count_change_inputs(conn, params_obj),
        "findActionBatch" => ops_read::find_action_batch(conn, params_obj),
        "findExpiredActionBatches" => ops_read::find_expired_action_batches(conn, params_obj),
        "findActionBatchOutputIds" => ops_read::find_action_batch_output_ids(conn, params_obj),
        "findReservedActionBatchOutputIds" => {
            ops_read::find_reserved_action_batch_output_ids(conn, params_obj)
        }
        "findActionBatchBlobRecords" => ops_read::find_action_batch_blob_records(conn, params_obj),
        other => Err(format!("unknown toolbox read op '{other}'")),
    }
}

/// Manages open `ToolboxDb` handles on disk under `<user_data>/toolbox-sqlite/`.
pub struct ToolboxDbManager {
    base_dir: PathBuf,
    dbs: Mutex<HashMap<String, Arc<ToolboxDb>>>,
}

impl ToolboxDbManager {
    pub fn new(user_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: user_data_dir.into().join("toolbox-sqlite"),
            dbs: Mutex::new(HashMap::new()),
        }
    }

    pub fn db_path(&self, db_name: &str) -> PathBuf {
        let digest = hex::encode(Sha256::digest(db_name.as_bytes()));
        self.base_dir.join(format!("{}.sqlite3", &digest[..24]))
    }

    pub fn exists_on_disk(&self, db_name: &str) -> bool {
        self.db_path(db_name).exists()
    }

    pub fn get_or_open(&self, db_name: &str) -> Result<Arc<ToolboxDb>, String> {
        if db_name.trim().is_empty() {
            return Err("dbName must be non-empty".into());
        }
        let mut map = self.dbs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(db_name) {
            return Ok(Arc::clone(existing));
        }
        let path = self.db_path(db_name);
        let db = Arc::new(ToolboxDb::open(path, db_name.to_string())?);
        map.insert(db_name.to_string(), Arc::clone(&db));
        Ok(db)
    }

    /// Open a database without creating a new SQLite file on disk (used for read-only
    /// existence checks such as `identitySummary`).
    pub fn open_if_exists(&self, db_name: &str) -> Result<Option<Arc<ToolboxDb>>, String> {
        if db_name.trim().is_empty() {
            return Ok(None);
        }
        {
            let map = self.dbs.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = map.get(db_name) {
                return Ok(Some(Arc::clone(existing)));
            }
        }
        if !self.exists_on_disk(db_name) {
            return Ok(None);
        }
        self.get_or_open(db_name).map(Some)
    }

    pub fn close(&self, db_name: &str) -> Value {
        let mut map = self.dbs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(db) = map.remove(db_name) {
            db.rollback_any_active_tx();
            drop(db);
        }
        Value::Bool(true)
    }

    pub fn drop_all_data(&self, db_name: &str) -> Result<Value, String> {
        self.close(db_name);
        let path = self.db_path(db_name);
        for suffix in ["", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{}", path.display(), suffix));
            if p.exists() {
                std::fs::remove_file(&p)
                    .map_err(|e| format!("remove toolbox db {}: {e}", p.display()))?;
            }
        }
        Ok(json!({ "dropped": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    fn tmp_manager(label: &str) -> ToolboxDbManager {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("handcash-toolbox-test-{label}-{nonce}"));
        ToolboxDbManager::new(dir)
    }

    #[test]
    fn settings_users_baskets_and_cold_blob_dedup_roundtrip() {
        let mgr = tmp_manager("roundtrip");
        let db = mgr.get_or_open("wallet-test-1").unwrap();

        let s = db
            .execute_write(
                "ensureSettings",
                &json!({
                    "storageName": "wallet-test-1",
                    "storageIdentityKey": "02aabbcc",
                    "chain": "main",
                    "maxOutputScript": 1024
                }),
                None,
            )
            .unwrap();
        assert_eq!(s["dbtype"], "SQLite");
        assert_eq!(s["storageIdentityKey"], "02aabbcc");

        let uid = db
            .execute_write(
                "insertUser",
                &json!({
                    "row": {
                        "identityKey": "021122",
                        "activeStorage": "02aabbcc"
                    }
                }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();
        assert_eq!(uid, 1);

        let bid = db
            .execute_write(
                "insertOutputBasket",
                &json!({
                    "row": {
                        "userId": uid,
                        "name": "default",
                        "numberOfDesiredUTXOs": 32,
                        "minimumDesiredUTXOValue": 10000,
                        "isDeleted": false
                    }
                }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();

        let raw_tx_bytes = vec![0x01, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
        let raw_tx_b64 = BASE64.encode(&raw_tx_bytes);
        let tx_id = db
            .execute_write(
                "insertTransaction",
                &json!({
                    "row": {
                        "userId": uid,
                        "status": "completed",
                        "reference": "ref-1",
                        "isOutgoing": false,
                        "satoshis": 5000,
                        "description": "funding",
                        "txid": "aaaa",
                        "rawTxB64": raw_tx_b64
                    }
                }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();

        // Store proven_tx with identical rawTx -> deduplicated in cold_blobs!
        let _ptx_id = db
            .execute_write(
                "insertProvenTx",
                &json!({
                    "row": {
                        "txid": "aaaa",
                        "height": 850000,
                        "index": 1,
                        "merklePathB64": BASE64.encode([1u8, 2, 3]),
                        "rawTxB64": BASE64.encode(&raw_tx_bytes),
                        "blockHash": "0000",
                        "merkleRoot": "1111"
                    }
                }),
                None,
            )
            .unwrap();

        // Insert output with script stripped to offset 4, len 4 ([0xaa, 0xbb, 0xcc, 0xdd])
        let oid = db
            .execute_write(
                "insertOutput",
                &json!({
                    "row": {
                        "userId": uid,
                        "transactionId": tx_id,
                        "basketId": bid,
                        "spendable": true,
                        "change": true,
                        "outputDescription": "change",
                        "vout": 0,
                        "satoshis": 5000,
                        "providedBy": "storage",
                        "purpose": "change",
                        "type": "P2PKH",
                        "txid": "aaaa",
                        "derivationPrefix": "p1",
                        "derivationSuffix": "s1",
                        "scriptOffset": 4,
                        "scriptLength": 4
                    }
                }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();

        // noScript: true omits lockingScriptB64
        let no_script = db
            .execute_read(
                "findOutputs",
                &json!({ "partial": { "outputId": oid }, "noScript": true }),
                None,
            )
            .unwrap();
        assert!(no_script[0].get("lockingScriptB64").is_none());

        // noScript: false slices directly from cold_blobs via SQLite substr()!
        let with_script = db
            .execute_read(
                "findOutputs",
                &json!({ "partial": { "outputId": oid }, "noScript": false }),
                None,
            )
            .unwrap();
        let hydrated = BASE64
            .decode(with_script[0]["lockingScriptB64"].as_str().unwrap())
            .unwrap();
        assert_eq!(hydrated, vec![0xaa, 0xbb, 0xcc, 0xdd]);

        // Clearing nullable column with explicit null works cleanly
        db.execute_write(
            "updateOutput",
            &json!({ "id": oid, "update": { "spentBy": 99, "spendable": false } }),
            None,
        )
        .unwrap();
        db.execute_write(
            "updateOutput",
            &json!({ "id": oid, "update": { "spentBy": Value::Null, "spendable": true } }),
            None,
        )
        .unwrap();
        let restored = db
            .execute_read(
                "findOutputs",
                &json!({ "partial": { "outputId": oid }, "noScript": true }),
                None,
            )
            .unwrap();
        assert_eq!(restored[0]["spendable"], true);
        assert!(restored[0].get("spentBy").is_none());

        // Read cash summary in one query
        let summary = db
            .execute_read("readCashSummary", &json!({ "identityKey": "021122" }), None)
            .unwrap();
        assert_eq!(summary["sats"], 5000);
        assert_eq!(summary["outputCount"], 1);
        assert!(summary["next"].is_null());

        mgr.drop_all_data("wallet-test-1").unwrap();
    }

    #[test]
    fn list_outputs_fast_1000_items_under_25ms_and_concurrent_wal_reads() {
        let mgr = tmp_manager("perf");
        let db = mgr.get_or_open("wallet-perf").unwrap();
        let trx = db.begin_tx().unwrap();
        let uid = db
            .execute_write(
                "insertUser",
                &json!({ "row": { "identityKey": "02perf", "activeStorage": "s1" } }),
                Some(trx),
            )
            .unwrap()
            .as_i64()
            .unwrap();
        let bid = db
            .execute_write(
                "insertOutputBasket",
                &json!({
                    "row": {
                        "userId": uid,
                        "name": "1sat",
                        "numberOfDesiredUTXOs": 0,
                        "minimumDesiredUTXOValue": 0,
                        "isDeleted": false
                    }
                }),
                Some(trx),
            )
            .unwrap()
            .as_i64()
            .unwrap();
        let tid = db
            .execute_write(
                "insertOutputTag",
                &json!({ "row": { "userId": uid, "tag": "type:image/png", "isDeleted": false } }),
                Some(trx),
            )
            .unwrap()
            .as_i64()
            .unwrap();
        let tx_id = db
            .execute_write(
                "insertTransaction",
                &json!({
                    "row": {
                        "userId": uid,
                        "status": "completed",
                        "reference": "batch-1",
                        "isOutgoing": false,
                        "satoshis": 1000,
                        "description": "items",
                        "txid": "beef01"
                    }
                }),
                Some(trx),
            )
            .unwrap()
            .as_i64()
            .unwrap();

        for i in 0..1000i64 {
            let oid = db
                .execute_write(
                    "insertOutput",
                    &json!({
                        "row": {
                            "userId": uid,
                            "transactionId": tx_id,
                            "basketId": bid,
                            "spendable": true,
                            "change": false,
                            "outputDescription": "item",
                            "vout": i,
                            "satoshis": 1,
                            "providedBy": "you",
                            "purpose": "",
                            "type": "custom",
                            "txid": "beef01"
                        }
                    }),
                    Some(trx),
                )
                .unwrap()
                .as_i64()
                .unwrap();
            db.execute_write(
                "insertOutputTagMap",
                &json!({ "row": { "outputTagId": tid, "outputId": oid, "isDeleted": false } }),
                Some(trx),
            )
            .unwrap();
        }
        db.commit_tx(trx).unwrap();

        // Now time a full 500-item newest-first listOutputsFast with tags included!
        let started = Instant::now();
        let page = db
            .execute_read(
                "listOutputsFast",
                &json!({
                    "userId": uid,
                    "basket": "1sat",
                    "limit": 500,
                    "offset": -1,
                    "includeTags": true
                }),
                None,
            )
            .unwrap();
        let elapsed = started.elapsed();
        assert_eq!(page["totalOutputs"], 1000);
        assert_eq!(page["outputs"].as_array().unwrap().len(), 500);
        assert_eq!(page["outputs"][0]["tags"][0], "type:image/png");
        assert!(
            elapsed.as_millis() < 250,
            "listOutputsFast took {}ms (expected well under 250ms)",
            elapsed.as_millis()
        );

        // Concurrent WAL read while a write transaction is open must NOT block!
        let wtx = db.begin_tx().unwrap();
        let _new_tx = db
            .execute_write(
                "insertTransaction",
                &json!({
                    "row": {
                        "userId": uid,
                        "status": "sending",
                        "reference": "uncommitted-ref",
                        "isOutgoing": true,
                        "satoshis": -10,
                        "description": "wip"
                    }
                }),
                Some(wtx),
            )
            .unwrap();
        // Outside reader sees committed snapshot (1 tx), NOT blocked by writer!
        let outside = db
            .execute_read("countTransactions", &json!({ "partial": { "userId": uid } }), None)
            .unwrap();
        assert_eq!(outside, 1);
        // Inside tx sees uncommitted write (2 txs)!
        let inside = db
            .execute_read(
                "countTransactions",
                &json!({ "partial": { "userId": uid } }),
                Some(wtx),
            )
            .unwrap();
        assert_eq!(inside, 2);
        db.rollback_tx(wtx).unwrap();
        let after_rb = db
            .execute_read("countTransactions", &json!({ "partial": { "userId": uid } }), None)
            .unwrap();
        assert_eq!(after_rb, 1);

        mgr.drop_all_data("wallet-perf").unwrap();
    }

    #[test]
    fn allocate_change_cas_and_proof_purge_are_atomic() {
        let mgr = tmp_manager("atomic");
        let db = mgr.get_or_open("wallet-atomic").unwrap();
        let uid = db
            .execute_write(
                "insertUser",
                &json!({ "row": { "identityKey": "02atom", "activeStorage": "s" } }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();
        let bid = db
            .execute_write(
                "insertOutputBasket",
                &json!({
                    "row": {
                        "userId": uid,
                        "name": "default",
                        "numberOfDesiredUTXOs": 32,
                        "minimumDesiredUTXOValue": 10000,
                        "isDeleted": false
                    }
                }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();
        let tx_id = db
            .execute_write(
                "insertTransaction",
                &json!({
                    "row": {
                        "userId": uid,
                        "status": "completed",
                        "reference": "r-atom",
                        "isOutgoing": false,
                        "satoshis": 3500,
                        "description": "in",
                        "txid": "cccc",
                        "noSendExpiryState": "armed"
                    }
                }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();

        for (vout, sats) in [(0, 500), (1, 1000), (2, 2000)] {
            db.execute_write(
                "insertOutput",
                &json!({
                    "row": {
                        "userId": uid,
                        "transactionId": tx_id,
                        "basketId": bid,
                        "spendable": true,
                        "change": true,
                        "outputDescription": "c",
                        "vout": vout,
                        "satoshis": sats,
                        "providedBy": "storage",
                        "purpose": "change",
                        "type": "P2PKH",
                        "txid": "cccc",
                        "derivationPrefix": "dp",
                        "derivationSuffix": "ds",
                        "lockingScriptB64": BASE64.encode([0x76u8, 0xa9])
                    }
                }),
                None,
            )
            .unwrap();
        }

        // Exact match 1000 wins
        let picked = db
            .execute_write(
                "allocateChangeInput",
                &json!({
                    "userId": uid,
                    "basketId": bid,
                    "targetSatoshis": 800,
                    "exactSatoshis": 1000,
                    "excludeSending": false,
                    "transactionId": 77
                }),
                None,
            )
            .unwrap();
        assert_eq!(picked["satoshis"], 1000);
        assert_eq!(
            BASE64
                .decode(picked["lockingScriptB64"].as_str().unwrap())
                .unwrap(),
            vec![0x76, 0xa9]
        );

        // Next pick for target 800 picks least-over (2000)
        let picked2 = db
            .execute_write(
                "allocateChangeInput",
                &json!({
                    "userId": uid,
                    "basketId": bid,
                    "targetSatoshis": 800,
                    "excludeSending": false,
                    "transactionId": 78
                }),
                None,
            )
            .unwrap();
        assert_eq!(picked2["satoshis"], 2000);

        // CAS succeeds once, fails on repeat
        assert_eq!(
            db.execute_write(
                "compareAndSetNoSendExpiryState",
                &json!({ "transactionId": tx_id, "expected": "armed", "next": "reclaiming" }),
                None,
            )
            .unwrap(),
            true
        );
        assert_eq!(
            db.execute_write(
                "compareAndSetNoSendExpiryState",
                &json!({ "transactionId": tx_id, "expected": "armed", "next": "expired" }),
                None,
            )
            .unwrap(),
            false
        );

        // Proof request purge deletes only retired completed reqs backed by proven_txs
        let ptx_id = db
            .execute_write(
                "insertProvenTx",
                &json!({
                    "row": {
                        "txid": "cccc",
                        "height": 850001,
                        "index": 0,
                        "merklePathB64": BASE64.encode([9u8]),
                        "rawTxB64": BASE64.encode([1u8, 2, 3, 4]),
                        "blockHash": "bh",
                        "merkleRoot": "mr"
                    }
                }),
                None,
            )
            .unwrap()
            .as_i64()
            .unwrap();
        db.execute_write(
            "insertProvenTxReq",
            &json!({
                "row": {
                    "created_at": "2020-01-01T00:00:00.000Z",
                    "updated_at": "2020-01-01T00:00:00.000Z",
                    "provenTxId": ptx_id,
                    "status": "completed",
                    "attempts": 1,
                    "notified": true,
                    "txid": "cccc",
                    "history": "{\"notes\":[]}",
                    "notify": "{}",
                    "rawTxB64": BASE64.encode([1u8, 2, 3, 4])
                }
            }),
            None,
        )
        .unwrap();
        let purged = db
            .execute_write(
                "purgeRetiredProofReqs",
                &json!({ "cutoff": "2025-01-01T00:00:00.000Z" }),
                None,
            )
            .unwrap();
        assert_eq!(purged["purged"], 1);
        assert_eq!(
            db.execute_read("countProvenTxReqs", &json!({ "partial": {} }), None)
                .unwrap(),
            0
        );

        mgr.drop_all_data("wallet-atomic").unwrap();
    }
}
