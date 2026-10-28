//! Device unlock factor. Electron only enables this on darwin (Touch ID);
//! Win/Linux stay explicitly unavailable until an OS presence prompt is wired.

use serde_json::{json, Value};

pub fn status() -> Value {
    json!({
        "available": false,
        "enrolled": false,
        "label": "Device unlock",
        "strongBox": false,
    })
}

pub fn enroll(_secret: &str) -> Value {
    json!({
        "ok": false,
        "error": "OS keychain sealing is not available on this device"
    })
}

pub fn unlock(_reason: &str) -> Value {
    json!({
        "ok": false,
        "error": "OS keychain sealing is not available"
    })
}

pub fn clear() -> Value {
    json!({ "ok": true })
}
