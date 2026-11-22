// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Platform-neutral pure-Rust HandCash Wallet Engine (`handcash-engine`).
//!
//! Coordinates per-account SQLite WAL storage, 4-lane priority scheduling,
//! unified background services (headers, SPV proof monitor, broadcast outbox,
//! BRC-249 holding clock, BRC-150 lineage worker, delta fact sealer),
//! compile-time-safe transaction hydration/signing, native Argon2id BRC-39
//! encryption, and coalesced view projections.

pub mod background;
pub mod contract;
pub mod engine;
pub mod layers;
pub mod projector;
pub mod scheduler;
pub mod spend_pipeline;

pub use background::{BackgroundHandle, BackgroundStats, Lane2SyncSummary};
pub use engine::{
    ActivateAccountResult, BeefVerifyResult, EngineError, HydratedSourcesResult, WalletEngine,
};
pub use projector::{DirtySlices, EngineViewPatch, ViewProjector};
pub use scheduler::{Lane, WorkScheduler};
pub use spend_pipeline::{
    DraftPlan, HydratedPlan, SignedTx, SpendInput, SpendPipelineError, VerifiedPlan,
};
