//! BRC-100 bridge protocol helpers: deadlines, BRC-326 wallet failure enrichment,
//! 1Sat app capabilities, CORS headers, and device-peer origin policy.
//!
//! Direct parity with `electron/bridgeDeadline.ts`, `electron/walletFailure.ts`,
//! `electron/oneSatAppCapabilities.ts`, `electron/appConnectGuardrails.ts`, and
//! `electron/devicePeerOrigin.ts`.

use serde_json::{json, Value};

pub const BRIDGE_DEADLINE_MS: u64 = 120_000;
pub const SPEND_DEADLINE_MS: u64 = 300_000;

/// Methods known to change nothing in the wallet, so a timeout means nothing ran.
/// Anything else (including future methods) counts as a spend (`WALLET_BRIDGE_PENDING`).
const READ_METHODS: &[&str] = &[
    "health",
    "getversion",
    "getnetwork",
    "getheight",
    "getheaderforheight",
    "isauthenticated",
    "waitforauthentication",
    "getpublickey",
    "listactions",
    "listoutputs",
    "getbalance",
    "listcertificates",
    "provecertificate",
    "discoverbyidentitykey",
    "discoverbyattributes",
    "revealcounterpartykeylinkage",
    "revealspecifickeylinkage",
    "encrypt",
    "decrypt",
    "createhmac",
    "verifyhmac",
    "createsignature",
    "verifysignature",
    "getlegacyaddress",
    "listmigrationtxids",
    "verifymarketlistingprovenance",
    "getmarketsettlementreceipt",
    "getmarketlistingstatus",
    "listbntassets",
    "getltcdepositaddress",
    "listltcdeposits",
    "getcoinaddress",
    "listcoins",
    "listassetprofiles",
    "getclaimedcloudhandle",
    "getarcusdaddress",
    "listarcusd",
    "listarcusdcwrapclaims",
    "getarcusdcwrapspendable",
    "planarcusdcfractionalize",
    "planarcusdcredeem",
];

fn method_of(path: &str) -> String {
    path.trim()
        .to_ascii_lowercase()
        .trim_matches('/')
        .to_string()
}

pub fn is_spend_method_path(path: &str) -> bool {
    let m = method_of(path);
    !READ_METHODS.iter().any(|&known| known == m)
}

pub fn bridge_deadline_ms(path: &str) -> u64 {
    if is_spend_method_path(path) {
        SPEND_DEADLINE_MS
    } else {
        BRIDGE_DEADLINE_MS
    }
}

pub fn bridge_deadline_code(path: &str) -> &'static str {
    if is_spend_method_path(path) {
        "WALLET_BRIDGE_PENDING"
    } else {
        "WALLET_BRIDGE_TIMEOUT"
    }
}

pub fn bridge_deadline_message(method: &str, path: &str) -> String {
    let code = bridge_deadline_code(path);
    let ms = bridge_deadline_ms(path);
    if code == "WALLET_BRIDGE_PENDING" {
        format!("{code}: {method} {path} is still running in the wallet after {ms}ms — it may still complete; reconcile before retrying")
    } else {
        format!("{code}: no renderer reply for {method} {path} within {ms}ms")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WalletFailure {
    pub class: &'static str,
    pub fault: &'static str,
    pub retry: &'static str,
}

const INSUFFICIENT: WalletFailure = WalletFailure { class: "insufficient-funds", fault: "none", retry: "check-first" };
const LOCKED: WalletFailure = WalletFailure { class: "locked", fault: "none", retry: "safe" };
const DENIED: WalletFailure = WalletFailure { class: "permission-denied", fault: "user", retry: "unsafe" };
const POLICY: WalletFailure = WalletFailure { class: "policy-blocked", fault: "none", retry: "unsafe" };
const UNREACHABLE: WalletFailure = WalletFailure { class: "unreachable", fault: "none", retry: "safe" };
const INVALID: WalletFailure = WalletFailure { class: "invalid-request", fault: "application", retry: "unsafe" };
const UNCERTAIN: WalletFailure = WalletFailure { class: "uncertain-delivery", fault: "none", retry: "check-first" };
const LATER: WalletFailure = WalletFailure { class: "unavailable", fault: "wallet", retry: "safe" };
const NOT_HERE: WalletFailure = WalletFailure { class: "unavailable", fault: "wallet", retry: "unsafe" };
const CHECK: WalletFailure = WalletFailure { class: "unavailable", fault: "wallet", retry: "check-first" };
const GRANT_EXPIRED: WalletFailure = WalletFailure { class: "permission-denied", fault: "none", retry: "safe" };

const FAILURE_CLASSES: &[&str] = &[
    "insufficient-funds",
    "locked",
    "permission-denied",
    "policy-blocked",
    "unreachable",
    "invalid-request",
    "uncertain-delivery",
    "unavailable",
];

pub fn wallet_failure_for(code: Option<&str>, status: u16, path: &str) -> WalletFailure {
    if let Some(c) = code {
        match c {
            "INSUFFICIENT_FUNDS" => return INSUFFICIENT,
            "WALLET_LOCKED" | "NOT_AUTHENTICATED" => return LOCKED,
            "PERMISSION_DENIED"
            | "ACTION_DENIED"
            | "TOKEN_VIEW_DENIED"
            | "ITEM_VIEW_DENIED"
            | "COUNTERSIGNED_VIEW_DENIED"
            | "HANDLE_ISSUE_REFUSED"
            | "HANDLE_ISSUE_GRANT_REVOKED" => return DENIED,
            "HANDLE_ISSUE_GRANT_EXPIRED" => return GRANT_EXPIRED,
            "ORIGIN_REFUSED"
            | "MARKET_ORIGIN_DENIED"
            | "MIGRATION_ORIGIN_DENIED"
            | "PROTOCOL_REFUSE"
            | "RESERVED_KEY"
            | "ORIGIN_BOUND_IN_APP"
            | "HANDLE_ISSUE_GRANT_USED"
            | "HANDLE_ISSUE_TAKEN" => return POLICY,
            "WALLET_BRIDGE_UNAVAILABLE" => return UNREACHABLE,
            "BAD_REQUEST"
            | "BODY_TOO_LARGE"
            | "INVALID_SATOSHIS"
            | "INVALID_TOKEN_SCOPE"
            | "INVALID_P1SAT_SCOPE"
            | "INVALID_COUNTERSIGNED_SCOPE"
            | "INVALID_IDENTITY_PROOF"
            | "MISSING_TOKEN_SCOPE_TAG"
            | "MISSING_P1SAT_SCOPE_TAG"
            | "MISSING_COUNTERSIGNED_SCOPE_TAG"
            | "USE_TOKEN_SCOPE"
            | "USE_P1SAT_SCOPE"
            | "USE_COUNTERSIGNED_SCOPE"
            | "UNSUPPORTED_P_BASKET"
            | "EMPTY_INPUTS"
            | "DUST_OUTPUT"
            | "COIN_OWN_ADDRESS"
            | "HANDLE_ISSUE_INVALID"
            | "HANDLE_ISSUE_WRONG_KEY"
            | "HANDLE_ISSUE_CHALLENGE_REJECTED" => return INVALID,
            "WALLET_BRIDGE_PENDING"
            | "ACTION_IN_PROGRESS"
            | "SPEND_REGION_ABANDONED"
            | "INSUFFICIENT_OR_STALE_FUNDS" => return UNCERTAIN,
            "WALLET_BRIDGE_TIMEOUT"
            | "WALLET_BALANCE_TIMEOUT"
            | "INPUTS_UNVERIFIED"
            | "OFFLINE_PAYMENTS_DISABLED"
            | "CHANGE_CHAINING_REQUIRED"
            | "SPENDING_BUDGET_UNAVAILABLE" => return LATER,
            "UNIMPLEMENTED"
            | "INDEX_EXPANSION_UNAVAILABLE"
            | "ASSET_PROTOCOL_RETIRED"
            | "COIN_UNSUPPORTED_CHAIN"
            | "BNT_WALLET_ONLY"
            | "COUNTERSIGNED_WALLET_ONLY"
            | "MARKET_LISTING_REFUSED"
            | "ITEM_ORIGIN_UNPROVEN"
            | "BEEF_ANCESTRY_INCOMPLETE"
            | "FEE_TOO_LOW"
            | "ARCADE_HARD_REJECT" => return NOT_HERE,
            "DOUBLE_SPENT" | "HANDLE_ISSUE_FAILED" => return CHECK,
            _ => {}
        }
    }
    if status == 404 {
        return INVALID;
    }
    if is_spend_method_path(path) {
        UNCERTAIN
    } else {
        LATER
    }
}

pub fn with_wallet_failure(status: u16, body: &str, path: &str) -> String {
    if status < 400 {
        return body.to_string();
    }
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(body) else {
        return body.to_string();
    };
    if obj
        .get("class")
        .and_then(|v| v.as_str())
        .is_some_and(|c| FAILURE_CLASSES.contains(&c))
    {
        return body.to_string();
    }
    let code = obj.get("code").and_then(|v| v.as_str()).map(str::to_string);
    let failure = wallet_failure_for(code.as_deref(), status, path);
    obj.entry("status").or_insert_with(|| Value::String("error".into()));
    obj.insert("class".into(), Value::String(failure.class.into()));
    obj.insert("fault".into(), Value::String(failure.fault.into()));
    obj.insert("retry".into(), Value::String(failure.retry.into()));
    Value::Object(obj).to_string()
}

pub fn bridge_failure_description(code: &str, message: &str, path: &str) -> &'static str {
    if code == "WALLET_BRIDGE_UNAVAILABLE" {
        if message.contains("app-quitting") {
            return "HandCash is closing. Try again once it is open.";
        }
        if message.contains("window-unavailable") {
            return "HandCash could not open its window. Try again in a moment.";
        }
        if message.contains("renderer-not-ready") {
            return "HandCash is still starting. Try again in a moment.";
        }
        return "HandCash could not be reached just now. Try again in a moment.";
    }
    if code == "WALLET_BRIDGE_TIMEOUT" {
        return "HandCash took too long to answer and nothing changed. Try again in a moment.";
    }
    if code == "WALLET_BRIDGE_PENDING" || is_spend_method_path(path) {
        return "HandCash may still finish this. Check your balance and activity before trying again.";
    }
    "HandCash could not finish this request. Try again in a moment."
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeReply {
    pub status: u16,
    pub body: String,
}

pub fn bridge_error_reply(message: &str, path: &str) -> BridgeReply {
    let is_unavailable = message.contains("WALLET_BRIDGE_UNAVAILABLE");
    let is_pending = message.contains("WALLET_BRIDGE_PENDING");
    let is_timeout = message.contains("WALLET_BRIDGE_TIMEOUT");
    let code = if is_pending {
        "WALLET_BRIDGE_PENDING"
    } else if is_timeout {
        "WALLET_BRIDGE_TIMEOUT"
    } else if is_unavailable {
        "WALLET_BRIDGE_UNAVAILABLE"
    } else {
        "HTTP_BRIDGE_ERROR"
    };
    let status = if is_unavailable || is_pending || is_timeout {
        503
    } else {
        500
    };
    let failure = wallet_failure_for(Some(code), status, path);
    BridgeReply {
        status,
        body: json!({
            "status": "error",
            "code": code,
            "description": bridge_failure_description(code, message, path),
            "class": failure.class,
            "fault": failure.fault,
            "retry": failure.retry,
        })
        .to_string(),
    }
}

pub fn bridge_cors_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "*"),
        ("Access-Control-Allow-Methods", "*"),
        ("Access-Control-Expose-Headers", "*"),
        ("Access-Control-Allow-Private-Network", "true"),
    ]
}

pub fn one_sat_app_capabilities() -> Value {
    json!({
        "brcs": ["147", "150", "164", "165"],
        "baskets": ["1sat"],
        "permissions": {
            "protocol": "p 1sat",
            "viewScopes": ["all", "collection", "app", "creator", "id"],
            "spendLabel": "p 1sat input id <key>",
        },
        "provenanceVerify": ["v2"],
        "walletIdentityProof": {
            "version": 1,
            "methods": ["waitForAuthentication", "getPublicKey", "createSignature"],
            "protocolID": [2, "wallet identity proof"],
            "keyID": "identity-proof:<normalized-origin>",
            "counterparty": "anyone",
            "challenge": {
                "domain": "handcash-wallet-identity-proof",
                "encoding": "canonical-json-utf8",
                "maxTtlMs": 300000,
                "minNonceBits": 128,
            }
        }
    })
}

pub fn manifest_json() -> String {
    json!({
        "short_name": "HandCash",
        "name": "HandCash Desktop",
        "start_url": ".",
        "display": "standalone",
        "theme_color": "#00d46a",
        "background_color": "#07140f",
        "icons": [{ "src": "favicon.ico", "sizes": "64x64 32x32 24x24 16x16", "type": "image/x-icon" }],
        "babbage": {
            "trust": {
                "name": "HandCash",
                "note": "Official HandCash Desktop — keys stay on your machine",
                "icon": "https://localhost:2121/favicon.ico",
                "publicKey": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            },
            "oneSat": one_sat_app_capabilities(),
        }
    })
    .to_string()
}

pub fn health_json() -> String {
    json!({
        "ok": true,
        "service": "handcash-brc100",
        "bridge": "http",
        "oneSat": one_sat_app_capabilities(),
    })
    .to_string()
}

const WALLET_ORIGINS: &[&str] = &[
    "http://localhost:5173",
    "null",
    "https://localhost",
    "capacitor://localhost",
];

pub fn device_peer_origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => WALLET_ORIGINS.contains(&o),
    }
}

pub fn device_peer_cors_headers(origin: Option<&str>) -> Vec<(&'static str, String)> {
    let Some(o) = origin else {
        return vec![];
    };
    if !WALLET_ORIGINS.contains(&o) {
        return vec![];
    }
    vec![
        ("Access-Control-Allow-Origin", o.to_string()),
        ("Access-Control-Allow-Headers", "*".into()),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS".into()),
        ("Access-Control-Allow-Private-Network", "true".into()),
        ("Vary", "Origin".into()),
    ]
}

pub fn summarize_error_body(body: &str) -> String {
    if body.is_empty() {
        return "(empty body)".into();
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(body) {
        let code = map.get("code").and_then(|v| v.as_str());
        let desc = map
            .get("description")
            .or_else(|| map.get("message"))
            .and_then(|v| v.as_str());
        let mut parts = Vec::new();
        if let Some(c) = code {
            if !c.is_empty() {
                parts.push(c);
            }
        }
        if let Some(d) = desc {
            if !d.is_empty() {
                parts.push(d);
            }
        }
        if !parts.is_empty() {
            return truncate_for_log(&parts.join(": "));
        }
    }
    truncate_for_log(body)
}

fn truncate_for_log(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 300 {
        let mut s: String = flat.chars().take(300).collect();
        s.push('…');
        s
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_reads_vs_spends_and_deadlines() {
        assert!(!is_spend_method_path("/getVersion"));
        assert!(!is_spend_method_path("/listOutputs/"));
        assert!(is_spend_method_path("/createAction"));
        assert!(is_spend_method_path("/sendCoins"));
        assert!(is_spend_method_path("/unknownFutureWriteMethod"));
        assert_eq!(bridge_deadline_ms("/getVersion"), BRIDGE_DEADLINE_MS);
        assert_eq!(bridge_deadline_ms("/createAction"), SPEND_DEADLINE_MS);
        assert_eq!(bridge_deadline_code("/createAction"), "WALLET_BRIDGE_PENDING");
        assert_eq!(bridge_deadline_code("/getVersion"), "WALLET_BRIDGE_TIMEOUT");
    }

    #[test]
    fn enriches_brc326_wallet_failures_without_overwriting_existing_class() {
        let out = with_wallet_failure(400, r#"{"code":"INSUFFICIENT_FUNDS"}"#, "/createAction");
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["class"], json!("insufficient-funds"));
        assert_eq!(parsed["retry"], json!("check-first"));

        // Unknown error on a spend path must be uncertain-delivery.
        let unknown_spend = with_wallet_failure(500, r#"{"description":"boom"}"#, "/createAction");
        let parsed2: Value = serde_json::from_str(&unknown_spend).unwrap();
        assert_eq!(parsed2["class"], json!("uncertain-delivery"));
        assert_eq!(parsed2["retry"], json!("check-first"));

        // Existing valid class passes untouched.
        let raw = r#"{"class":"locked","fault":"none","retry":"safe"}"#;
        assert_eq!(with_wallet_failure(403, raw, "/createAction"), raw);
    }

    #[test]
    fn enforces_device_peer_origin_allowlist() {
        assert!(device_peer_origin_allowed(None));
        assert!(device_peer_origin_allowed(Some("http://localhost:5173")));
        assert!(device_peer_origin_allowed(Some("capacitor://localhost")));
        assert!(!device_peer_origin_allowed(Some("https://evil.example")));
        assert!(device_peer_cors_headers(Some("https://evil.example")).is_empty());
        assert!(!device_peer_cors_headers(Some("http://localhost:5173")).is_empty());
    }
}
