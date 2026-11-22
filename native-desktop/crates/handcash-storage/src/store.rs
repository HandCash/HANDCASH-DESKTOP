// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Per-account SQLite WAL store: 1 dedicated writer + concurrent read-only pool.

use crate::schema;
use handcash_primitives::encoding::{encode_hex, sha256};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Maximum rows returned per read slice so UI pages are always bounded and instant.
pub const MAX_PAGE_SLICE: usize = 100;

#[derive(Debug)]
pub enum StorageError {
    Sql(rusqlite::Error),
    Io(std::io::Error),
    Conflict(String),
    InvalidInput(String),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(e) => write!(f, "sqlite error: {e}"),
            Self::Io(e) => write!(f, "storage io error: {e}"),
            Self::Conflict(msg) => write!(f, "storage conflict: {msg}"),
            Self::InvalidInput(msg) => write!(f, "invalid storage input: {msg}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UtxoState {
    Spendable,
    Reserved,
    UnconfirmedChange,
    Spent,
    Quarantined,
}

impl UtxoState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spendable => "spendable",
            Self::Reserved => "reserved",
            Self::UnconfirmedChange => "unconfirmed_change",
            Self::Spent => "spent",
            Self::Quarantined => "quarantined",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "spendable" => Some(Self::Spendable),
            "reserved" => Some(Self::Reserved),
            "unconfirmed_change" => Some(Self::UnconfirmedChange),
            "spent" => Some(Self::Spent),
            "quarantined" => Some(Self::Quarantined),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoRecord {
    pub outpoint: String,
    pub txid: String,
    pub vout: u32,
    pub satoshis: u64,
    pub basket: String,
    pub state: UtxoState,
    pub is_change: bool,
    pub derivation_json: Option<String>,
    pub script_blob_hash: Option<String>,
    pub spent_by_txid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceBreakdown {
    pub spendable_sats: u64,
    pub pending_change_sats: u64,
    pub displayed_sats: u64,
    pub spendable_utxo_count: u64,
    pub item_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCardRow {
    pub outpoint: String,
    pub origin_outpoint: String,
    pub basket: String,
    pub authenticity_status: String,
    pub authenticity_reason: Option<String>,
    pub verified_at_ms: Option<u64>,
    pub issuer_key: Option<String>,
    pub name: String,
    pub mime: String,
    pub art_blob_hash: Option<String>,
    pub sort_key: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCardPage {
    pub items: Vec<ItemCardRow>,
    pub next_cursor: Option<(i64, String)>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub activity_id: String,
    pub txid: Option<String>,
    pub kind: String,
    pub direction: String,
    pub satoshis: i64,
    pub status: String,
    pub title: String,
    pub counterparty: Option<String>,
    pub app_origin: Option<String>,
    pub sort_ts_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub rows: Vec<ActivityRow>,
    pub next_cursor: Option<(i64, String)>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewOutputSpec {
    pub vout: u32,
    pub satoshis: u64,
    pub basket: String,
    pub is_change: bool,
    pub derivation_json: Option<String>,
    pub script_bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct CommitSignedTx {
    pub intent_id: String,
    pub txid: String,
    pub description: String,
    pub kind: String,
    pub net_satoshis: i64,
    pub fee_sats: u64,
    pub counterparty: Option<String>,
    pub app_origin: Option<String>,
    pub spent_outpoints: Vec<String>,
    pub new_outputs: Vec<NewOutputSpec>,
    pub raw_tx: Vec<u8>,
    pub atomic_beef: Vec<u8>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    pub id: String,
    pub kind: String,
    pub txid: Option<String>,
    pub payload_blob_hash: String,
    pub attempts: u32,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactRecord {
    pub fact_id: String,
    pub kind: String,
    pub subject: String,
    pub body_json: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactSegment {
    pub segment_id: String,
    pub root_hash: String,
    pub fact_count: u64,
    pub sealed_at_ms: i64,
    pub uploaded_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockHeaderRow {
    pub height: u64,
    pub hash: String,
    pub version: u32,
    pub previous_hash: String,
    pub merkle_root: String,
    pub time: u32,
    pub bits: u32,
    pub nonce: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofRequestRow {
    pub txid: String,
    pub state: String,
    pub attempts: u32,
    pub next_retry_at_ms: i64,
}

/// Per-account SQLite WAL database with 1 serialized writer and N concurrent readers.
pub struct AccountStore {
    db_path: PathBuf,
    writer: Mutex<Connection>,
    readers: Vec<Mutex<Connection>>,
    next_reader: AtomicUsize,
}

impl AccountStore {
    /// Open or initialize an account database at `db_path` with `read_pool_size` concurrent readers.
    pub fn open(db_path: impl AsRef<Path>, read_pool_size: usize) -> Result<Self, StorageError> {
        let db_path = db_path.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }

        let writer = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        schema::configure_writer(&writer)?;
        schema::migrate(&writer)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600));
        }

        let pool_len = read_pool_size.clamp(1, 8);
        let mut readers = Vec::with_capacity(pool_len);
        for _ in 0..pool_len {
            let reader = Connection::open_with_flags(
                &db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            schema::configure_reader(&reader)?;
            readers.push(Mutex::new(reader));
        }

        Ok(Self {
            db_path,
            writer: Mutex::new(writer),
            readers,
            next_reader: AtomicUsize::new(0),
        })
    }

    pub fn path(&self) -> &Path {
        &self.db_path
    }

    fn with_reader<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let idx = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let conn = self.readers[idx]
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        f(&conn)
    }

    pub(crate) fn with_writer<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut conn)
    }

    /// Store an immutable content-addressed blob once, returning its lowercase SHA-256 hex key.
    pub fn put_blob(&self, kind: &str, data: &[u8], now_ms: i64) -> Result<String, StorageError> {
        let hash = encode_hex(&sha256(data));
        self.with_writer(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![hash, kind, data.len() as i64, data, now_ms],
            )?;
            Ok(hash)
        })
    }

    /// Read a cold blob by its SHA-256 hash using the concurrent read pool.
    pub fn get_blob(&self, sha256_hex: &str) -> Result<Option<Vec<u8>>, StorageError> {
        self.with_reader(|conn| {
            let bytes = conn
                .query_row(
                    "SELECT data FROM blobs WHERE sha256 = ?1",
                    [sha256_hex],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()?;
            Ok(bytes)
        })
    }

    /// Look up the local BEEF or raw transaction bytes for a txid from cold storage.
    pub fn get_tx_source_bytes(&self, txid: &str) -> Result<Option<(String, Vec<u8>)>, StorageError> {
        let key = txid.trim().to_ascii_lowercase();
        self.with_reader(|conn| {
            let hashes: Option<(Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT beef_blob_hash, raw_blob_hash FROM transactions WHERE txid = ?1",
                    [&key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((beef_hash, raw_hash)) = hashes else {
                return Ok(None);
            };
            if let Some(h) = beef_hash {
                if let Some(bytes) = conn
                    .query_row("SELECT data FROM blobs WHERE sha256 = ?1", [&h], |r| {
                        r.get::<_, Vec<u8>>(0)
                    })
                    .optional()?
                {
                    return Ok(Some(("beef".into(), bytes)));
                }
            }
            if let Some(h) = raw_hash {
                if let Some(bytes) = conn
                    .query_row("SELECT data FROM blobs WHERE sha256 = ?1", [&h], |r| {
                        r.get::<_, Vec<u8>>(0)
                    })
                    .optional()?
                {
                    return Ok(Some(("raw".into(), bytes)));
                }
            }
            Ok(None)
        })
    }

    /// Instant indexed balance breakdown (<1 ms; never scans scripts or blobs).
    pub fn balance_summary(&self) -> Result<BalanceBreakdown, StorageError> {
        self.with_reader(|conn| {
            let (spendable, spendable_count): (i64, i64) = conn.query_row(
                "SELECT COALESCE(SUM(satoshis), 0), COUNT(*)
                 FROM utxos
                 WHERE is_change = 1 AND state = 'spendable'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let pending_change: i64 = conn.query_row(
                "SELECT COALESCE(SUM(satoshis), 0)
                 FROM utxos
                 WHERE is_change = 1 AND state = 'unconfirmed_change'",
                [],
                |r| r.get(0),
            )?;
            let item_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM items i
                 JOIN utxos u ON u.outpoint = i.outpoint
                 WHERE u.state IN ('spendable', 'reserved', 'unconfirmed_change')",
                [],
                |r| r.get(0),
            )?;
            let spendable_u64 = spendable.max(0) as u64;
            let pending_u64 = pending_change.max(0) as u64;
            Ok(BalanceBreakdown {
                spendable_sats: spendable_u64,
                pending_change_sats: pending_u64,
                displayed_sats: spendable_u64.saturating_add(pending_u64),
                spendable_utxo_count: spendable_count.max(0) as u64,
                item_count: item_count.max(0) as u64,
            })
        })
    }

    /// Bounded keyset-paginated item catalog read (clamped to `MAX_PAGE_SLICE = 100`).
    pub fn read_items_page(
        &self,
        basket: &str,
        cursor: Option<(i64, &str)>,
        requested_limit: usize,
    ) -> Result<ItemCardPage, StorageError> {
        let limit = requested_limit.clamp(1, MAX_PAGE_SLICE) as i64;
        self.with_reader(|conn| {
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) FROM items i
                 JOIN utxos u ON u.outpoint = i.outpoint
                 WHERE i.basket = ?1 AND u.state IN ('spendable', 'reserved', 'unconfirmed_change')",
                [basket],
                |r| r.get(0),
            )?;

            let mut rows_out = Vec::new();
            let fetch_limit = limit + 1;
            if let Some((sort_key, outpoint)) = cursor {
                let mut stmt = conn.prepare(
                    "SELECT i.outpoint, i.origin_outpoint, i.basket, i.authenticity_status,
                            i.authenticity_reason, i.verified_at_ms, i.issuer_key,
                            i.name, i.mime, i.art_blob_hash, i.sort_key
                     FROM items i
                     JOIN utxos u ON u.outpoint = i.outpoint
                     WHERE i.basket = ?1
                       AND u.state IN ('spendable', 'reserved', 'unconfirmed_change')
                       AND (i.sort_key < ?2 OR (i.sort_key = ?2 AND i.outpoint < ?3))
                     ORDER BY i.sort_key DESC, i.outpoint DESC
                     LIMIT ?4",
                )?;
                let iter = stmt.query_map(params![basket, sort_key, outpoint, fetch_limit], map_item_row)?;
                for row in iter {
                    rows_out.push(row?);
                }
            } else {
                let mut stmt = conn.prepare(
                    "SELECT i.outpoint, i.origin_outpoint, i.basket, i.authenticity_status,
                            i.authenticity_reason, i.verified_at_ms, i.issuer_key,
                            i.name, i.mime, i.art_blob_hash, i.sort_key
                     FROM items i
                     JOIN utxos u ON u.outpoint = i.outpoint
                     WHERE i.basket = ?1
                       AND u.state IN ('spendable', 'reserved', 'unconfirmed_change')
                     ORDER BY i.sort_key DESC, i.outpoint DESC
                     LIMIT ?2",
                )?;
                let iter = stmt.query_map(params![basket, fetch_limit], map_item_row)?;
                for row in iter {
                    rows_out.push(row?);
                }
            }

            let has_more = rows_out.len() > limit as usize;
            if has_more {
                rows_out.truncate(limit as usize);
            }
            let next_cursor = if has_more {
                rows_out
                    .last()
                    .map(|last| (last.sort_key, last.outpoint.clone()))
            } else {
                None
            };
            Ok(ItemCardPage {
                items: rows_out,
                next_cursor,
                total: total.max(0) as u64,
            })
        })
    }

    /// Bounded keyset-paginated Activity feed read (clamped to `MAX_PAGE_SLICE = 100`).
    pub fn read_activity_page(
        &self,
        cursor: Option<(i64, &str)>,
        requested_limit: usize,
    ) -> Result<ActivityPage, StorageError> {
        let limit = requested_limit.clamp(1, MAX_PAGE_SLICE) as i64;
        self.with_reader(|conn| {
            let total: i64 = conn.query_row("SELECT COUNT(*) FROM activity_view", [], |r| r.get(0))?;
            let mut rows_out = Vec::new();
            let fetch_limit = limit + 1;

            if let Some((sort_ts, act_id)) = cursor {
                let mut stmt = conn.prepare(
                    "SELECT activity_id, txid, kind, direction, satoshis, status,
                            title, counterparty, app_origin, sort_ts_ms
                     FROM activity_view
                     WHERE sort_ts_ms < ?1 OR (sort_ts_ms = ?1 AND activity_id < ?2)
                     ORDER BY sort_ts_ms DESC, activity_id DESC
                     LIMIT ?3",
                )?;
                let iter = stmt.query_map(params![sort_ts, act_id, fetch_limit], map_activity_row)?;
                for row in iter {
                    rows_out.push(row?);
                }
            } else {
                let mut stmt = conn.prepare(
                    "SELECT activity_id, txid, kind, direction, satoshis, status,
                            title, counterparty, app_origin, sort_ts_ms
                     FROM activity_view
                     ORDER BY sort_ts_ms DESC, activity_id DESC
                     LIMIT ?1",
                )?;
                let iter = stmt.query_map(params![fetch_limit], map_activity_row)?;
                for row in iter {
                    rows_out.push(row?);
                }
            }

            let has_more = rows_out.len() > limit as usize;
            if has_more {
                rows_out.truncate(limit as usize);
            }
            let next_cursor = if has_more {
                rows_out
                    .last()
                    .map(|last| (last.sort_ts_ms, last.activity_id.clone()))
            } else {
                None
            };
            Ok(ActivityPage {
                rows: rows_out,
                next_cursor,
                total: total.max(0) as u64,
            })
        })
    }

    /// Insert or update a UTXO row (used by chain ingest and bootstrap import).
    pub fn upsert_utxo(&self, rec: &UtxoRecord, now_ms: i64) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "INSERT INTO utxos (
                    outpoint, txid, vout, satoshis, basket, state, is_change,
                    derivation_json, script_blob_hash, spent_by_txid, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
                 ON CONFLICT(outpoint) DO UPDATE SET
                    state = CASE WHEN utxos.state = 'spent' THEN 'spent' ELSE excluded.state END,
                    spent_by_txid = COALESCE(utxos.spent_by_txid, excluded.spent_by_txid),
                    derivation_json = COALESCE(excluded.derivation_json, utxos.derivation_json),
                    script_blob_hash = COALESCE(excluded.script_blob_hash, utxos.script_blob_hash),
                    updated_at_ms = excluded.updated_at_ms",
                params![
                    rec.outpoint,
                    rec.txid,
                    rec.vout,
                    rec.satoshis as i64,
                    rec.basket,
                    rec.state.as_str(),
                    if rec.is_change { 1 } else { 0 },
                    rec.derivation_json,
                    rec.script_blob_hash,
                    rec.spent_by_txid,
                    now_ms,
                ],
            )?;
            Ok(())
        })
    }

    /// Insert or update an item catalog row.
    /// Enforces `proven-means-proven`: never downgrades `proven_brc150` back to `unproven`.
    pub fn upsert_item(&self, item: &ItemCardRow, now_ms: i64) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "INSERT INTO items (
                    outpoint, origin_outpoint, basket, authenticity_status, authenticity_reason,
                    verified_at_ms, issuer_key, name, mime, art_blob_hash, sort_key, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(outpoint) DO UPDATE SET
                    authenticity_status = CASE
                        WHEN items.authenticity_status = 'proven_brc150' THEN 'proven_brc150'
                        ELSE excluded.authenticity_status
                    END,
                    authenticity_reason = CASE
                        WHEN items.authenticity_status = 'proven_brc150' THEN NULL
                        ELSE excluded.authenticity_reason
                    END,
                    verified_at_ms = COALESCE(items.verified_at_ms, excluded.verified_at_ms),
                    issuer_key = COALESCE(excluded.issuer_key, items.issuer_key),
                    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE items.name END,
                    mime = CASE WHEN excluded.mime != '' THEN excluded.mime ELSE items.mime END,
                    art_blob_hash = COALESCE(excluded.art_blob_hash, items.art_blob_hash),
                    updated_at_ms = excluded.updated_at_ms",
                params![
                    item.outpoint,
                    item.origin_outpoint,
                    item.basket,
                    item.authenticity_status,
                    item.authenticity_reason,
                    item.verified_at_ms.map(|v| v as i64),
                    item.issuer_key,
                    item.name,
                    item.mime,
                    item.art_blob_hash,
                    item.sort_key,
                    now_ms,
                ],
            )?;
            Ok(())
        })
    }

    /// Atomically reserve UTXOs for a spend intent (`BEGIN IMMEDIATE`).
    /// Expires stale reservations first; fails closed if any input is unavailable.
    pub fn reserve_utxos(
        &self,
        intent_id: &str,
        outpoints: &[String],
        now_ms: i64,
        ttl_ms: i64,
    ) -> Result<Vec<UtxoRecord>, StorageError> {
        if intent_id.trim().is_empty() || outpoints.is_empty() {
            return Err(StorageError::InvalidInput(
                "intent_id and outpoints must be non-empty".into(),
            ));
        }
        let expires_at = now_ms.saturating_add(ttl_ms.max(1_000));
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            // Release expired unsigned reservations only (never thaws quarantined/spent).
            tx.execute(
                "UPDATE utxos
                 SET state = 'spendable', lock_owner = NULL, lock_expires_at_ms = NULL, updated_at_ms = ?1
                 WHERE state = 'reserved' AND lock_expires_at_ms IS NOT NULL AND lock_expires_at_ms <= ?1",
                [now_ms],
            )?;

            struct ReservableRow {
                txid: String,
                vout: u32,
                satoshis: i64,
                basket: String,
                state: String,
                is_change: i64,
                derivation_json: Option<String>,
                script_blob_hash: Option<String>,
                lock_owner: Option<String>,
            }
            let mut reserved = Vec::with_capacity(outpoints.len());
            for op in outpoints {
                let row: Option<ReservableRow> = tx
                    .query_row(
                        "SELECT txid, vout, satoshis, basket, state, is_change, derivation_json, script_blob_hash, lock_owner
                         FROM utxos WHERE outpoint = ?1",
                        [op],
                        |r| {
                            Ok(ReservableRow {
                                txid: r.get(0)?,
                                vout: r.get(1)?,
                                satoshis: r.get(2)?,
                                basket: r.get(3)?,
                                state: r.get(4)?,
                                is_change: r.get(5)?,
                                derivation_json: r.get(6)?,
                                script_blob_hash: r.get(7)?,
                                lock_owner: r.get(8)?,
                            })
                        },
                    )
                    .optional()?;
                let Some(row) = row else {
                    return Err(StorageError::Conflict(format!("utxo not found: {op}")));
                };
                if row.state != "spendable" && row.state != "unconfirmed_change" {
                    return Err(StorageError::Conflict(format!(
                        "utxo {op} is not reservable (state={}, owner={:?})",
                        row.state, row.lock_owner
                    )));
                }
                tx.execute(
                    "UPDATE utxos
                     SET state = 'reserved', lock_owner = ?1, lock_expires_at_ms = ?2, updated_at_ms = ?3
                     WHERE outpoint = ?4",
                    params![intent_id, expires_at, now_ms, op],
                )?;
                reserved.push(UtxoRecord {
                    outpoint: op.clone(),
                    txid: row.txid,
                    vout: row.vout,
                    satoshis: row.satoshis.max(0) as u64,
                    basket: row.basket,
                    state: UtxoState::Reserved,
                    is_change: row.is_change != 0,
                    derivation_json: row.derivation_json,
                    script_blob_hash: row.script_blob_hash,
                    spent_by_txid: None,
                });
            }
            tx.commit()?;
            Ok(reserved)
        })
    }

    /// Release an unsigned reservation (only touches rows still locked by `intent_id`).
    pub fn release_reservation(&self, intent_id: &str, now_ms: i64) -> Result<usize, StorageError> {
        self.with_writer(|conn| {
            let changed = conn.execute(
                "UPDATE utxos
                 SET state = 'spendable', lock_owner = NULL, lock_expires_at_ms = NULL, updated_at_ms = ?1
                 WHERE state = 'reserved' AND lock_owner = ?2",
                params![now_ms, intent_id],
            )?;
            Ok(changed)
        })
    }

    /// Atomic point-of-no-return commit for a signed transaction.
    /// Seals inputs as `spent`, inserts new outputs, writes `transactions(status='signed')`,
    /// updates `activity_view`, appends an immutable `facts` entry, and enqueues `outbox`.
    pub fn commit_signed_tx(&self, commit: &CommitSignedTx) -> Result<String, StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let raw_hash = encode_hex(&sha256(&commit.raw_tx));
            let beef_hash = encode_hex(&sha256(&commit.atomic_beef));
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                 VALUES (?1, 'raw_tx', ?2, ?3, ?4)",
                params![raw_hash, commit.raw_tx.len() as i64, commit.raw_tx, commit.now_ms],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                 VALUES (?1, 'beef', ?2, ?3, ?4)",
                params![
                    beef_hash,
                    commit.atomic_beef.len() as i64,
                    commit.atomic_beef,
                    commit.now_ms
                ],
            )?;

            // Verify every spent input is owned by this reservation (or spendable) and mark spent.
            for op in &commit.spent_outpoints {
                let updated = tx.execute(
                    "UPDATE utxos
                     SET state = 'spent', spent_by_txid = ?1, lock_owner = NULL,
                         lock_expires_at_ms = NULL, updated_at_ms = ?2
                     WHERE outpoint = ?3
                       AND (lock_owner = ?4 OR state IN ('spendable', 'unconfirmed_change'))",
                    params![commit.txid, commit.now_ms, op, commit.intent_id],
                )?;
                if updated == 0 {
                    return Err(StorageError::Conflict(format!(
                        "cannot seal input {op}: not reserved by {}",
                        commit.intent_id
                    )));
                }
            }

            // Record transaction as 'signed'.
            tx.execute(
                "INSERT INTO transactions (
                    txid, status, is_outgoing, satoshis, fee_sats, description,
                    raw_blob_hash, beef_blob_hash, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'signed', 1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(txid) DO UPDATE SET
                    status = CASE WHEN transactions.status = 'mined' THEN 'mined' ELSE 'signed' END,
                    raw_blob_hash = COALESCE(transactions.raw_blob_hash, excluded.raw_blob_hash),
                    beef_blob_hash = COALESCE(transactions.beef_blob_hash, excluded.beef_blob_hash),
                    updated_at_ms = excluded.updated_at_ms",
                params![
                    commit.txid,
                    commit.net_satoshis,
                    commit.fee_sats as i64,
                    commit.description,
                    raw_hash,
                    beef_hash,
                    commit.now_ms,
                ],
            )?;

            // Insert new change / wallet outputs.
            for out in &commit.new_outputs {
                let script_hash = if let Some(script) = &out.script_bytes {
                    let h = encode_hex(&sha256(script));
                    tx.execute(
                        "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                         VALUES (?1, 'script', ?2, ?3, ?4)",
                        params![h, script.len() as i64, script, commit.now_ms],
                    )?;
                    Some(h)
                } else {
                    None
                };
                let outpoint = format!("{}.{}", commit.txid, out.vout);
                let state = if out.is_change {
                    UtxoState::UnconfirmedChange
                } else {
                    UtxoState::Spendable
                };
                tx.execute(
                    "INSERT OR REPLACE INTO utxos (
                        outpoint, txid, vout, satoshis, basket, state, is_change,
                        derivation_json, script_blob_hash, created_at_ms, updated_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                    params![
                        outpoint,
                        commit.txid,
                        out.vout,
                        out.satoshis as i64,
                        out.basket,
                        state.as_str(),
                        if out.is_change { 1 } else { 0 },
                        out.derivation_json,
                        script_hash,
                        commit.now_ms,
                    ],
                )?;
            }

            // Update materialized Activity view atomically.
            let act_id = format!("tx:{}", commit.txid);
            tx.execute(
                "INSERT OR REPLACE INTO activity_view (
                    activity_id, txid, kind, direction, satoshis, status,
                    title, counterparty, app_origin, sort_ts_ms
                 ) VALUES (?1, ?2, ?3, 'out', ?4, 'signed', ?5, ?6, ?7, ?8)",
                params![
                    act_id,
                    commit.txid,
                    commit.kind,
                    commit.net_satoshis,
                    commit.description,
                    commit.counterparty,
                    commit.app_origin,
                    commit.now_ms,
                ],
            )?;

            // Track lightweight proof request (no blob duplication).
            tx.execute(
                "INSERT OR IGNORE INTO proof_requests (txid, state, attempts, next_retry_at_ms, notified, updated_at_ms)
                 VALUES (?1, 'pending', 0, ?2, 0, ?2)",
                params![commit.txid, commit.now_ms],
            )?;

            // Enqueue durable broadcast job.
            let outbox_id = format!("broadcast:{}", commit.txid);
            tx.execute(
                "INSERT OR IGNORE INTO outbox (id, kind, txid, payload_blob_hash, attempts, next_retry_at_ms, status, created_at_ms, updated_at_ms)
                 VALUES (?1, 'broadcast', ?2, ?3, 0, ?4, 'queued', ?4, ?4)",
                params![outbox_id, commit.txid, beef_hash, commit.now_ms],
            )?;

            // Append immutable content-addressed fact.
            let fact_body = serde_json::json!({
                "txid": commit.txid,
                "kind": commit.kind,
                "feeSats": commit.fee_sats,
                "spentOutpoints": commit.spent_outpoints,
                "beefHash": beef_hash,
            })
            .to_string();
            let fact_id = insert_fact_in_tx(&tx, "tx_signed", &commit.txid, &fact_body, commit.now_ms)?;

            tx.commit()?;
            Ok(fact_id)
        })
    }

    /// Mark a transaction SPV-mined, promote its unconfirmed change to spendable,
    /// store the BUMP once by hash, and immediately prune the retired proof request.
    pub fn mark_tx_mined(
        &self,
        txid: &str,
        block_height: u64,
        merkle_root: &str,
        bump_bytes: &[u8],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let bump_hash = encode_hex(&sha256(bump_bytes));
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                 VALUES (?1, 'bump', ?2, ?3, ?4)",
                params![bump_hash, bump_bytes.len() as i64, bump_bytes, now_ms],
            )?;
            tx.execute(
                "UPDATE transactions
                 SET status = 'mined', block_height = ?1, merkle_root = ?2,
                     bump_blob_hash = ?3, updated_at_ms = ?4
                 WHERE txid = ?5",
                params![block_height as i64, merkle_root, bump_hash, now_ms, txid],
            )?;
            tx.execute(
                "UPDATE utxos
                 SET state = 'spendable', updated_at_ms = ?1
                 WHERE txid = ?2 AND state = 'unconfirmed_change'",
                params![now_ms, txid],
            )?;
            tx.execute(
                "UPDATE activity_view SET status = 'mined' WHERE txid = ?1",
                [txid],
            )?;
            // Auto-prune proof_requests once mined — prevents multi-MB proof-req bloat forever.
            tx.execute("DELETE FROM proof_requests WHERE txid = ?1", [txid])?;

            let fact_body = serde_json::json!({
                "txid": txid,
                "blockHeight": block_height,
                "merkleRoot": merkle_root,
                "bumpHash": bump_hash,
            })
            .to_string();
            insert_fact_in_tx(&tx, "tx_mined", txid, &fact_body, now_ms)?;
            tx.commit()?;
            Ok(())
        })
    }

    /// Append an immutable fact (idempotent by SHA-256 content address).
    pub fn append_fact(
        &self,
        kind: &str,
        subject: &str,
        body_json: &str,
        now_ms: i64,
    ) -> Result<String, StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let id = insert_fact_in_tx(&tx, kind, subject, body_json, now_ms)?;
            tx.commit()?;
            Ok(id)
        })
    }

    /// Merge remote facts by pure set union (`INSERT OR IGNORE`); returns count of newly added facts.
    pub fn merge_facts(&self, incoming: &[FactRecord]) -> Result<usize, StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut next_seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM facts",
                [],
                |r| r.get(0),
            )?;
            let mut added = 0usize;
            for fact in incoming {
                let changed = tx.execute(
                    "INSERT OR IGNORE INTO facts (fact_id, seq, kind, subject, body_json, created_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        fact.fact_id,
                        next_seq,
                        fact.kind,
                        fact.subject,
                        fact.body_json,
                        fact.created_at_ms,
                    ],
                )?;
                if changed > 0 {
                    added += 1;
                    next_seq += 1;
                }
            }
            tx.commit()?;
            Ok(added)
        })
    }

    /// Seal up to `max_facts` unsealed facts into one immutable, tamper-evident segment.
    pub fn seal_fact_segment(
        &self,
        max_facts: usize,
        now_ms: i64,
    ) -> Result<Option<(FactSegment, Vec<FactRecord>)>, StorageError> {
        let limit = max_facts.clamp(1, 2048) as i64;
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut facts = Vec::new();
            {
                let mut stmt = tx.prepare(
                    "SELECT fact_id, kind, subject, body_json, created_at_ms
                     FROM facts WHERE segment_id IS NULL
                     ORDER BY seq ASC LIMIT ?1",
                )?;
                let iter = stmt.query_map([limit], |r| {
                    Ok(FactRecord {
                        fact_id: r.get(0)?,
                        kind: r.get(1)?,
                        subject: r.get(2)?,
                        body_json: r.get(3)?,
                        created_at_ms: r.get(4)?,
                    })
                })?;
                for row in iter {
                    facts.push(row?);
                }
            }
            if facts.is_empty() {
                return Ok(None);
            }
            let sorted_ids: BTreeSet<&str> = facts.iter().map(|f| f.fact_id.as_str()).collect();
            let mut root_input = Vec::new();
            for id in &sorted_ids {
                root_input.extend_from_slice(id.as_bytes());
                root_input.push(b'\n');
            }
            let root_hash = encode_hex(&sha256(&root_input));
            let segment_id = format!("seg-{}", &root_hash[..16]);

            tx.execute(
                "INSERT OR IGNORE INTO fact_segments (segment_id, root_hash, fact_count, sealed_at_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![segment_id, root_hash, facts.len() as i64, now_ms],
            )?;
            for f in &facts {
                tx.execute(
                    "UPDATE facts SET segment_id = ?1 WHERE fact_id = ?2",
                    params![segment_id, f.fact_id],
                )?;
            }
            tx.commit()?;
            Ok(Some((
                FactSegment {
                    segment_id,
                    root_hash,
                    fact_count: facts.len() as u64,
                    sealed_at_ms: now_ms,
                    uploaded_at_ms: None,
                },
                facts,
            )))
        })
    }

    /// List queued outbox entries ready for delivery.
    pub fn list_due_outbox(&self, now_ms: i64, limit: usize) -> Result<Vec<OutboxEntry>, StorageError> {
        let cap = limit.clamp(1, 100) as i64;
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, kind, txid, payload_blob_hash, attempts, status
                 FROM outbox
                 WHERE status = 'queued' AND next_retry_at_ms <= ?1
                 ORDER BY next_retry_at_ms ASC LIMIT ?2",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![now_ms, cap], |r| {
                Ok(OutboxEntry {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    txid: r.get(2)?,
                    payload_blob_hash: r.get(3)?,
                    attempts: r.get::<_, i64>(4)?.max(0) as u32,
                    status: r.get(5)?,
                })
            })? {
                out.push(row?);
            }
            Ok(out)
        })
    }

    /// Persist a PoW-verified block header in SQLite WAL.
    pub fn put_verified_header(
        &self,
        header: &BlockHeaderRow,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO block_headers (
                    height, hash, version, previous_hash, merkle_root,
                    time, bits, nonce, verified_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    header.height as i64,
                    header.hash,
                    header.version as i64,
                    header.previous_hash,
                    header.merkle_root,
                    header.time as i64,
                    header.bits as i64,
                    header.nonce as i64,
                    now_ms,
                ],
            )?;
            Ok(())
        })
    }

    /// Read a cached PoW-verified header by height using the concurrent read pool.
    pub fn get_header(&self, height: u64) -> Result<Option<BlockHeaderRow>, StorageError> {
        self.with_reader(|conn| {
            let row = conn
                .query_row(
                    "SELECT height, hash, version, previous_hash, merkle_root, time, bits, nonce
                     FROM block_headers WHERE height = ?1",
                    [height as i64],
                    |r| {
                        Ok(BlockHeaderRow {
                            height: r.get::<_, i64>(0)?.max(0) as u64,
                            hash: r.get(1)?,
                            version: r.get::<_, i64>(2)?.max(0) as u32,
                            previous_hash: r.get(3)?,
                            merkle_root: r.get(4)?,
                            time: r.get::<_, i64>(5)?.max(0) as u32,
                            bits: r.get::<_, i64>(6)?.max(0) as u32,
                            nonce: r.get::<_, i64>(7)?.max(0) as u32,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
    }

    pub fn latest_header_height(&self) -> Result<Option<u64>, StorageError> {
        self.with_reader(|conn| {
            let h: Option<i64> =
                conn.query_row("SELECT MAX(height) FROM block_headers", [], |r| r.get(0))?;
            Ok(h.map(|v| v.max(0) as u64))
        })
    }

    /// Store fetched BEEF or raw transaction bytes in cold blobs and link them on `transactions`.
    pub fn upsert_tx_blob(
        &self,
        txid: &str,
        kind: &str,
        bytes: &[u8],
        now_ms: i64,
    ) -> Result<String, StorageError> {
        let key = txid.trim().to_ascii_lowercase();
        let hash = encode_hex(&sha256(bytes));
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![hash, kind, bytes.len() as i64, bytes, now_ms],
            )?;
            let is_beef = kind == "beef";
            if is_beef {
                tx.execute(
                    "INSERT INTO transactions (txid, status, beef_blob_hash, created_at_ms, updated_at_ms)
                     VALUES (?1, 'cached', ?2, ?3, ?3)
                     ON CONFLICT(txid) DO UPDATE SET
                        beef_blob_hash = COALESCE(excluded.beef_blob_hash, transactions.beef_blob_hash),
                        updated_at_ms = excluded.updated_at_ms",
                    params![key, hash, now_ms],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO transactions (txid, status, raw_blob_hash, created_at_ms, updated_at_ms)
                     VALUES (?1, 'cached', ?2, ?3, ?3)
                     ON CONFLICT(txid) DO UPDATE SET
                        raw_blob_hash = COALESCE(excluded.raw_blob_hash, transactions.raw_blob_hash),
                        updated_at_ms = excluded.updated_at_ms",
                    params![key, hash, now_ms],
                )?;
            }
            tx.commit()?;
            Ok(hash)
        })
    }

    /// List proof requests due for polling (Lane 2 proof monitor).
    pub fn list_due_proof_requests(
        &self,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<ProofRequestRow>, StorageError> {
        let cap = limit.clamp(1, 50) as i64;
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT txid, state, attempts, next_retry_at_ms
                 FROM proof_requests
                 WHERE state != 'completed' AND next_retry_at_ms <= ?1
                 ORDER BY next_retry_at_ms ASC LIMIT ?2",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map(params![now_ms, cap], |r| {
                Ok(ProofRequestRow {
                    txid: r.get(0)?,
                    state: r.get(1)?,
                    attempts: r.get::<_, i64>(2)?.max(0) as u32,
                    next_retry_at_ms: r.get(3)?,
                })
            })? {
                out.push(row?);
            }
            Ok(out)
        })
    }

    pub fn bump_proof_request_retry(
        &self,
        txid: &str,
        next_retry_at_ms: i64,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "UPDATE proof_requests
                 SET attempts = attempts + 1, next_retry_at_ms = ?1, updated_at_ms = ?2
                 WHERE txid = ?3",
                params![next_retry_at_ms, now_ms, txid],
            )?;
            Ok(())
        })
    }

    pub fn mark_outbox_delivered(&self, id: &str, now_ms: i64) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "UPDATE outbox SET status = 'delivered', updated_at_ms = ?1 WHERE id = ?2",
                params![now_ms, id],
            )?;
            Ok(())
        })
    }

    pub fn bump_outbox_retry(
        &self,
        id: &str,
        next_retry_at_ms: i64,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "UPDATE outbox
                 SET attempts = attempts + 1, next_retry_at_ms = ?1, updated_at_ms = ?2
                 WHERE id = ?3",
                params![next_retry_at_ms, now_ms, id],
            )?;
            Ok(())
        })
    }

    /// Update transaction status without ever downgrading a `mined` transaction.
    pub fn update_tx_status(
        &self,
        txid: &str,
        status: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            conn.execute(
                "UPDATE transactions
                 SET status = CASE WHEN status = 'mined' THEN 'mined' ELSE ?1 END,
                     updated_at_ms = ?2
                 WHERE txid = ?3",
                params![status, now_ms, txid],
            )?;
            conn.execute(
                "UPDATE activity_view
                 SET status = CASE WHEN status = 'mined' THEN 'mined' ELSE ?1 END
                 WHERE txid = ?2",
                params![status, txid],
            )?;
            Ok(())
        })
    }

    /// List held `1sat` items whose BRC-150 provenance is still `unproven` (Lane 3 worker).
    pub fn list_unproven_items(&self, limit: usize) -> Result<Vec<ItemCardRow>, StorageError> {
        let cap = limit.clamp(1, 50) as i64;
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT i.outpoint, i.origin_outpoint, i.basket, i.authenticity_status,
                        i.authenticity_reason, i.verified_at_ms, i.issuer_key,
                        i.name, i.mime, i.art_blob_hash, i.sort_key
                 FROM items i
                 JOIN utxos u ON u.outpoint = i.outpoint
                 WHERE i.basket = '1sat'
                   AND i.authenticity_status != 'proven_brc150'
                   AND u.state IN ('spendable', 'reserved', 'unconfirmed_change')
                 ORDER BY i.sort_key DESC
                 LIMIT ?1",
            )?;
            let mut out = Vec::new();
            for row in stmt.query_map([cap], map_item_row)? {
                out.push(row?);
            }
            Ok(out)
        })
    }

    /// Upgrade an item to `proven_brc150` atomically after full cryptographic BRC-150 verification.
    #[allow(clippy::too_many_arguments)]
    pub fn mark_item_proven_brc150(
        &self,
        outpoint: &str,
        origin_outpoint: &str,
        content_type: &str,
        name: Option<&str>,
        issuer_key: Option<&str>,
        art_bytes: Option<&[u8]>,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.with_writer(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let art_hash = if let Some(bytes) = art_bytes.filter(|b| !b.is_empty()) {
                let h = encode_hex(&sha256(bytes));
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256, kind, byte_len, data, created_at_ms)
                     VALUES (?1, 'art', ?2, ?3, ?4)",
                    params![h, bytes.len() as i64, bytes, now_ms],
                )?;
                Some(h)
            } else {
                None
            };
            tx.execute(
                "UPDATE items
                 SET origin_outpoint = ?1,
                     authenticity_status = 'proven_brc150',
                     authenticity_reason = NULL,
                     verified_at_ms = ?2,
                     mime = CASE WHEN ?3 != '' THEN ?3 ELSE mime END,
                     name = COALESCE(?4, name),
                     issuer_key = COALESCE(?5, issuer_key),
                     art_blob_hash = COALESCE(?6, art_blob_hash),
                     updated_at_ms = ?2
                 WHERE outpoint = ?7",
                params![
                    origin_outpoint,
                    now_ms,
                    content_type,
                    name,
                    issuer_key,
                    art_hash,
                    outpoint,
                ],
            )?;
            let fact_body = serde_json::json!({
                "outpoint": outpoint,
                "originOutpoint": origin_outpoint,
                "contentType": content_type,
                "artHash": art_hash,
            })
            .to_string();
            insert_fact_in_tx(&tx, "item_proven_brc150", outpoint, &fact_body, now_ms)?;
            tx.commit()?;
            Ok(())
        })
    }
}

fn insert_fact_in_tx(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    subject: &str,
    body_json: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let canonical = format!("{kind}\0{subject}\0{body_json}");
    let fact_id = encode_hex(&sha256(canonical.as_bytes()));
    let next_seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM facts",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO facts (fact_id, seq, kind, subject, body_json, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![fact_id, next_seq, kind, subject, body_json, now_ms],
    )?;
    Ok(fact_id)
}

fn map_item_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ItemCardRow> {
    Ok(ItemCardRow {
        outpoint: r.get(0)?,
        origin_outpoint: r.get(1)?,
        basket: r.get(2)?,
        authenticity_status: r.get(3)?,
        authenticity_reason: r.get(4)?,
        verified_at_ms: r.get::<_, Option<i64>>(5)?.map(|v| v.max(0) as u64),
        issuer_key: r.get(6)?,
        name: r.get(7)?,
        mime: r.get(8)?,
        art_blob_hash: r.get(9)?,
        sort_key: r.get(10)?,
    })
}

fn map_activity_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityRow> {
    Ok(ActivityRow {
        activity_id: r.get(0)?,
        txid: r.get(1)?,
        kind: r.get(2)?,
        direction: r.get(3)?,
        satoshis: r.get(4)?,
        status: r.get(5)?,
        title: r.get(6)?,
        counterparty: r.get(7)?,
        app_origin: r.get(8)?,
        sort_ts_ms: r.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("hc-storage-{name}-{nanos}.sqlite3"))
    }

    #[test]
    fn wal_store_handles_atomic_reserve_sign_mine_and_bounded_paging() {
        let path = temp_db("lifecycle");
        let store = AccountStore::open(&path, 2).unwrap();

        // Seed 150 items + 2 change UTXOs.
        let txid0 = "11".repeat(32);
        store
            .upsert_utxo(
                &UtxoRecord {
                    outpoint: format!("{txid0}.0"),
                    txid: txid0.clone(),
                    vout: 0,
                    satoshis: 50_000,
                    basket: "default".into(),
                    state: UtxoState::Spendable,
                    is_change: true,
                    derivation_json: None,
                    script_blob_hash: None,
                    spent_by_txid: None,
                },
                1_000,
            )
            .unwrap();
        for i in 0..150u32 {
            let op = format!("{txid0}.{}", i + 1);
            store
                .upsert_utxo(
                    &UtxoRecord {
                        outpoint: op.clone(),
                        txid: txid0.clone(),
                        vout: i + 1,
                        satoshis: 1,
                        basket: "1sat".into(),
                        state: UtxoState::Spendable,
                        is_change: false,
                        derivation_json: None,
                        script_blob_hash: None,
                        spent_by_txid: None,
                    },
                    1_000 + i as i64,
                )
                .unwrap();
            store
                .upsert_item(
                    &ItemCardRow {
                        outpoint: op.clone(),
                        origin_outpoint: op,
                        basket: "1sat".into(),
                        authenticity_status: "unproven".into(),
                        authenticity_reason: Some("pending".into()),
                        verified_at_ms: None,
                        issuer_key: None,
                        name: format!("Item #{i}"),
                        mime: "image/png".into(),
                        art_blob_hash: None,
                        sort_key: 1_000 + i as i64,
                    },
                    1_000 + i as i64,
                )
                .unwrap();
        }

        let bal = store.balance_summary().unwrap();
        assert_eq!(bal.spendable_sats, 50_000);
        assert_eq!(bal.item_count, 150);

        // Keyset paging clamps 500 -> 100 and returns next cursor.
        let p1 = store.read_items_page("1sat", None, 500).unwrap();
        assert_eq!(p1.items.len(), 100);
        assert_eq!(p1.total, 150);
        let cursor = p1.next_cursor.as_ref().unwrap();
        let p2 = store
            .read_items_page("1sat", Some((cursor.0, &cursor.1)), 100)
            .unwrap();
        assert_eq!(p2.items.len(), 50);
        assert_eq!(p2.next_cursor, None);

        // Atomic reservation blocks double-reserve.
        let op0 = format!("{txid0}.0");
        store
            .reserve_utxos("intent-1", std::slice::from_ref(&op0), 2_000, 30_000)
            .unwrap();
        assert!(matches!(
            store.reserve_utxos("intent-2", std::slice::from_ref(&op0), 2_100, 30_000),
            Err(StorageError::Conflict(_))
        ));

        // Commit signed tx seals input, credits unconfirmed change, writes activity + outbox + fact.
        let spend_txid = "22".repeat(32);
        store
            .commit_signed_tx(&CommitSignedTx {
                intent_id: "intent-1".into(),
                txid: spend_txid.clone(),
                description: "Send test".into(),
                kind: "send".into(),
                net_satoshis: -10_200,
                fee_sats: 200,
                counterparty: None,
                app_origin: None,
                spent_outpoints: vec![op0.clone()],
                new_outputs: vec![NewOutputSpec {
                    vout: 1,
                    satoshis: 39_800,
                    basket: "default".into(),
                    is_change: true,
                    derivation_json: Some(r#"{"prefix":"a","suffix":"b"}"#.into()),
                    script_bytes: Some(vec![0x76, 0xa9]),
                }],
                raw_tx: vec![1, 2, 3, 4],
                atomic_beef: vec![5, 6, 7, 8],
                now_ms: 3_000,
            })
            .unwrap();

        let bal2 = store.balance_summary().unwrap();
        assert_eq!(bal2.spendable_sats, 0);
        assert_eq!(bal2.pending_change_sats, 39_800);
        assert_eq!(bal2.displayed_sats, 39_800);
        assert_eq!(store.list_due_outbox(3_000, 10).unwrap().len(), 1);
        assert_eq!(
            store.get_tx_source_bytes(&spend_txid).unwrap(),
            Some(("beef".into(), vec![5, 6, 7, 8]))
        );

        // Marking mined promotes change to spendable and prunes proof_requests.
        store
            .mark_tx_mined(&spend_txid, 900_000, &"aa".repeat(32), &[9, 9, 9], 4_000)
            .unwrap();
        let bal3 = store.balance_summary().unwrap();
        assert_eq!(bal3.spendable_sats, 39_800);
        assert_eq!(bal3.pending_change_sats, 0);

        // Facts seal cleanly and set-union merge is idempotent.
        let (seg, facts) = store.seal_fact_segment(100, 5_000).unwrap().unwrap();
        assert_eq!(seg.fact_count, 2);
        assert_eq!(store.merge_facts(&facts).unwrap(), 0);

        let _ = std::fs::remove_file(&path);
    }
}
