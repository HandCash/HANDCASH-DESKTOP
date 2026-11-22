// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! SQLite WAL pragmas and versioned hot/cold DDL schema.

use rusqlite::Connection;

pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Apply high-concurrency WAL pragmas for a writer connection.
pub fn configure_writer(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -16000;
        PRAGMA wal_autocheckpoint = 1000;
        ",
    )
}

/// Apply read-only WAL pragmas so interactive UI queries never block or acquire write locks.
pub fn configure_reader(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA query_only = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -8000;
        ",
    )
}

/// Create or migrate the per-account hot/cold schema.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );

        -- Content-addressed cold blob store: raw_tx, beef, bump, script, art, brc150_proof.
        -- Stored once per SHA-256 hash; never deserialized during hot scans or paging.
        CREATE TABLE IF NOT EXISTS blobs (
            sha256 TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL,
            byte_len INTEGER NOT NULL,
            data BLOB NOT NULL,
            created_at_ms INTEGER NOT NULL
        );

        -- Authoritative hot coin & asset ledger (fixed-width metadata only).
        CREATE TABLE IF NOT EXISTS utxos (
            outpoint TEXT PRIMARY KEY NOT NULL,
            txid TEXT NOT NULL,
            vout INTEGER NOT NULL,
            satoshis INTEGER NOT NULL,
            basket TEXT NOT NULL,
            state TEXT NOT NULL, -- spendable | reserved | unconfirmed_change | spent | quarantined
            is_change INTEGER NOT NULL DEFAULT 0,
            derivation_json TEXT,
            script_blob_hash TEXT,
            spent_by_txid TEXT,
            lock_owner TEXT,
            lock_expires_at_ms INTEGER,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_utxos_balance
            ON utxos (is_change, state) WHERE state IN ('spendable', 'unconfirmed_change');
        CREATE INDEX IF NOT EXISTS idx_utxos_basket_state
            ON utxos (basket, state, created_at_ms DESC, outpoint DESC);
        CREATE INDEX IF NOT EXISTS idx_utxos_txid ON utxos (txid);
        CREATE INDEX IF NOT EXISTS idx_utxos_lock ON utxos (lock_owner) WHERE lock_owner IS NOT NULL;

        -- Hot transaction lifecycle table.
        -- Status only advances after 'signed': never abort a signed transaction.
        CREATE TABLE IF NOT EXISTS transactions (
            txid TEXT PRIMARY KEY NOT NULL,
            status TEXT NOT NULL, -- draft | signed | queued | accepted | mined | proven_rejected | abandoned
            is_outgoing INTEGER NOT NULL DEFAULT 0,
            satoshis INTEGER NOT NULL DEFAULT 0,
            fee_sats INTEGER NOT NULL DEFAULT 0,
            description TEXT NOT NULL DEFAULT '',
            block_height INTEGER,
            merkle_root TEXT,
            raw_blob_hash TEXT,
            beef_blob_hash TEXT,
            bump_blob_hash TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_status
            ON transactions (status, updated_at_ms DESC);

        -- Hot 1Sat / BNT item catalog (never joins scripts or BEEF blobs during paging).
        CREATE TABLE IF NOT EXISTS items (
            outpoint TEXT PRIMARY KEY NOT NULL,
            origin_outpoint TEXT NOT NULL,
            basket TEXT NOT NULL,
            authenticity_status TEXT NOT NULL DEFAULT 'unproven', -- proven_brc150 | unproven
            authenticity_reason TEXT,
            verified_at_ms INTEGER,
            issuer_key TEXT,
            name TEXT NOT NULL DEFAULT '',
            mime TEXT NOT NULL DEFAULT '',
            art_blob_hash TEXT,
            brc150_blob_hash TEXT,
            sort_key INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_items_basket_sort
            ON items (basket, sort_key DESC, outpoint DESC);

        -- Materialized Activity projection updated atomically with state transitions.
        CREATE TABLE IF NOT EXISTS activity_view (
            activity_id TEXT PRIMARY KEY NOT NULL,
            txid TEXT,
            kind TEXT NOT NULL,
            direction TEXT NOT NULL,
            satoshis INTEGER NOT NULL,
            status TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            counterparty TEXT,
            app_origin TEXT,
            sort_ts_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_sort
            ON activity_view (sort_ts_ms DESC, activity_id DESC);

        -- Lightweight proof-request tracker (hashes only; never duplicates 1MB rawTx/inputBEEF).
        CREATE TABLE IF NOT EXISTS proof_requests (
            txid TEXT PRIMARY KEY NOT NULL,
            state TEXT NOT NULL, -- pending | polling | completed
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at_ms INTEGER NOT NULL DEFAULT 0,
            notified INTEGER NOT NULL DEFAULT 0,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_proof_requests_due
            ON proof_requests (state, next_retry_at_ms);

        -- Durable outbound broadcast & BRC-29/33 notice delivery queue.
        CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL, -- broadcast | notice_brc29 | notice_item | handover
            txid TEXT,
            payload_blob_hash TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at_ms INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'queued', -- queued | delivered | failed
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_due
            ON outbox (status, next_retry_at_ms);

        -- Append-only content-addressed fact log (set-union merge; never edited or deleted).
        CREATE TABLE IF NOT EXISTS facts (
            fact_id TEXT PRIMARY KEY NOT NULL,
            seq INTEGER NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            subject TEXT NOT NULL,
            body_json TEXT NOT NULL,
            segment_id TEXT,
            created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_facts_unsealed ON facts (seq) WHERE segment_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts (subject);

        CREATE TABLE IF NOT EXISTS fact_segments (
            segment_id TEXT PRIMARY KEY NOT NULL,
            root_hash TEXT NOT NULL UNIQUE,
            fact_count INTEGER NOT NULL,
            sealed_at_ms INTEGER NOT NULL,
            uploaded_at_ms INTEGER
        );

        -- PoW-verified block header cache for local SPV merkle verification.
        CREATE TABLE IF NOT EXISTS block_headers (
            height INTEGER PRIMARY KEY NOT NULL,
            hash TEXT NOT NULL,
            version INTEGER NOT NULL,
            previous_hash TEXT NOT NULL,
            merkle_root TEXT NOT NULL,
            time INTEGER NOT NULL,
            bits INTEGER NOT NULL,
            nonce INTEGER NOT NULL,
            verified_at_ms INTEGER NOT NULL
        );
        ",
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
        [CURRENT_SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}
