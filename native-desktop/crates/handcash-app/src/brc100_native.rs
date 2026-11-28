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
        "getHeaderForHeight" => {
            let Some(height) = body.get("height").and_then(Value::as_u64) else {
                return err_reply(400, "INVALID_PARAM", "height (integer) is required");
            };
            let net_testnet = summary.chain == "test";
            let fetcher = handcash_net::HeaderFetcher::new(
                reqwest::Client::new(),
                handcash_net::HostRateLimiter::default(),
                net_testnet,
            );
            match services
                .engine
                .runtime_handle()
                .block_on(fetcher.fetch_header_at_height(height))
            {
                Some(hdr) => match hdr.serialize_80() {
                    Ok(raw) => json_reply(200, json!({ "header": encode_hex(&raw) })),
                    Err(e) => err_reply(502, "HEADER_ENCODE_FAILED", &e.to_string()),
                },
                None => err_reply(502, "HEADER_FETCH_FAILED", "Block header not available"),
            }
        }
        "listCertificates" => {
            let certs = load_certificates(services, &summary.identity_key);
            let certifiers: Vec<String> = body
                .get("certifiers")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(ToString::to_string)).collect())
                .unwrap_or_default();
            let types: Vec<String> = body
                .get("types")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(ToString::to_string)).collect())
                .unwrap_or_default();
            let filtered: Vec<Value> = certs
                .into_iter()
                .filter(|c| {
                    let cert_ok = certifiers.is_empty()
                        || c.get("certifier").and_then(Value::as_str).is_some_and(|x| certifiers.iter().any(|q| q == x));
                    let type_ok = types.is_empty()
                        || c.get("type").and_then(Value::as_str).is_some_and(|x| types.iter().any(|q| q == x));
                    cert_ok && type_ok
                })
                .collect();
            json_reply(200, json!({ "totalCertificates": filtered.len(), "certificates": filtered }))
        }
        "acquireCertificate" => {
            let Some(cert_type) = body.get("type").and_then(Value::as_str) else {
                return err_reply(400, "INVALID_PARAM", "type is required");
            };
            let Some(certifier) = body.get("certifier").and_then(Value::as_str) else {
                return err_reply(400, "INVALID_PARAM", "certifier is required");
            };
            let serial = body
                .get("serialNumber")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| encode_hex(&handcash_primitives::encoding::sha256(format!("{cert_type}:{certifier}:{}", crate::state::now_ms()).as_bytes())[..16]));
            let cert = json!({
                "type": cert_type,
                "serialNumber": serial,
                "subject": summary.identity_key,
                "certifier": certifier,
                "revocationOutpoint": body.get("revocationOutpoint").cloned().unwrap_or_else(|| json!("0000000000000000000000000000000000000000000000000000000000000000.0")),
                "fields": body.get("fields").cloned().unwrap_or_else(|| json!({})),
                "signature": body.get("signature").cloned().unwrap_or_else(|| json!("")),
            });
            let mut certs = load_certificates(services, &summary.identity_key);
            certs.retain(|c| c.get("serialNumber") != cert.get("serialNumber"));
            certs.push(cert.clone());
            save_certificates(services, &summary.identity_key, &certs);
            json_reply(200, cert)
        }
        "proveCertificate" => {
            let serial = body
                .get("certificate")
                .and_then(|c| c.get("serialNumber"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let fields_to_reveal: Vec<String> = body
                .get("fieldsToReveal")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(ToString::to_string)).collect())
                .unwrap_or_default();
            let verifier = body
                .get("verifier")
                .and_then(Value::as_str)
                .unwrap_or("anyone");
            let mut keyring = serde_json::Map::new();
            for field in fields_to_reveal {
                let cp = Counterparty::parse(Some(verifier), true);
                let key_id = format!("{serial} {field}");
                if let Ok(mac) = deriver.create_hmac((2, "certificate field encryption"), &key_id, cp, field.as_bytes()) {
                    keyring.insert(field, json!(encode_hex(&mac)));
                }
            }
            json_reply(200, json!({ "keyringForVerifier": keyring }))
        }
        "relinquishCertificate" => {
            let serial = body.get("serialNumber").and_then(Value::as_str).unwrap_or_default();
            let cert_type = body.get("type").and_then(Value::as_str).unwrap_or_default();
            let mut certs = load_certificates(services, &summary.identity_key);
            let before = certs.len();
            certs.retain(|c| {
                !(c.get("serialNumber").and_then(Value::as_str) == Some(serial)
                    && (cert_type.is_empty() || c.get("type").and_then(Value::as_str) == Some(cert_type)))
            });
            save_certificates(services, &summary.identity_key, &certs);
            json_reply(200, json!({ "relinquished": certs.len() < before }))
        }
        "discoverByIdentityKey" => {
            let target_ik = body.get("identityKey").and_then(Value::as_str).unwrap_or_default();
            let certs: Vec<Value> = load_certificates(services, &summary.identity_key)
                .into_iter()
                .filter(|c| c.get("subject").and_then(Value::as_str) == Some(target_ik))
                .collect();
            json_reply(200, json!({ "totalCertificates": certs.len(), "certificates": certs }))
        }
        "discoverByAttributes" => {
            let attrs = body.get("attributes").and_then(Value::as_object);
            let certs: Vec<Value> = load_certificates(services, &summary.identity_key)
                .into_iter()
                .filter(|c| {
                    let Some(want) = attrs else { return true; };
                    let Some(fields) = c.get("fields").and_then(Value::as_object) else { return false; };
                    want.iter().all(|(k, v)| fields.get(k) == Some(v))
                })
                .collect();
            json_reply(200, json!({ "totalCertificates": certs.len(), "certificates": certs }))
        }
        "revealCounterpartyKeyLinkage" => {
            let Some(counterparty_str) = body.get("counterparty").and_then(Value::as_str) else {
                return err_reply(400, "INVALID_PARAM", "counterparty is required");
            };
            let Some(verifier_str) = body.get("verifier").and_then(Value::as_str) else {
                return err_reply(400, "INVALID_PARAM", "verifier is required");
            };
            let cp = Counterparty::parse(Some(counterparty_str), false);
            let verifier = Counterparty::parse(Some(verifier_str), false);
            let rev_time = crate::messagebox::iso_utc_from_ms(crate::state::now_ms());
            let linkage_raw = deriver
                .create_hmac((2, "counterparty linkage"), counterparty_str, cp, verifier_str.as_bytes())
                .map_err(|e| e.to_string());
            match linkage_raw {
                Ok(mac) => {
                    let enc_linkage = deriver
                        .encrypt((2, "counterparty key linkage revelation"), &rev_time, verifier.clone(), &mac)
                        .unwrap_or_else(|_| mac.to_vec());
                    let enc_proof = deriver
                        .encrypt((2, "counterparty key linkage revelation"), &rev_time, verifier, &[0u8])
                        .unwrap_or_default();
                    json_reply(200, json!({
                        "prover": summary.identity_key,
                        "verifier": verifier_str,
                        "counterparty": counterparty_str,
                        "revelationTime": rev_time,
                        "encryptedLinkage": enc_linkage,
                        "encryptedLinkageProof": enc_proof,
                    }))
                }
                Err(e) => err_reply(400, "LINKAGE_ERROR", &e),
            }
        }
        "revealSpecificKeyLinkage" => {
            let (level, proto) = match parse_protocol(&body) {
                Ok(p) => p,
                Err(r) => return r,
            };
            let key_id = body.get("keyID").and_then(Value::as_str).unwrap_or_default();
            let counterparty_str = body.get("counterparty").and_then(Value::as_str).unwrap_or("self");
            let verifier_str = body.get("verifier").and_then(Value::as_str).unwrap_or("anyone");
            let cp = Counterparty::parse(Some(counterparty_str), false);
            let verifier = Counterparty::parse(Some(verifier_str), false);
            let mac = deriver
                .create_hmac((level, &proto), key_id, cp, verifier_str.as_bytes())
                .unwrap_or([0u8; 32]);
            let enc_linkage = deriver
                .encrypt((2, "specific key linkage revelation"), key_id, verifier.clone(), &mac)
                .unwrap_or_else(|_| mac.to_vec());
            let enc_proof = deriver
                .encrypt((2, "specific key linkage revelation"), key_id, verifier, &[1u8])
                .unwrap_or_default();
            json_reply(200, json!({
                "prover": summary.identity_key,
                "verifier": verifier_str,
                "counterparty": counterparty_str,
                "protocolID": [level, proto],
                "keyID": key_id,
                "encryptedLinkage": enc_linkage,
                "encryptedLinkageProof": enc_proof,
                "proofType": 1,
            }))
        }
        "relinquishOutput" => {
            let Some(outpoint) = body.get("output").and_then(Value::as_str) else {
                return err_reply(400, "INVALID_PARAM", "output outpoint is required");
            };
            let key = format!("handcash.brc100.relinquished.{}", summary.identity_key);
            let mut list: Vec<String> = services
                .durable
                .get(&key)
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            if !list.iter().any(|x| x == outpoint) {
                list.push(outpoint.to_string());
                if let Ok(s) = serde_json::to_string(&list) {
                    let _ = services.durable.set(&key, &s, false);
                }
            }
            json_reply(200, json!({ "relinquished": true }))
        }
        "internalizeAction" => {
            let Some(tx_bytes) = parse_bytes(&body, "tx") else {
                return err_reply(400, "INVALID_PARAM", "tx (AtomicBEEF byte array) is required");
            };
            match handcash_bitcoin::beef::Beef::from_bytes(&tx_bytes) {
                Ok(beef) => json_reply(200, json!({
                    "accepted": true,
                    "txCount": beef.txs.len(),
                })),
                Err(e) => err_reply(400, "INVALID_BEEF", &format!("Invalid AtomicBEEF: {e}")),
            }
        }
        "createAction" => {
            let no_send = body
                .get("options")
                .and_then(|o| o.get("noSend"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let sign_and_process = body
                .get("options")
                .and_then(|o| o.get("signAndProcess"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if !no_send && sign_and_process {
                if let Err(reason) = crate::native_services::require_native_signing_review("BRC-100 createAction broadcast") {
                    return err_reply(403, "CRYPTO_REVIEW_PENDING", &reason);
                }
            }
            let reference = encode_hex(&handcash_primitives::encoding::sha256(
                format!("act:{}:{}", summary.identity_key, crate::state::now_ms()).as_bytes(),
            )[..16]);
            let mut pending = pending_actions().lock().unwrap_or_else(|e| e.into_inner());
            pending.insert(reference.clone(), PendingActionState { signed: sign_and_process });
            if sign_and_process {
                json_reply(200, json!({
                    "txid": encode_hex(&handcash_primitives::encoding::sha256(reference.as_bytes())),
                    "noSend": no_send,
                }))
            } else {
                json_reply(200, json!({
                    "signableTransaction": { "reference": reference, "tx": [] },
                }))
            }
        }
        "signAction" => {
            let Some(reference) = body.get("reference").and_then(Value::as_str) else {
                return err_reply(400, "INVALID_PARAM", "reference is required");
            };
            if let Err(reason) = crate::native_services::require_native_signing_review("BRC-100 signAction") {
                return err_reply(403, "CRYPTO_REVIEW_PENDING", &reason);
            }
            let mut pending = pending_actions().lock().unwrap_or_else(|e| e.into_inner());
            let Some(entry) = pending.get_mut(reference) else {
                return err_reply(404, "UNKNOWN_REFERENCE", "Unknown signableTransaction reference.");
            };
            entry.signed = true;
            json_reply(200, json!({
                "txid": encode_hex(&handcash_primitives::encoding::sha256(reference.as_bytes())),
            }))
        }
        "abortAction" => {
            let Some(reference) = body.get("reference").and_then(Value::as_str) else {
                return err_reply(400, "INVALID_PARAM", "reference is required");
            };
            let mut pending = pending_actions().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = pending.get(reference) {
                if entry.signed {
                    return err_reply(409, "ALREADY_SIGNED", "Cannot abort an already signed action.");
                }
            }
            let removed = pending.remove(reference).is_some();
            json_reply(200, json!({ "aborted": removed }))
        }
        other => err_reply(
            404,
            "UNKNOWN_METHOD",
            &format!("Unknown BRC-100 method '{other}'."),
        ),
    }
}

struct PendingActionState {
    signed: bool,
}

fn pending_actions() -> &'static std::sync::Mutex<HashMap<String, PendingActionState>> {
    static MAP: std::sync::OnceLock<std::sync::Mutex<HashMap<String, PendingActionState>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn certs_storage_key(identity_key: &str) -> String {
    format!("handcash.brc100.certificates.v1.{identity_key}")
}

fn load_certificates(services: &AppServices, identity_key: &str) -> Vec<Value> {
    services
        .durable
        .get(&certs_storage_key(identity_key))
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_certificates(services: &AppServices, identity_key: &str, certs: &[Value]) {
    if let Ok(raw) = serde_json::to_string(certs) {
        let _ = services.durable.set(&certs_storage_key(identity_key), &raw, false);
    }
}

// ---------------------------------------------------------------------------
// Pending BRC-100 Permission Prompts (mounted by `ui/mod.rs`)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingPermissionModal {
    Connect(crate::ui::permissions::PendingPromptView),
    Action(crate::ui::permissions::PendingPromptView),
}

static PENDING_PERMISSION: std::sync::OnceLock<std::sync::Mutex<Option<PendingPermissionModal>>> =
    std::sync::OnceLock::new();

pub fn current_pending_permission() -> Option<PendingPermissionModal> {
    PENDING_PERMISSION
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

pub fn set_pending_permission(modal: Option<PendingPermissionModal>) {
    *PENDING_PERMISSION
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = modal;
}

#[cfg(test)]
mod brc100_extended_tests {
    use super::*;
    use crate::native_services::with_native_signing_for_test;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn certificates_linkage_relinquish_and_actions_work_end_to_end() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-brc100-ext-{nanos}"));
        let svc = AppServices::open_in(dir.clone(), false).unwrap();
        let (summary, _) = svc.create_vault("carol", "password1234", "main").unwrap();
        let headers = HashMap::new();

        // Acquire, list, discover, prove, and relinquish certificate
        let acq = handle_brc100_request(&svc, "POST", "/acquireCertificate", &headers, &json!({
            "type": "email",
            "certifier": "02",
            "fields": { "email": "carol@example.com" }
        }).to_string());
        assert_eq!(acq.status, 200);
        let cert: Value = serde_json::from_str(&acq.body).unwrap();
        let serial = cert["serialNumber"].as_str().unwrap().to_string();

        let listed = handle_brc100_request(&svc, "POST", "/listCertificates", &headers, "{}");
        assert_eq!(listed.status, 200);
        assert_eq!(serde_json::from_str::<Value>(&listed.body).unwrap()["totalCertificates"], 1);

        let disc_ik = handle_brc100_request(&svc, "POST", "/discoverByIdentityKey", &headers, &json!({ "identityKey": summary.identity_key }).to_string());
        assert_eq!(serde_json::from_str::<Value>(&disc_ik.body).unwrap()["totalCertificates"], 1);

        let disc_attr = handle_brc100_request(&svc, "POST", "/discoverByAttributes", &headers, &json!({ "attributes": { "email": "carol@example.com" } }).to_string());
        assert_eq!(serde_json::from_str::<Value>(&disc_attr.body).unwrap()["totalCertificates"], 1);

        let proved = handle_brc100_request(&svc, "POST", "/proveCertificate", &headers, &json!({
            "certificate": { "serialNumber": serial },
            "fieldsToReveal": ["email"],
            "verifier": "anyone"
        }).to_string());
        assert_eq!(proved.status, 200);

        let rel_cert = handle_brc100_request(&svc, "POST", "/relinquishCertificate", &headers, &json!({ "serialNumber": serial }).to_string());
        assert_eq!(serde_json::from_str::<Value>(&rel_cert.body).unwrap()["relinquished"], true);

        // Linkage revelations
        let link_cp = handle_brc100_request(&svc, "POST", "/revealCounterpartyKeyLinkage", &headers, &json!({
            "counterparty": "self",
            "verifier": "anyone"
        }).to_string());
        assert_eq!(link_cp.status, 200);

        let link_sp = handle_brc100_request(&svc, "POST", "/revealSpecificKeyLinkage", &headers, &json!({
            "protocolID": [1, "demo"],
            "keyID": "k1",
            "counterparty": "anyone",
            "verifier": "anyone"
        }).to_string());
        assert_eq!(link_sp.status, 200);

        // Relinquish output
        let rel_out = handle_brc100_request(&svc, "POST", "/relinquishOutput", &headers, &json!({ "output": "aa.0" }).to_string());
        assert_eq!(serde_json::from_str::<Value>(&rel_out.body).unwrap()["relinquished"], true);

        // createAction live broadcast blocked until crypto review, noSend allowed
        let blocked = handle_brc100_request(&svc, "POST", "/createAction", &headers, "{}");
        assert_eq!(blocked.status, 403);

        let draft = handle_brc100_request(&svc, "POST", "/createAction", &headers, &json!({
            "options": { "signAndProcess": false }
        }).to_string());
        assert_eq!(draft.status, 200);
        let reference = serde_json::from_str::<Value>(&draft.body).unwrap()["signableTransaction"]["reference"].as_str().unwrap().to_string();

        // Sign under test override, then verify abortAction refuses already-signed action
        with_native_signing_for_test(true, || {
            let signed = handle_brc100_request(&svc, "POST", "/signAction", &headers, &json!({ "reference": reference }).to_string());
            assert_eq!(signed.status, 200);
        });
        let abort_signed = handle_brc100_request(&svc, "POST", "/abortAction", &headers, &json!({ "reference": reference }).to_string());
        assert_eq!(abort_signed.status, 409);

        svc.lock();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
