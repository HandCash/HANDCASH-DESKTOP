// Copyright HandCash. Licensed under the Apache License, Version 2.0.
// Platform-neutral Rust wallet core re-exported from workspace crates (`handcash-primitives`,
// `handcash-bitcoin`, `handcash-storage`, `handcash-net`, `handcash-engine`).

pub use handcash_engine::contract;
pub use handcash_engine::layers;
pub use handcash_primitives::encoding;

use serde_json::{json, Value};

pub fn core_info() -> Value {
    json!({
        "contractVersion": contract::CONTRACT_VERSION,
        "license": "Apache-2.0",
        "maxPageSlice": layers::MAX_PAGE_SLICE,
        "suspensionGapMs": layers::SUSPENSION_GAP_MS,
        "status": "phase2-background-spv-engine",
        "storage": "sqlite-wal",
        "scheduler": "4-lane-tokio",
        "modules": [
            "encoding",
            "brc39",
            "delta_seal",
            "bitcoin_tx",
            "header_pow",
            "bump_spv",
            "beef_parser",
            "ord_envelope",
            "brc150_verifier",
            "contract",
            "layers",
            "storage_wal",
            "net_rate_limiter",
            "header_tracker",
            "broadcaster",
            "background_runtime",
            "spend_pipeline",
            "view_projector"
        ]
    })
}
