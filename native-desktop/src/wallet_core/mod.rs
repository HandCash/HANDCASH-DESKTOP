// Copyright HandCash. Licensed under the Apache License, Version 2.0.
// Platform-neutral Rust wallet core foundation shared by Desktop and future Mobile adapters.

pub mod contract;
pub mod encoding;
pub mod layers;

use serde_json::{json, Value};

pub fn core_info() -> Value {
    json!({
        "contractVersion": contract::CONTRACT_VERSION,
        "license": "Apache-2.0",
        "maxPageSlice": layers::MAX_PAGE_SLICE,
        "suspensionGapMs": layers::SUSPENSION_GAP_MS,
        "status": "foundation-read-only",
        "modules": ["encoding", "contract", "layers"]
    })
}
