// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! SQLite WAL schema, PRAGMAs, and canonical UTC ISO-8601 timestamp helpers
//! for the native Desktop Wallet Toolbox storage backend (`StorageRustSqlite`).

use rusqlite::Connection;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub const TOOLBOX_SCHEMA_VERSION: &str = "1";

pub const TOOLBOX_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cold_blobs (
    hash TEXT PRIMARY KEY,
    data BLOB NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
    storage_identity_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    storage_name TEXT NOT NULL,
    chain TEXT NOT NULL,
    dbtype TEXT NOT NULL,
    max_output_script INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    identity_key TEXT NOT NULL UNIQUE,
    active_storage TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS output_baskets (
    basket_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    number_of_desired_utxos INTEGER NOT NULL,
    minimum_desired_utxo_value INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(name, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ob_user ON output_baskets(user_id);

CREATE TABLE IF NOT EXISTS proven_txs (
    proven_tx_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    txid TEXT NOT NULL UNIQUE,
    height INTEGER NOT NULL,
    tx_index INTEGER NOT NULL,
    merkle_path_hash TEXT NOT NULL,
    raw_tx_hash TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    merkle_root TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ptx_height ON proven_txs(height);

CREATE TABLE IF NOT EXISTS proven_tx_reqs (
    proven_tx_req_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    proven_tx_id INTEGER,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    txid TEXT NOT NULL UNIQUE,
    batch TEXT,
    history TEXT NOT NULL,
    notify TEXT NOT NULL,
    raw_tx_hash TEXT NOT NULL,
    input_beef_hash TEXT,
    was_broadcast INTEGER,
    rebroadcast_attempts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_preq_status ON proven_tx_reqs(status, proven_tx_req_id);
CREATE INDEX IF NOT EXISTS idx_preq_proven ON proven_tx_reqs(proven_tx_id);
CREATE INDEX IF NOT EXISTS idx_preq_batch ON proven_tx_reqs(batch);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    proven_tx_id INTEGER,
    status TEXT NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    is_outgoing INTEGER NOT NULL DEFAULT 0,
    satoshis INTEGER NOT NULL,
    description TEXT NOT NULL,
    version INTEGER,
    lock_time INTEGER,
    txid TEXT,
    input_beef_hash TEXT,
    raw_tx_hash TEXT,
    no_send_expiry_mode TEXT,
    no_send_expiry_value INTEGER,
    no_send_expiry_deadline INTEGER,
    no_send_expiry_state TEXT,
    no_send_expiry_anchor_txid TEXT,
    no_send_expiry_anchor_vout INTEGER,
    no_send_expiry_released_at INTEGER,
    no_send_expiry_observed_at INTEGER,
    no_send_expiry_reclaim_txid TEXT,
    no_send_expiry_reclaim_raw_tx_hash TEXT,
    no_send_expiry_reclaim_derivation_prefix TEXT,
    no_send_expiry_reclaim_derivation_suffix TEXT,
    no_send_expiry_reclaim_satoshis INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_user_status ON transactions(user_id, status, transaction_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status, transaction_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_txid ON transactions(user_id, txid);
CREATE INDEX IF NOT EXISTS idx_tx_txid ON transactions(txid);
CREATE INDEX IF NOT EXISTS idx_tx_proven ON transactions(proven_tx_id);
CREATE INDEX IF NOT EXISTS idx_tx_nosend_state ON transactions(no_send_expiry_state);
CREATE INDEX IF NOT EXISTS idx_tx_nosend_reclaim ON transactions(no_send_expiry_reclaim_txid);

CREATE TABLE IF NOT EXISTS outputs (
    output_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    transaction_id INTEGER NOT NULL,
    basket_id INTEGER,
    spendable INTEGER NOT NULL DEFAULT 0,
    change_flag INTEGER NOT NULL DEFAULT 0,
    output_description TEXT NOT NULL DEFAULT '',
    vout INTEGER NOT NULL,
    satoshis INTEGER NOT NULL,
    provided_by TEXT NOT NULL,
    purpose TEXT NOT NULL,
    type TEXT NOT NULL,
    txid TEXT,
    sender_identity_key TEXT,
    derivation_prefix TEXT,
    derivation_suffix TEXT,
    custom_instructions TEXT,
    spent_by INTEGER,
    sequence_number INTEGER,
    spending_description TEXT,
    script_length INTEGER,
    script_offset INTEGER,
    locking_script_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_out_user_basket_spendable ON outputs(user_id, basket_id, spendable, output_id);
CREATE INDEX IF NOT EXISTS idx_out_user_spendable ON outputs(user_id, spendable, output_id);
CREATE INDEX IF NOT EXISTS idx_out_user_change_spendable ON outputs(user_id, change_flag, spendable, output_id);
CREATE INDEX IF NOT EXISTS idx_out_tx ON outputs(transaction_id);
CREATE INDEX IF NOT EXISTS idx_out_spent_by ON outputs(spent_by);
CREATE UNIQUE INDEX IF NOT EXISTS idx_out_tx_vout_user ON outputs(transaction_id, vout, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_out_txid_vout_user ON outputs(txid, vout, user_id) WHERE txid IS NOT NULL AND txid != '';

CREATE TABLE IF NOT EXISTS output_tags (
    output_tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tag, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ot_user ON output_tags(user_id);

CREATE TABLE IF NOT EXISTS output_tags_map (
    output_tag_id INTEGER NOT NULL,
    output_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (output_tag_id, output_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_otm_output ON output_tags_map(output_id, is_deleted);

CREATE TABLE IF NOT EXISTS tx_labels (
    tx_label_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(label, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tl_user ON tx_labels(user_id);

CREATE TABLE IF NOT EXISTS tx_labels_map (
    tx_label_id INTEGER NOT NULL,
    transaction_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tx_label_id, transaction_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_tlm_tx ON tx_labels_map(transaction_id, is_deleted);

CREATE TABLE IF NOT EXISTS commissions (
    commission_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    transaction_id INTEGER NOT NULL UNIQUE,
    satoshis INTEGER NOT NULL,
    key_offset TEXT NOT NULL,
    is_redeemed INTEGER NOT NULL DEFAULT 0,
    locking_script_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_user ON commissions(user_id);

CREATE TABLE IF NOT EXISTS certificates (
    certificate_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    certifier TEXT NOT NULL,
    subject TEXT NOT NULL,
    verifier TEXT,
    revocation_outpoint TEXT NOT NULL,
    signature TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, type, certifier, serial_number)
);
CREATE INDEX IF NOT EXISTS idx_cert_user ON certificates(user_id);

CREATE TABLE IF NOT EXISTS certificate_fields (
    certificate_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    field_value TEXT NOT NULL,
    master_key TEXT NOT NULL,
    PRIMARY KEY (certificate_id, field_name)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_cf_user ON certificate_fields(user_id);

CREATE TABLE IF NOT EXISTS sync_states (
    sync_state_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    storage_identity_key TEXT NOT NULL,
    storage_name TEXT NOT NULL,
    status TEXT NOT NULL,
    init INTEGER NOT NULL DEFAULT 0,
    ref_num TEXT NOT NULL UNIQUE,
    sync_map TEXT NOT NULL,
    when_at TEXT,
    satoshis INTEGER,
    error_local TEXT,
    error_other TEXT
);
CREATE INDEX IF NOT EXISTS idx_ss_user ON sync_states(user_id);
CREATE INDEX IF NOT EXISTS idx_ss_status ON sync_states(status);

CREATE TABLE IF NOT EXISTS monitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    event TEXT NOT NULL,
    details TEXT
);

CREATE TABLE IF NOT EXISTS action_batches (
    action_batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    batch_id TEXT NOT NULL,
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    hard_expires_at TEXT NOT NULL,
    manifest_digest TEXT,
    manifest TEXT,
    upload_digests TEXT,
    result TEXT,
    UNIQUE(user_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_ab_user ON action_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_ab_expires ON action_batches(expires_at);

CREATE TABLE IF NOT EXISTS action_batch_outputs (
    output_id INTEGER PRIMARY KEY,
    action_batch_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_abo_batch ON action_batch_outputs(action_batch_id);

CREATE TABLE IF NOT EXISTS action_batch_blobs (
    action_batch_id INTEGER NOT NULL,
    digest TEXT NOT NULL,
    action_batch_blob_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    bytes_hash TEXT NOT NULL,
    PRIMARY KEY (action_batch_id, digest)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_abb_batch ON action_batch_blobs(action_batch_id);
"#;

pub fn apply_writer_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -32768;
         PRAGMA mmap_size = 67108864;
         PRAGMA busy_timeout = 10000;
         PRAGMA wal_autocheckpoint = 1000;",
    )
}

pub fn apply_reader_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA query_only = ON;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -16384;
         PRAGMA mmap_size = 67108864;
         PRAGMA busy_timeout = 10000;",
    )
}

/// Convert Unix epoch milliseconds to canonical 24-char UTC ISO-8601 string
/// (`YYYY-MM-DDTHH:MM:SS.mmmZ`), matching `Date.prototype.toISOString()`.
pub fn epoch_ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    // Howard Hinnant's civil_from_days algorithm (exact proleptic Gregorian).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

pub fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    epoch_ms_to_iso(ms)
}

/// Normalize an incoming JSON timestamp (ISO string or epoch ms number) into
/// canonical 24-char UTC ISO-8601 text, falling back to `now_iso()`.
pub fn parse_iso_or_now(val: Option<&Value>) -> String {
    parse_optional_iso(val).unwrap_or_else(now_iso)
}

pub fn parse_optional_iso(val: Option<&Value>) -> Option<String> {
    let v = val?;
    if v.is_null() {
        return None;
    }
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Some(trimmed.to_string());
    }
    if let Some(ms) = v.as_i64() {
        return Some(epoch_ms_to_iso(ms));
    }
    if let Some(ms) = v.as_f64() {
        if ms.is_finite() {
            return Some(epoch_ms_to_iso(ms.trunc() as i64));
        }
    }
    None
}
