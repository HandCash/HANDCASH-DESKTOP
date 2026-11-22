// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! In-process Rust BRC-100 HTTP/HTTPS direct handler for `handcash-native`.
//!
//! Answers BRC-100 requests on `:3321` / `:2121` directly using `KeyDeriver` and
//! `WalletEngine` with zero WebView round-trips.

use crate::state::{AppServices, APP_VERSION};
use handcash_primitives::encoding::encode_hex;
use handcash_primitives::keys::{reserved_key_refusal, Counterparty};
use handcash_shell::bridge_protocol::BridgeReply;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub fn install_direct_handler(services: &Arc<AppServices>) {
    let svc = Arc::clone(services);
    services
        .brc100
        .set_direct_handler(move |method, path, headers, body| {
            handle_brc100_request(&svc, method, path, headers, body)
        });
}

fn json_reply(status: u16, value: Value) -> BridgeReply {
    BridgeReply {
        status,
        body: value.to_string(),
    }
}

fn err_reply(status: u16, code: &str, message: &str) -> BridgeReply {
    json_reply(
        status,
        json!({
            "status": "error",
            "code": code,
            "description": message,
        }),
    )
}

fn parse_protocol(body: &Value) -> Result<(u8, String), BridgeReply> {
    let arr = body
        .get("protocolID")
        .and_then(Value::as_array)
        .ok_or_else(|| err_reply(400, "INVALID_PARAM", "protocolID must be [level, name]"))?;
    if arr.len() != 2 {
        return Err(err_reply(
            400,
            "INVALID_PARAM",
            "protocolID must have 2 elements",
        ));
    }
    let level = arr[0]
        .as_u64()
        .and_then(|v| u8::try_from(v).ok())
        .ok_or_else(|| err_reply(400, "INVALID_PARAM", "protocolID[0] must be 0, 1, or 2"))?;
    let name = arr[1]
        .as_str()
        .ok_or_else(|| err_reply(400, "INVALID_PARAM", "protocolID[1] must be a string"))?
        .to_string();
    Ok((level, name))
}

fn parse_bytes(body: &Value, field: &str) -> Option<Vec<u8>> {
    let arr = body.get(field)?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for v in arr {
        let b = v.as_u64().and_then(|n| u8::try_from(n).ok())?;
        out.push(b);
    }
    Some(out)
}

pub fn handle_brc100_request(
    services: &AppServices,
    _http_method: &str,
    path: &str,
    _headers: &HashMap<String, String>,
    body_str: &str,
) -> BridgeReply {
    let endpoint = path
        .split('?')
        .next()
        .unwrap_or(path)
        .trim_matches('/')
        .to_string();
    let body: Value = if body_str.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(body_str) {
            Ok(v) => v,
            Err(e) => return err_reply(400, "INVALID_JSON", &format!("Invalid JSON body: {e}")),
        }
    };

    match endpoint.as_str() {
        "getVersion" => {
            return json_reply(200, json!({ "version": APP_VERSION }));
        }
        "isAuthenticated" => {
            let authed = services.current_session_summary().is_some();
            return json_reply(200, json!({ "authenticated": authed }));
        }
        "waitForAuthentication" => {
            let authed = services.current_session_summary().is_some();
            return if authed {
                json_reply(200, json!({ "authenticated": true }))
            } else {
                err_reply(
                    401,
                    "WALLET_LOCKED",
                    "HandCash wallet is locked. Unlock HandCash to authenticate.",
                )
            };
        }
        _ => {}
    }

    let guard = services.session.lock().unwrap_or_else(|e| e.into_inner());
    let Some(active) = guard.as_ref() else {
        return err_reply(
            401,
            "WALLET_LOCKED",
            "HandCash wallet is locked. Unlock HandCash first.",
        );
    };
    let deriver = active.deriver.clone();
    let summary = active.summary.clone();
    drop(guard);

    if let Some(proto_name) = body
        .get("protocolID")
        .and_then(Value::as_array)
        .and_then(|a| a.get(1))
        .and_then(Value::as_str)
    {
        let cp = body.get("counterparty").and_then(Value::as_str);
        if let Some(reason) =
            reserved_key_refusal(&endpoint, Some(proto_name), cp, Some(&summary.identity_key))
        {
            return err_reply(
                403,
                "RESERVED_KEY_REFUSED",
                &format!("Refused access to reserved wallet key ({reason})."),
            );
        }
    }

    match endpoint.as_str() {
        "getNetwork" => {
            let net = if summary.chain == "test" {
                "testnet"
            } else {
                "mainnet"
            };
            json_reply(200, json!({ "network": net }))
        }
        "getHeight" => {
            let h = services
                .engine
                .runtime_handle()
                .block_on(
                    services
                        .engine
                        .sync_headers(&summary.account_id, summary.generation),
                )
                .ok()
                .flatten()
                .unwrap_or(0);
            json_reply(200, json!({ "height": h }))
        }
        "getBalance" => {
            match services.engine.runtime_handle().block_on(
                services
                    .engine
                    .read_balance(&summary.account_id, summary.generation),
            ) {
                Ok(bal) => json_reply(200, json!(bal)),
                Err(e) => err_reply(500, "ENGINE_ERROR", &e.to_string()),
            }
        }
        "getPublicKey" => {
            if body
                .get("identityKey")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return json_reply(200, json!({ "publicKey": summary.identity_key }));
            }
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body
                .get("keyID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let counterparty =
                Counterparty::parse(body.get("counterparty").and_then(Value::as_str), true);
            let for_self = body
                .get("forSelf")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            match deriver.derive_public_key((level, &proto), key_id, counterparty, for_self) {
                Ok(pk) => json_reply(200, json!({ "publicKey": encode_hex(&pk) })),
                Err(e) => err_reply(400, "KEY_DERIVATION_ERROR", &e.to_string()),
            }
        }
        "createSignature" => {
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body
                .get("keyID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let counterparty =
                Counterparty::parse(body.get("counterparty").and_then(Value::as_str), false);
            let data = parse_bytes(&body, "data");
            let hash = parse_bytes(&body, "hashToDirectlySign");
            match deriver.create_signature(
                (level, &proto),
                key_id,
                counterparty,
                data.as_deref(),
                hash.as_deref(),
            ) {
                Ok(sig) => json_reply(200, json!({ "signature": sig })),
                Err(e) => err_reply(400, "SIGN_ERROR", &e.to_string()),
            }
        }
        "verifySignature" => {
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body
                .get("keyID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let counterparty =
                Counterparty::parse(body.get("counterparty").and_then(Value::as_str), true);
            let for_self = body
                .get("forSelf")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let data = parse_bytes(&body, "data");
            let hash = parse_bytes(&body, "hashToDirectlyVerify");
            let Some(sig) = parse_bytes(&body, "signature") else {
                return err_reply(400, "INVALID_PARAM", "signature byte array is required");
            };
            match deriver.verify_signature(
                (level, &proto),
                key_id,
                counterparty,
                for_self,
                data.as_deref(),
                hash.as_deref(),
                &sig,
            ) {
                Ok(valid) => json_reply(200, json!({ "valid": valid })),
                Err(e) => err_reply(400, "VERIFY_ERROR", &e.to_string()),
            }
        }
        "createHmac" => {
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body
                .get("keyID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let counterparty =
                Counterparty::parse(body.get("counterparty").and_then(Value::as_str), true);
            let Some(data) = parse_bytes(&body, "data") else {
                return err_reply(400, "INVALID_PARAM", "data byte array is required");
            };
            match deriver.create_hmac((level, &proto), key_id, counterparty, &data) {
                Ok(mac) => json_reply(200, json!({ "hmac": mac.to_vec() })),
                Err(e) => err_reply(400, "HMAC_ERROR", &e.to_string()),
            }
        }
        "verifyHmac" => {
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body
                .get("keyID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let counterparty =
                Counterparty::parse(body.get("counterparty").and_then(Value::as_str), true);
            let Some(data) = parse_bytes(&body, "data") else {
                return err_reply(400, "INVALID_PARAM", "data byte array is required");
            };
            let Some(hmac_bytes) = parse_bytes(&body, "hmac") else {
                return err_reply(400, "INVALID_PARAM", "hmac byte array is required");
            };
            match deriver.verify_hmac((level, &proto), key_id, counterparty, &data, &hmac_bytes) {
                Ok(valid) => json_reply(200, json!({ "valid": valid })),
                Err(e) => err_reply(400, "HMAC_ERROR", &e.to_string()),
            }
        }
        "encrypt" => {
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body
                .get("keyID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let counterparty =
                Counterparty::parse(body.get("counterparty").and_then(Value::as_str), true);
            let Some(pt) = parse_bytes(&body, "plaintext") else {
                return err_reply(400, "INVALID_PARAM", "plaintext byte array is required");
            };
            match deriver.encrypt((level, &proto), key_id, counterparty, &pt) {
                Ok(ct) => json_reply(200, json!({ "ciphertext": ct })),
                Err(e) => err_reply(400, "CRYPTO_ERROR", &e.to_string()),
            }
        }
        "decrypt" => {
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body
                .get("keyID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let counterparty =
                Counterparty::parse(body.get("counterparty").and_then(Value::as_str), true);
            let Some(ct) = parse_bytes(&body, "ciphertext") else {
                return err_reply(400, "INVALID_PARAM", "ciphertext byte array is required");
            };
            match deriver.decrypt((level, &proto), key_id, counterparty, &ct) {
                Ok(pt) => json_reply(200, json!({ "plaintext": pt })),
                Err(e) => err_reply(400, "CRYPTO_ERROR", &e.to_string()),
            }
        }
        "listOutputs" => {
            let basket = body
                .get("basket")
                .and_then(Value::as_str)
                .unwrap_or("1sat")
                .to_string();
            let limit = body
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .min(100) as usize;
            match services
                .engine
                .runtime_handle()
                .block_on(services.engine.read_items_page(
                    &summary.account_id,
                    summary.generation,
                    basket,
                    None,
                    limit,
                )) {
                Ok(page) => json_reply(
                    200,
                    json!({
                        "totalOutputs": page.total,
                        "outputs": page.items,
                    }),
                ),
                Err(e) => err_reply(500, "ENGINE_ERROR", &e.to_string()),
            }
        }
        "listActions" => {
            let limit = body
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .min(100) as usize;
            match services
                .engine
                .runtime_handle()
                .block_on(services.engine.read_activity_page(
                    &summary.account_id,
                    summary.generation,
                    None,
                    limit,
                )) {
                Ok(page) => json_reply(
                    200,
                    json!({
                        "totalActions": page.total,
                        "actions": page.rows,
                    }),
                ),
                Err(e) => err_reply(500, "ENGINE_ERROR", &e.to_string()),
            }
        }
        other => err_reply(
            501,
            "UNIMPLEMENTED",
            &format!("Method '{other}' is not yet available in handcash-native."),
        ),
    }
}
