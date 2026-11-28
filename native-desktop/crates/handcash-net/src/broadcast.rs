// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Durable transaction broadcaster mirroring the TS wallet-engine `Arcade` provider
//! (`POST {base}/tx` with `{ rawTx: <EF hex> }`, 2xx = queued submit) with a Bitails
//! fallback in toolbox `UntilSuccess` order. Network silence stays separate from
//! proven node rejections.

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

    /// Broadcast the subject transaction of an AtomicBEEF/BEEF payload.
    ///
    /// Arcade first (EF at `/tx`, as TS `Arcade.postBeef`), then Bitails raw hex on mainnet;
    /// like toolbox `UntilSuccess`, any non-success moves on to the next provider. A node's
    /// rejection is only reported when no provider accepted. Network errors are `Retryable`.
    pub async fn post_beef(&self, beef_bytes: &[u8]) -> BroadcastVerdict {
        let Ok(beef) = handcash_bitcoin::beef::Beef::from_bytes(beef_bytes) else {
            return BroadcastVerdict::ProvenRejected {
                provider: "local".into(),
                status_code: 0,
                reason: "payload is not BEEF".into(),
            };
        };
        let Some(subject) = subject_txid(&beef) else {
            return BroadcastVerdict::ProvenRejected {
                provider: "local".into(),
                status_code: 0,
                reason: "BEEF has no subject transaction".into(),
            };
        };

        let mut rejection: Option<BroadcastVerdict> = None;
        let mut retry_reason = "broadcasters unreachable or busy".to_string();

        // EF needs every direct parent in full; without it Arcade cannot be used (TS records a
        // service error and falls through to the next provider).
        if let Ok(ef) = beef.ef_bytes_for(&subject) {
            match self.post_arcade(&encode_hex(&ef)).await {
                v @ BroadcastVerdict::Accepted { .. } => return v,
                v @ BroadcastVerdict::ProvenRejected { .. } => rejection = Some(v),
                BroadcastVerdict::Retryable { reason } => retry_reason = reason,
            }
        }

        if !self.testnet {
            if let Some(raw_hex) = beef
                .find_tx(&subject)
                .and_then(|tx| tx.to_bytes().ok())
                .map(|b| encode_hex(&b))
            {
                if let Some(v) = self.post_bitails(&raw_hex).await {
                    return v;
                }
            }
        }

        rejection.unwrap_or(BroadcastVerdict::Retryable {
            reason: retry_reason,
        })
    }

    async fn post_arcade(&self, ef_hex: &str) -> BroadcastVerdict {
        let (base, host) = if self.testnet {
            (ARCADE_V2_TEST, "arcade-v2-testnet-us-1.bsvblockchain.tech")
        } else {
            (ARCADE_V2_MAIN, "arcade-v2-us-1.bsvblockchain.tech")
        };
        if self
            .limiter
            .acquire(host, Duration::from_secs(6))
            .await
            .is_err()
        {
            return BroadcastVerdict::Retryable {
                reason: "arcade busy".into(),
            };
        }
        let resp = self
            .client
            .post(format!("{base}/tx"))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "rawTx": ef_hex }))
            .timeout(Duration::from_secs(30))
            .send()
            .await;
        let Ok(resp) = resp else {
            self.limiter.note_rate_limited(host, None).await;
            return BroadcastVerdict::Retryable {
                reason: "arcade unreachable".into(),
            };
        };
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let verdict = classify_arcade_post(code, &body);
        match &verdict {
            BroadcastVerdict::Accepted { .. } => self.limiter.note_success(host).await,
            BroadcastVerdict::Retryable { .. } if code == 429 || code >= 500 => {
                self.limiter.note_rate_limited(host, None).await
            }
            _ => {}
        }
        verdict
    }

    async fn post_bitails(&self, raw_hex: &str) -> Option<BroadcastVerdict> {
        let _permit = self
            .limiter
            .acquire("api.bitails.io", Duration::from_secs(6))
            .await
            .ok()?;
        let resp = self
            .client
            .post("https://api.bitails.io/tx/broadcast")
            .json(&serde_json::json!({ "raw": raw_hex }))
            .send()
            .await
            .ok()?;
        let code = resp.status().as_u16();
        if (200..300).contains(&code) {
            self.limiter.note_success("api.bitails.io").await;
            return Some(BroadcastVerdict::Accepted {
                provider: "bitails".into(),
                status_code: code,
            });
        }
        None
    }
}

/// The transaction to broadcast: the AtomicBEEF subject, else the one full transaction that
/// no other transaction in the bundle spends.
fn subject_txid(beef: &handcash_bitcoin::beef::Beef) -> Option<String> {
    if let Some(id) = &beef.atomic_txid {
        return Some(id.clone());
    }
    let spent: std::collections::HashSet<&str> = beef
        .txs
        .values()
        .filter_map(|e| e.tx.as_ref())
        .flat_map(|tx| tx.inputs.iter().map(|i| i.prev_txid.as_str()))
        .collect();
    let mut tips = beef
        .txs
        .values()
        .filter(|e| e.tx.is_some() && !spent.contains(e.txid.as_str()));
    let tip = tips.next()?;
    tips.next().is_none().then(|| tip.txid.clone())
}

/// TS `Arcade.postRawTx` response handling. 2xx is accepted unless the body names a double
/// spend; non-2xx is a rejection unless it is a service error (`isArcServiceErrorStatus`).
pub fn classify_arcade_post(code: u16, body: &str) -> BroadcastVerdict {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let field = |k: &str| json.get(k).and_then(|v| v.as_str()).unwrap_or("").trim();
    let tx_status = field("txStatus").to_ascii_uppercase();
    let detail = field("detail");
    let extra = field("extraInfo");
    let reason: String = [tx_status.as_str(), extra, detail]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect();

    if (200..300).contains(&code) {
        if matches!(
            tx_status.as_str(),
            "DOUBLE_SPEND_ATTEMPTED" | "SEEN_IN_ORPHAN_MEMPOOL"
        ) {
            return BroadcastVerdict::ProvenRejected {
                provider: "arcade".into(),
                status_code: code,
                reason,
            };
        }
        return BroadcastVerdict::Accepted {
            provider: "arcade".into(),
            status_code: code,
        };
    }
    if is_arc_service_error_status(code, detail) {
        return BroadcastVerdict::Retryable {
            reason: if reason.is_empty() {
                format!("arcade HTTP {code}")
            } else {
                reason
            },
        };
    }
    BroadcastVerdict::ProvenRejected {
        provider: "arcade".into(),
        status_code: code,
        reason,
    }
}

/// TS `isArcServiceErrorStatus`.
fn is_arc_service_error_status(code: u16, detail: &str) -> bool {
    if matches!(code, 408 | 429 | 476) || code >= 500 {
        return true;
    }
    let d = detail.to_ascii_lowercase();
    [
        "maximum batch size",
        "too many requests",
        "rate limit",
        "timeout",
        "temporarily",
        "backpressure",
        "unavailable",
    ]
    .iter()
    .any(|p| d.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arcade_post_classification_matches_ts() {
        assert!(matches!(
            classify_arcade_post(202, r#"{"txStatus":"RECEIVED"}"#),
            BroadcastVerdict::Accepted { status_code: 202, .. }
        ));
        assert!(matches!(
            classify_arcade_post(200, r#"{"txStatus":"DOUBLE_SPEND_ATTEMPTED"}"#),
            BroadcastVerdict::ProvenRejected { .. }
        ));
        assert!(matches!(
            classify_arcade_post(400, r#"{"detail":"failed to parse transaction"}"#),
            BroadcastVerdict::ProvenRejected { status_code: 400, .. }
        ));
        assert!(matches!(
            classify_arcade_post(466, ""),
            BroadcastVerdict::ProvenRejected { status_code: 466, .. }
        ));
        for code in [408, 429, 476, 500, 503] {
            assert!(matches!(
                classify_arcade_post(code, ""),
                BroadcastVerdict::Retryable { .. }
            ));
        }
        assert!(matches!(
            classify_arcade_post(400, r#"{"detail":"service temporarily unavailable"}"#),
            BroadcastVerdict::Retryable { .. }
        ));
    }
}
