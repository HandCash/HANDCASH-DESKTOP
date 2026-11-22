// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Singleflight, rate-limited, hedged BEEF & rawTx fetcher running off the UI thread.

use crate::rate_limit::HostRateLimiter;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use handcash_primitives::encoding::decode_hex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const HEDGE_DELAY: Duration = Duration::from_millis(1_200);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxSourceKind {
    Beef,
    RawTx,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedTxSource {
    pub txid: String,
    pub kind: TxSourceKind,
    pub bytes: Vec<u8>,
    pub provider: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    InvalidTxid(String),
    NotFound(String),
    Transport(String),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTxid(id) => write!(f, "invalid txid: {id}"),
            Self::NotFound(id) => write!(f, "source transaction not found: {id}"),
            Self::Transport(msg) => write!(f, "network error: {msg}"),
        }
    }
}

impl std::error::Error for FetchError {}

type InflightSlot = broadcast::Sender<Result<FetchedTxSource, FetchError>>;

/// Shared async HTTP chain fetcher with singleflight deduplication and per-host pacing.
#[derive(Clone)]
pub struct ChainFetcher {
    client: Client,
    limiter: HostRateLimiter,
    inflight: Arc<Mutex<HashMap<String, InflightSlot>>>,
    chain: &'static str,
}

impl ChainFetcher {
    pub fn new(testnet: bool) -> Result<Self, FetchError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(DEFAULT_TIMEOUT)
            .pool_max_idle_per_host(6)
            .build()
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        Ok(Self {
            client,
            limiter: HostRateLimiter::new(),
            inflight: Arc::new(Mutex::new(HashMap::new())),
            chain: if testnet { "test" } else { "main" },
        })
    }

    pub fn limiter(&self) -> &HostRateLimiter {
        &self.limiter
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn is_testnet(&self) -> bool {
        self.chain == "test"
    }

    /// Fetch a single transaction's BEEF (or raw tx when `allow_raw` is true),
    /// deduplicating concurrent requests for the same txid via singleflight.
    pub async fn fetch_tx_source(
        &self,
        txid: &str,
        allow_raw: bool,
    ) -> Result<FetchedTxSource, FetchError> {
        let key = txid.trim().to_ascii_lowercase();
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(FetchError::InvalidTxid(txid.to_string()));
        }

        let inflight_key = format!("{key}:{}", if allow_raw { "raw" } else { "beef" });
        let mut rx_opt = None;
        let tx_slot = {
            let mut map = self.inflight.lock().await;
            if let Some(existing) = map.get(&inflight_key) {
                rx_opt = Some(existing.subscribe());
                None
            } else {
                let (tx, _) = broadcast::channel(1);
                map.insert(inflight_key.clone(), tx.clone());
                Some(tx)
            }
        };

        if let Some(mut rx) = rx_opt {
            return rx
                .recv()
                .await
                .map_err(|_| FetchError::Transport("singleflight cancelled".into()))?;
        }

        let res = self.fetch_uncached(&key, allow_raw).await;
        {
            let mut map = self.inflight.lock().await;
            map.remove(&inflight_key);
        }
        if let Some(tx) = tx_slot {
            let _ = tx.send(res.clone());
        }
        res
    }

    async fn fetch_uncached(
        &self,
        txid: &str,
        allow_raw: bool,
    ) -> Result<FetchedTxSource, FetchError> {
        // 1. Primary: GorillaPool BEEF (fast for 1Sat/ordinals) hedged with WhatsOnChain BEEF.
        if self.chain == "main" {
            let gp = self.fetch_gorillapool_beef(txid);
            tokio::pin!(gp);

            tokio::select! {
                res = &mut gp => {
                    if let Ok(found) = res {
                        return Ok(found);
                    }
                }
                _ = tokio::time::sleep(HEDGE_DELAY) => {
                    // Hedge against WhatsOnChain through its strict rate limiter.
                    let woc = self.fetch_woc_beef(txid);
                    tokio::pin!(woc);
                    tokio::select! {
                        res = &mut gp => {
                            if let Ok(found) = res { return Ok(found); }
                            if let Ok(found) = woc.await { return Ok(found); }
                        }
                        res = &mut woc => {
                            if let Ok(found) = res { return Ok(found); }
                            if let Ok(found) = gp.await { return Ok(found); }
                        }
                    }
                    if allow_raw {
                        if let Ok(raw) = self.fetch_bitails_raw(txid).await {
                            return Ok(raw);
                        }
                    }
                    return Err(FetchError::NotFound(txid.to_string()));
                }
            }
        }

        // 2. Fallback: WhatsOnChain BEEF.
        if let Ok(found) = self.fetch_woc_beef(txid).await {
            return Ok(found);
        }

        // 3. Optional raw fallback via Bitails.
        if allow_raw {
            if let Ok(raw) = self.fetch_bitails_raw(txid).await {
                return Ok(raw);
            }
        }

        Err(FetchError::NotFound(txid.to_string()))
    }

    async fn fetch_gorillapool_beef(&self, txid: &str) -> Result<FetchedTxSource, FetchError> {
        let host = "ordinals.gorillapool.io";
        let _permit = self
            .limiter
            .acquire(host, Duration::from_secs(6))
            .await
            .map_err(|_| FetchError::Transport("gorillapool rate-limited".into()))?;
        let url = format!("https://{host}/api/tx/{txid}/beef");
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        if resp.status().as_u16() == 429 || resp.status().is_server_error() {
            self.limiter.note_rate_limited(host, None).await;
            return Err(FetchError::Transport(format!("gorillapool {}", resp.status())));
        }
        if !resp.status().is_success() {
            return Err(FetchError::NotFound(txid.to_string()));
        }
        self.limiter.note_success(host).await;
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?
            .to_vec();
        if bytes.is_empty() {
            return Err(FetchError::NotFound(txid.to_string()));
        }
        Ok(FetchedTxSource {
            txid: txid.to_string(),
            kind: TxSourceKind::Beef,
            bytes,
            provider: "gorillapool",
        })
    }

    async fn fetch_woc_beef(&self, txid: &str) -> Result<FetchedTxSource, FetchError> {
        let host = "api.whatsonchain.com";
        let _permit = self
            .limiter
            .acquire(host, Duration::from_secs(8))
            .await
            .map_err(|_| FetchError::Transport("whatsonchain rate-limited".into()))?;
        let url = format!("https://{host}/v1/bsv/{}/tx/{txid}/beef", self.chain);
        let resp = self
            .client
            .get(&url)
            .header("Accept", "text/plain")
            .send()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        if resp.status().as_u16() == 429 || resp.status().is_server_error() {
            self.limiter.note_rate_limited(host, None).await;
            return Err(FetchError::Transport(format!("woc {}", resp.status())));
        }
        if !resp.status().is_success() {
            return Err(FetchError::NotFound(txid.to_string()));
        }
        self.limiter.note_success(host).await;
        let body = resp
            .text()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        let trimmed = body.trim();
        let bytes = if trimmed.len() % 2 == 0 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
            decode_hex(trimmed).map_err(|e| FetchError::Transport(e.to_string()))?
        } else {
            BASE64
                .decode(trimmed)
                .map_err(|e| FetchError::Transport(e.to_string()))?
        };
        if bytes.is_empty() {
            return Err(FetchError::NotFound(txid.to_string()));
        }
        Ok(FetchedTxSource {
            txid: txid.to_string(),
            kind: TxSourceKind::Beef,
            bytes,
            provider: "whatsonchain",
        })
    }

    async fn fetch_bitails_raw(&self, txid: &str) -> Result<FetchedTxSource, FetchError> {
        let host = if self.chain == "test" {
            "test-api.bitails.io"
        } else {
            "api.bitails.io"
        };
        let _permit = self
            .limiter
            .acquire(host, Duration::from_secs(8))
            .await
            .map_err(|_| FetchError::Transport("bitails rate-limited".into()))?;
        let url = format!("https://{host}/download/tx/{txid}/hex");
        let resp = self
            .client
            .get(&url)
            .header("Accept", "text/plain")
            .send()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        if resp.status().as_u16() == 429 || resp.status().is_server_error() {
            self.limiter.note_rate_limited(host, None).await;
            return Err(FetchError::Transport(format!("bitails {}", resp.status())));
        }
        if !resp.status().is_success() {
            return Err(FetchError::NotFound(txid.to_string()));
        }
        self.limiter.note_success(host).await;
        let text = resp
            .text()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        let bytes =
            decode_hex(text.trim()).map_err(|e| FetchError::Transport(e.to_string()))?;
        if bytes.is_empty() {
            return Err(FetchError::NotFound(txid.to_string()));
        }
        Ok(FetchedTxSource {
            txid: txid.to_string(),
            kind: TxSourceKind::RawTx,
            bytes,
            provider: "bitails",
        })
    }

    /// Hydrate a batch of unique txids with bounded concurrency (max 3 in flight).
    pub async fn fetch_batch(
        &self,
        txids: &[String],
        allow_raw: bool,
    ) -> (HashMap<String, FetchedTxSource>, Vec<String>) {
        let mut unique: Vec<String> = txids
            .iter()
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        unique.sort();
        unique.dedup();

        let sem = Arc::new(tokio::sync::Semaphore::new(3));
        let mut handles = Vec::with_capacity(unique.len());
        for txid in unique {
            let fetcher = self.clone();
            let sem = Arc::clone(&sem);
            handles.push(tokio::spawn(async move {
                let _permit = sem.acquire_owned().await.ok()?;
                let res = fetcher.fetch_tx_source(&txid, allow_raw).await;
                Some((txid, res))
            }));
        }

        let mut found = HashMap::new();
        let mut missing = Vec::new();
        for handle in handles {
            if let Ok(Some((txid, res))) = handle.await {
                match res {
                    Ok(src) => {
                        found.insert(txid, src);
                    }
                    Err(_) => missing.push(txid),
                }
            }
        }
        (found, missing)
    }
}
