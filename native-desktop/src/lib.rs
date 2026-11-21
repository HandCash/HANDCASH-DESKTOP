// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Platform-neutral HandCash Rust library: BRC-100 / device-peer servers,
//! durable store, OS sealing, release updater, and Meridian wallet-core foundation.
//! Shared by `handcash-shell` (Win/Linux), `handcash-sidecar` (macOS), and future Mobile adapters.

pub mod brc100_server;
pub mod brc39_archive;
pub mod bridge_protocol;
pub mod call_recordings;
pub mod device_auth;
pub mod durable;
pub mod durable_cache;
pub mod host_log;
pub mod http_wire;
pub mod log_privacy;
pub mod omarchy_theme;
pub mod paths;
pub mod release_update;
pub mod seal;
pub mod spend_ledger;
pub mod tls_cert;
pub mod ui_server;
pub mod wallet_core;
