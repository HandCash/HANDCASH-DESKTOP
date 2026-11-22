// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pooled, per-host rate-limited, singleflight HTTP chain fetcher, PoW header
//! tracker, and Arcade/Bitails broadcaster for HandCash Wallet Engine.

pub mod broadcast;
pub mod fetcher;
pub mod headers;
pub mod rate_limit;

pub use broadcast::{BroadcastVerdict, Broadcaster};
pub use fetcher::{ChainFetcher, FetchError, FetchedTxSource, TxSourceKind};
pub use headers::{parse_and_verify_header, HeaderFetcher};
pub use rate_limit::{HostPolicy, HostRateLimiter};
