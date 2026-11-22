// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Durable transaction broadcaster (Arcade V2 `postBeef` + Bitails fallback)
//! classifying network silence separately from proven miner rejections.

use crate::rate_limit::HostRateLimiter;
use handcash_primitives::encoding::encode_hex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const ARCADE_V2_MAIN: &str = "https://arcade-v2-us-1.bsvblockchain.tech";
const ARCADE_V2_TEST: &str = "https://arcade-v2-testnet-us-1.bsvblockchain.tech";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub enum BroadcastVerdict {
    Accepted { provider: String, status_code: u16 },
    ProvenRejected { provider: String, status_code: u16, reason: String },
    Retryable { reason: String },
}

#[derive(Clone)]
pub struct Broadcaster {
    client: Client,
    limiter: HostRateLimiter,
    testnet: bool,
}

impl Broadcaster {
    pub fn new(client: Client, limiter: HostRateLimiter, testnet: bool) -> Self {
        Self {
            client,
            limiter,
            testnet,
        }
    }

    /// Broadcast an AtomicBEEF/BEEF payload via Arcade V2 first, falling back to Bitails raw hex.
    /// Explorer/network errors are ALWAYS `Retryable` — never treated as proven cancellation.
    pub async fn post_beef(&self, beef_bytes: &[u8]) -> BroadcastVerdict {
        let base = if self.testnet {
            ARCADE_V2_TEST
        } else {
            ARCADE_V2_MAIN
        };
        let host = if self.testnet {
            "arcade-v2-testnet-us-1.bsvblockchain.tech"
        } else {
            "arcade-v2-us-1.bsvblockchain.tech"
        };

        if let Ok(_permit) = self.limiter.acquire(host, Duration::from_secs(6)).await {
            let url = format!("{base}/v1/tx");
            match self
                .client
                .post(&url)
                .header("Content-Type", "application/octet-stream")
                .body(beef_bytes.to_vec())
                .send()
                .await
            {
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    if (200..300).contains(&code) {
                        self.limiter.note_success(host).await;
                        return BroadcastVerdict::Accepted {
                            provider: "arcade-v2".into(),
                            status_code: code,
                        };
                    }
                    // HTTP 466 / 460 / 461 / 463 / 464 are explicit ARC/Arcade double-spend or script rejects.
                    if matches!(code, 460 | 461 | 463 | 464 | 466) {
                        return BroadcastVerdict::ProvenRejected {
                            provider: "arcade-v2".into(),
                            status_code: code,
                            reason: body.chars().take(240).collect(),
                        };
                    }
                    if code == 429 || code >= 500 {
                        self.limiter.note_rate_limited(host, None).await;
                    }
                }
                Err(_) => {
                    self.limiter.note_rate_limited(host, None).await;
                }
            }
        }

        // Optional Bitails raw-tx broadcast fallback if the payload contains a parseable subject tx.
        if !self.testnet {
            if let Ok(beef) = handcash_bitcoin::beef::Beef::from_bytes(beef_bytes) {
                let raw_hex = beef
                    .atomic_txid
                    .as_deref()
                    .and_then(|id| beef.find_tx(id))
                    .and_then(|tx| tx.to_bytes().ok())
                    .map(|b| encode_hex(&b));
                if let Some(hex_str) = raw_hex {
                    if let Ok(_permit) = self
                        .limiter
                        .acquire("api.bitails.io", Duration::from_secs(6))
                        .await
                    {
                        let body = serde_json::json!({ "raw": hex_str });
                        if let Ok(resp) = self
                            .client
                            .post("https://api.bitails.io/tx/broadcast")
                            .json(&body)
                            .send()
                            .await
                        {
                            let code = resp.status().as_u16();
                            if (200..300).contains(&code) {
                                self.limiter.note_success("api.bitails.io").await;
                                return BroadcastVerdict::Accepted {
                                    provider: "bitails".into(),
                                    status_code: code,
                                };
                            }
                        }
                    }
                }
            }
        }

        BroadcastVerdict::Retryable {
            reason: "broadcasters unreachable or busy".into(),
        }
    }
}
