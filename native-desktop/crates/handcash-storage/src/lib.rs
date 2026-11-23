// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Per-account SQLite (WAL mode) storage engine with hot/cold separation,
//! concurrent read pool, atomic UTXO reservation, append-only content-addressed
//! facts, and BRC-38 bootstrap import.

pub mod brc38_export;
pub mod brc38_import;
pub mod schema;
pub mod store;
pub mod toolbox_db;

pub use brc38_export::{export_brc38_from_toolbox, export_brc38_json};
pub use brc38_import::{import_brc38_json, Brc38ImportStats};
pub use store::{
    AccountStore, ActivityPage, ActivityRow, BalanceBreakdown, BlockHeaderRow, CommitSignedTx,
    FactRecord, FactSegment, ItemCardPage, ItemCardRow, NewOutputSpec, OutboxEntry,
    ProofRequestRow, StorageError, UtxoRecord, UtxoState, MAX_PAGE_SLICE,
};
pub use toolbox_db::{ToolboxDb, ToolboxDbManager};
