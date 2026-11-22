// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! PoW-verified Bitcoin block header fetcher with Arcade V2 Chaintracks primary,
//! Bitails and WhatsOnChain failover, and per-host rate limiting.

use crate::rate_limit::HostRateLimiter;
use handcash_bitcoin::header::BlockHeader;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

const ARCADE_V2_MAIN: &str = "https://arcade-v2-us-1.bsvblockchain.tech";
const ARCADE_V2_TEST: &str = "https://arcade-v2-testnet-us-1.bsvblockchain.tech";

#[derive(Clone)]
pub struct HeaderFetcher {
    client: Client,
    limiter: HostRateLimiter,
    testnet: bool,
}

impl HeaderFetcher {
    pub fn new(client: Client, limiter: HostRateLimiter, testnet: bool) -> Self {
        Self {
            client,
            limiter,
            testnet,
        }
    }

    fn arcade_base(&self) -> &'static str {
        if self.testnet {
            ARCADE_V2_TEST
        } else {
            ARCADE_V2_MAIN
        }
    }

    /// Fetch and PoW-verify the current chain tip header.
    pub async fn fetch_tip_header(&self) -> Option<BlockHeader> {
        // 1. Arcade V2 Chaintracks tip
        let arcade_url = format!("{}/chaintracks/v2/tip", self.arcade_base());
        if let Some(val) = self
            .fetch_json("arcade-v2-us-1.bsvblockchain.tech", &arcade_url)
            .await
        {
            if let Some(h) = parse_and_verify_header(&val, None) {
                return Some(h);
            }
        }
        // 2. Bitails latest block
        if !self.testnet {
            if let Some(val) = self
                .fetch_json("api.bitails.io", "https://api.bitails.io/block/latest")
                .await
            {
                if let Some(h) = parse_and_verify_header(&val, None) {
                    return Some(h);
                }
            }
        }
        None
    }

    /// Fetch and PoW-verify the block header at `height`.
    /// Never returns an unverified header (`BlockHeader::self_proving()` is mandatory).
    pub async fn fetch_header_at_height(&self, height: u64) -> Option<BlockHeader> {
        let arcade_url = format!(
            "{}/chaintracks/v2/header/height/{height}",
            self.arcade_base()
        );
        if let Some(val) = self
            .fetch_json("arcade-v2-us-1.bsvblockchain.tech", &arcade_url)
            .await
        {
            if let Some(h) = parse_and_verify_header(&val, Some(height)) {
                return Some(h);
            }
        }

        if !self.testnet {
            let bitails_url = format!("https://api.bitails.io/block/height/{height}");
            if let Some(val) = self.fetch_json("api.bitails.io", &bitails_url).await {
                if let Some(h) = parse_and_verify_header(&val, Some(height)) {
                    return Some(h);
                }
            }
        }

        let woc_chain = if self.testnet { "test" } else { "main" };
        let woc_url = format!("https://api.whatsonchain.com/v1/bsv/{woc_chain}/block/{height}/header");
        if let Some(val) = self.fetch_json("api.whatsonchain.com", &woc_url).await {
            if let Some(h) = parse_and_verify_header(&val, Some(height)) {
                return Some(h);
            }
        }

        None
    }

    async fn fetch_json(&self, host: &str, url: &str) -> Option<Value> {
        let _permit = self.limiter.acquire(host, Duration::from_secs(6)).await.ok()?;
        let resp = self
            .client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;
        if resp.status().as_u16() == 429 || resp.status().is_server_error() {
            self.limiter.note_rate_limited(host, None).await;
            return None;
        }
        if !resp.status().is_success() {
            return None;
        }
        self.limiter.note_success(host).await;
        resp.json::<Value>().await.ok()
    }
}

pub fn parse_and_verify_header(body: &Value, expected_height: Option<u64>) -> Option<BlockHeader> {
    // Some endpoints wrap the header inside `{ "value": { ... } }` or `{ "header": { ... } }`.
    let obj = body
        .get("header")
        .or_else(|| body.get("value"))
        .unwrap_or(body);
    let height = obj.get("height").and_then(|v| v.as_u64())?;
    if let Some(exp) = expected_height {
        if height != exp {
            return None;
        }
    }
    let hash = hex32(obj, &["hash"])?;
    let previous_hash = hex32(obj, &["previousblockhash", "previousBlockHash", "previousHash"])?;
    let merkle_root = hex32(obj, &["merkleroot", "merkleRoot"])?;
    let version = obj.get("version").and_then(|v| v.as_u64())? as u32;
    let time = obj.get("time").and_then(|v| v.as_u64())? as u32;
    let nonce = obj.get("nonce").and_then(|v| v.as_u64())? as u32;
    let bits = parse_bits(obj.get("bits")?)?;

    let header = BlockHeader {
        height,
        hash,
        version,
        previous_hash,
        merkle_root,
        time,
        bits,
        nonce,
    };
    header.self_proving().then_some(header)
}

fn hex32(obj: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = obj.get(*k).and_then(|v| v.as_str()) {
            let t = s.trim();
            if t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Some(t.to_ascii_lowercase());
            }
        }
    }
    None
}

fn parse_bits(val: &Value) -> Option<u32> {
    if let Some(n) = val.as_u64() {
        return u32::try_from(n).ok();
    }
    if let Some(s) = val.as_str() {
        return u32::from_str_radix(s.trim(), 16).ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_genesis_header_json_and_rejects_forged_pow() {
        let valid = json!({
            "height": 0,
            "hash": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
            "version": 1,
            "previousblockhash": "00".repeat(32),
            "merkleroot": "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
            "time": 1231006505,
            "bits": "1d00ffff",
            "nonce": 2083236893u64
        });
        assert!(parse_and_verify_header(&valid, Some(0)).is_some());

        let mut forged = valid;
        forged["nonce"] = json!(1);
        assert!(parse_and_verify_header(&forged, Some(0)).is_none());
    }
}
