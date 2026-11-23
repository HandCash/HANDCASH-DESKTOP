// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Top-level `WalletEngine` runtime: generation-fenced per-account SQLite WAL
//! stores, 4-lane scheduler, unified Phase 2 background services, off-thread
//! BEEF/SPV + BRC-150 verification, native Rust BRC-39 encryption, and
//! coalesced view projection.

use crate::background::{
    header_to_row, load_or_fetch_verified_header, run_brc150_pass, run_lane2_sync_pass,
    spawn_background_runtime, verify_brc150_with_hydration, BackgroundContext, BackgroundHandle,
    BackgroundStats, Lane2SyncSummary,
};
use crate::contract::{
    AuthenticatedSession, PermissionGrant, RequestGuard, RequestRejection, ScopedRequest,
};
use crate::layers::{FreshnessGap, HoldingFreshness};
use crate::projector::{DirtySlices, EngineViewPatch, ViewProjector};
use crate::scheduler::WorkScheduler;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use handcash_bitcoin::beef::Beef;
use handcash_bitcoin::brc150::Brc150Verdict;
use handcash_net::{Broadcaster, ChainFetcher, HeaderFetcher, TxSourceKind};
use handcash_primitives::brc39::{decrypt_brc39, encrypt_brc39};
use handcash_primitives::encoding::{encode_hex, sha256};
use handcash_storage::{
    import_brc38_json, AccountStore, ActivityPage, BalanceBreakdown, Brc38ImportStats,
    FactSegment, ItemCardPage, StorageError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub enum EngineError {
    NoActiveAccount,
    WrongAccount,
    StaleGeneration { expected: u64, got: u64 },
    Storage(StorageError),
    Brc39(String),
    Network(String),
    InvalidParam(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoActiveAccount => write!(f, "no active wallet account"),
            Self::WrongAccount => write!(f, "account mismatch"),
            Self::StaleGeneration { expected, got } => {
                write!(f, "stale account generation (expected {expected}, got {got})")
            }
            Self::Storage(e) => write!(f, "{e}"),
            Self::Brc39(msg) => write!(f, "{msg}"),
            Self::Network(msg) => write!(f, "{msg}"),
            Self::InvalidParam(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<StorageError> for EngineError {
    fn from(e: StorageError) -> Self {
        Self::Storage(e)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateAccountResult {
    pub account_id: String,
    pub generation: u64,
    pub balance: BalanceBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedSourcesResult {
    pub found: HashMap<String, HydratedSourceEntry>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedSourceEntry {
    pub kind: String,
    pub bytes_base64: String,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeefVerifyResult {
    pub valid: bool,
    pub subject_txid: Option<String>,
    pub tx_count: usize,
    pub bump_count: usize,
    pub error: Option<String>,
}

struct ActiveRuntime {
    account_id: String,
    generation: u64,
    store: Arc<AccountStore>,
    holding: Arc<Mutex<HoldingFreshness>>,
    background: BackgroundHandle,
}

/// Authoritative Rust wallet engine shared across Desktop hosts and future Mobile FFI.
pub struct WalletEngine {
    accounts_dir: PathBuf,
    active: Mutex<Option<ActiveRuntime>>,
    generation_seq: Mutex<u64>,
    scheduler: WorkScheduler,
    fetcher: ChainFetcher,
    headers: HeaderFetcher,
    broadcaster: Broadcaster,
    projector: ViewProjector,
    request_guard: Mutex<RequestGuard>,
    rt: tokio::runtime::Runtime,
}

impl WalletEngine {
    pub fn open(user_data_dir: impl AsRef<Path>, testnet: bool) -> Result<Arc<Self>, EngineError> {
        let accounts_dir = user_data_dir.as_ref().join("engine-accounts");
        std::fs::create_dir_all(&accounts_dir)
            .map_err(|e| EngineError::Storage(StorageError::Io(e)))?;

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("handcash-engine")
            .enable_all()
            .build()
            .map_err(|e| EngineError::InvalidParam(format!("tokio runtime failed: {e}")))?;

        let fetcher =
            ChainFetcher::new(testnet).map_err(|e| EngineError::Network(e.to_string()))?;
        let headers = HeaderFetcher::new(fetcher.client().clone(), fetcher.limiter().clone(), testnet);
        let broadcaster =
            Broadcaster::new(fetcher.client().clone(), fetcher.limiter().clone(), testnet);
        let projector = ViewProjector::new();
        projector.spawn_flusher(rt.handle());

        Ok(Arc::new(Self {
            accounts_dir,
            active: Mutex::new(None),
            generation_seq: Mutex::new(0),
            scheduler: WorkScheduler::new(),
            fetcher,
            headers,
            broadcaster,
            projector,
            request_guard: Mutex::new(RequestGuard::default()),
            rt,
        }))
    }

    pub fn runtime_handle(&self) -> &tokio::runtime::Handle {
        self.rt.handle()
    }

    pub fn scheduler(&self) -> &WorkScheduler {
        &self.scheduler
    }

    pub fn set_push_handler<F>(&self, handler: F)
    where
        F: Fn(EngineViewPatch) + Send + Sync + 'static,
    {
        self.projector.set_push_handler(handler);
    }

    pub fn validate_request(
        &self,
        req: &ScopedRequest,
        session: &AuthenticatedSession,
        grant: &PermissionGrant,
        now_ms: u64,
    ) -> Result<(), RequestRejection> {
        let mut guard = self.request_guard.lock().unwrap_or_else(|e| e.into_inner());
        guard.validate(req, session, grant, now_ms)
    }

    fn db_path_for_account(&self, account_id: &str) -> PathBuf {
        let hash = encode_hex(&sha256(account_id.trim().as_bytes()));
        self.accounts_dir.join(&hash[..24]).join("wallet.sqlite3")
    }

    /// Activate an account: opens SQLite WAL, bumps monotonic generation, cancels
    /// any previous account's background runtime, and starts the new one.
    pub fn activate_account(&self, account_id: &str) -> Result<ActivateAccountResult, EngineError> {
        let trimmed = account_id.trim();
        if trimmed.is_empty() || trimmed.len() > 256 {
            return Err(EngineError::InvalidParam("invalid accountId".into()));
        }
        let db_path = self.db_path_for_account(trimmed);
        let store = Arc::new(AccountStore::open(&db_path, 3)?);
        let balance = store.balance_summary()?;

        let generation = {
            let mut gen = self.generation_seq.lock().unwrap_or_else(|e| e.into_inner());
            *gen = gen.saturating_add(1);
            *gen
        };

        let mut holding_val = HoldingFreshness::default();
        holding_val.record_gap(FreshnessGap::AccountSwitch);
        let holding = Arc::new(Mutex::new(holding_val));

        let bg_ctx = BackgroundContext {
            account_id: trimmed.to_string(),
            generation,
            store: Arc::clone(&store),
            holding: Arc::clone(&holding),
            scheduler: self.scheduler.clone(),
            fetcher: self.fetcher.clone(),
            headers: self.headers.clone(),
            broadcaster: self.broadcaster.clone(),
            projector: self.projector.clone(),
        };
        let background = spawn_background_runtime(self.rt.handle(), bg_ctx);

        {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            // Replacing the old Option drops its BackgroundHandle, stopping its Tokio tasks immediately.
            *active = Some(ActiveRuntime {
                account_id: trimmed.to_string(),
                generation,
                store,
                holding,
                background,
            });
        }

        self.projector
            .mark_dirty(trimmed, generation, DirtySlices::all(), Some(balance.clone()));

        Ok(ActivateAccountResult {
            account_id: trimmed.to_string(),
            generation,
            balance,
        })
    }

    /// Lock / deactivate the current account runtime and cancel all background tasks.
    pub fn lock(&self) {
        let mut gen = self.generation_seq.lock().unwrap_or_else(|e| e.into_inner());
        *gen = gen.saturating_add(1);
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        *active = None;
    }

    fn fenced_context(&self, account_id: &str, generation: u64) -> Result<BackgroundContext, EngineError> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let Some(rt) = active.as_ref() else {
            return Err(EngineError::NoActiveAccount);
        };
        if rt.account_id != account_id {
            return Err(EngineError::WrongAccount);
        }
        if rt.generation != generation {
            return Err(EngineError::StaleGeneration {
                expected: rt.generation,
                got: generation,
            });
        }
        Ok(BackgroundContext {
            account_id: rt.account_id.clone(),
            generation: rt.generation,
            store: Arc::clone(&rt.store),
            holding: Arc::clone(&rt.holding),
            scheduler: self.scheduler.clone(),
            fetcher: self.fetcher.clone(),
            headers: self.headers.clone(),
            broadcaster: self.broadcaster.clone(),
            projector: self.projector.clone(),
        })
    }

    fn fenced_store(&self, account_id: &str, generation: u64) -> Result<Arc<AccountStore>, EngineError> {
        Ok(self.fenced_context(account_id, generation)?.store)
    }

    /// Lane 1 interactive WAL read: instant balance breakdown (<1 ms).
    pub async fn read_balance(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<BalanceBreakdown, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        self.scheduler
            .run_read(move || store.balance_summary())
            .await
            .map_err(EngineError::InvalidParam)?
            .map_err(EngineError::Storage)
    }

    /// Lane 1 interactive WAL read: cursor-paged item cards (clamped <= 100 rows, <1 ms).
    pub async fn read_items_page(
        &self,
        account_id: &str,
        generation: u64,
        basket: String,
        cursor: Option<(i64, String)>,
        limit: usize,
    ) -> Result<ItemCardPage, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        self.scheduler
            .run_read(move || {
                let cur = cursor.as_ref().map(|(k, op)| (*k, op.as_str()));
                store.read_items_page(&basket, cur, limit)
            })
            .await
            .map_err(EngineError::InvalidParam)?
            .map_err(EngineError::Storage)
    }

    /// Lane 1 interactive WAL read: cursor-paged Activity feed (clamped <= 100 rows, <1 ms).
    pub async fn read_activity_page(
        &self,
        account_id: &str,
        generation: u64,
        cursor: Option<(i64, String)>,
        limit: usize,
    ) -> Result<ActivityPage, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        self.scheduler
            .run_read(move || {
                let cur = cursor.as_ref().map(|(ts, id)| (*ts, id.as_str()));
                store.read_activity_page(cur, limit)
            })
            .await
            .map_err(EngineError::InvalidParam)?
            .map_err(EngineError::Storage)
    }

    /// Lane 1 interactive WAL read: fetch one content-addressed blob (e.g. item art) by SHA-256 hex.
    pub async fn read_blob(
        &self,
        account_id: &str,
        generation: u64,
        sha256_hex: String,
    ) -> Result<Option<Vec<u8>>, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        self.scheduler
            .run_read(move || store.get_blob(&sha256_hex))
            .await
            .map_err(EngineError::InvalidParam)?
            .map_err(EngineError::Storage)
    }

    /// Export the account's SQLite WAL store as a canonical BRC-38 JSON document (no null fields).
    pub async fn export_brc38(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<String, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        let now = now_ms();
        self.scheduler
            .run_maintenance_blocking(move || handcash_storage::export_brc38_json(&store, now))
            .await
            .map_err(EngineError::InvalidParam)?
            .map_err(EngineError::Storage)
    }

    /// Non-destructive bootstrap import of a BRC-38 JSON document into SQLite WAL.
    pub async fn import_brc38(
        &self,
        account_id: &str,
        generation: u64,
        json: String,
    ) -> Result<Brc38ImportStats, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        let now_ms = now_ms();
        let (stats, balance) = self
            .scheduler
            .run_maintenance_blocking(
                move || -> Result<(Brc38ImportStats, BalanceBreakdown), StorageError> {
                    let stats = import_brc38_json(&store, &json, now_ms)?;
                    let balance = store.balance_summary()?;
                    Ok((stats, balance))
                },
            )
            .await
            .map_err(EngineError::InvalidParam)?
            .map_err(EngineError::Storage)?;

        if self.fenced_store(account_id, generation).is_ok() {
            self.projector
                .mark_dirty(account_id, generation, DirtySlices::all(), Some(balance));
        }
        Ok(stats)
    }

    /// Lane 3 native Rust BRC-39 encryption (128 MiB / 7-pass Argon2id + AES-256-GCM).
    pub async fn encrypt_brc39_async(
        &self,
        json: String,
        password: String,
    ) -> Result<Vec<u8>, EngineError> {
        self.scheduler
            .run_maintenance_blocking(move || encrypt_brc39(&json, &password))
            .await
            .map_err(EngineError::Brc39)?
            .map_err(|e| EngineError::Brc39(e.to_string()))
    }

    /// Lane 3 native Rust BRC-39 decryption.
    pub async fn decrypt_brc39_async(
        &self,
        bytes: Vec<u8>,
        password: String,
    ) -> Result<String, EngineError> {
        self.scheduler
            .run_maintenance_blocking(move || decrypt_brc39(&bytes, &password))
            .await
            .map_err(EngineError::Brc39)?
            .map_err(|e| EngineError::Brc39(e.to_string()))
    }

    /// Hydrate source tx bytes for a spend/burn: SQLite cold blobs first, then rate-limited ChainFetcher.
    pub async fn hydrate_input_txids(
        &self,
        account_id: &str,
        generation: u64,
        txids: Vec<String>,
        allow_raw: bool,
    ) -> Result<HydratedSourcesResult, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        let mut found = HashMap::new();
        let mut missing = Vec::new();

        for raw_txid in txids {
            let key = raw_txid.trim().to_ascii_lowercase();
            if key.len() != 64 || found.contains_key(&key) {
                continue;
            }
            if let Some((kind, bytes)) = store.get_tx_source_bytes(&key)? {
                found.insert(
                    key,
                    HydratedSourceEntry {
                        kind,
                        bytes_base64: BASE64.encode(&bytes),
                        from_cache: true,
                    },
                );
            } else {
                missing.push(key);
            }
        }

        if !missing.is_empty() {
            let (fetched, still_missing) = self.fetcher.fetch_batch(&missing, allow_raw).await;
            let ts = now_ms();
            for (txid, src) in fetched {
                let kind_str = match src.kind {
                    TxSourceKind::Beef => "beef",
                    TxSourceKind::RawTx => "raw_tx",
                };
                let _ = store.upsert_tx_blob(&txid, kind_str, &src.bytes, ts);
                found.insert(
                    txid,
                    HydratedSourceEntry {
                        kind: kind_str.into(),
                        bytes_base64: BASE64.encode(&src.bytes),
                        from_cache: false,
                    },
                );
            }
            missing = still_missing;
        }

        Ok(HydratedSourcesResult { found, missing })
    }

    /// Phase 2: Parse and cryptographically SPV-verify a BEEF/AtomicBEEF payload off the UI thread.
    pub async fn verify_beef_spv(
        &self,
        account_id: &str,
        generation: u64,
        beef_bytes: Vec<u8>,
        subject_txid: Option<String>,
    ) -> Result<BeefVerifyResult, EngineError> {
        let ctx = self.fenced_context(account_id, generation)?;
        let beef = match Beef::from_bytes(&beef_bytes) {
            Ok(b) => b,
            Err(e) => {
                return Ok(BeefVerifyResult {
                    valid: false,
                    subject_txid,
                    tx_count: 0,
                    bump_count: 0,
                    error: Some(e.to_string()),
                });
            }
        };

        let subj = subject_txid
            .filter(|s| !s.trim().is_empty())
            .or_else(|| beef.atomic_txid.clone());
        let tx_count = beef.txs.len();
        let bump_count = beef.bumps.len();

        // Pre-fetch & PoW-verify every block height referenced by BUMPs inside this BEEF.
        let mut header_map = HashMap::new();
        for bump in &beef.bumps {
            if let std::collections::hash_map::Entry::Vacant(entry) =
                header_map.entry(bump.block_height)
            {
                if let Some(h) = load_or_fetch_verified_header(&ctx, bump.block_height).await {
                    entry.insert(h);
                }
            }
        }

        let Some(ref target) = subj else {
            return Ok(BeefVerifyResult {
                valid: false,
                subject_txid: None,
                tx_count,
                bump_count,
                error: Some("missing subject txid".into()),
            });
        };

        match beef.verify_spv(target, &|h| header_map.get(&h).cloned()) {
            Ok(()) => Ok(BeefVerifyResult {
                valid: true,
                subject_txid: subj,
                tx_count,
                bump_count,
                error: None,
            }),
            Err(e) => Ok(BeefVerifyResult {
                valid: false,
                subject_txid: subj,
                tx_count,
                bump_count,
                error: Some(e.to_string()),
            }),
        }
    }

    /// Phase 2: Off-thread BRC-150 lineage verifier (SQLite cold blobs + rate-limited ChainFetcher).
    pub async fn verify_brc150(
        &self,
        account_id: &str,
        generation: u64,
        tip_outpoint: String,
        expected_origin: Option<String>,
        seed_beef_bytes: Option<Vec<u8>>,
    ) -> Result<Brc150Verdict, EngineError> {
        let ctx = self.fenced_context(account_id, generation)?;
        let verdict = verify_brc150_with_hydration(
            &ctx,
            &tip_outpoint,
            expected_origin.as_deref(),
            seed_beef_bytes.as_deref(),
        )
        .await;

        if let Brc150Verdict::Proven {
            ref origin_outpoint,
            ref content_type,
            ref name,
            ref issuer,
            ref body_bytes,
            ..
        } = verdict
        {
            let _ = ctx.store.mark_item_proven_brc150(
                &tip_outpoint,
                origin_outpoint,
                content_type,
                name.as_deref(),
                issuer.as_deref(),
                Some(body_bytes),
                now_ms(),
            );
            ctx.projector.mark_dirty(
                account_id,
                generation,
                DirtySlices {
                    balance: false,
                    items: true,
                    activity: false,
                    sync: false,
                },
                None,
            );
        }

        Ok(verdict)
    }

    /// Phase 2: Fetch & PoW-verify the current chain tip header into SQLite.
    pub async fn sync_headers(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<Option<u64>, EngineError> {
        let ctx = self.fenced_context(account_id, generation)?;
        if let Some(tip) = ctx.headers.fetch_tip_header().await {
            let height = tip.height;
            ctx.store.put_verified_header(&header_to_row(&tip), now_ms())?;
            return Ok(Some(height));
        }
        Ok(ctx.store.latest_header_height()?)
    }

    /// Phase 2: Run one Lane 2 pass on demand (headers + broadcast outbox + proof monitor).
    pub async fn run_proof_poll(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<Lane2SyncSummary, EngineError> {
        let ctx = self.fenced_context(account_id, generation)?;
        Ok(self
            .scheduler
            .run_chain_sync(|| run_lane2_sync_pass(&ctx))
            .await)
    }

    /// Phase 2: Run one Lane 3 idle BRC-150 pass on demand.
    pub async fn run_brc150_pass(
        &self,
        account_id: &str,
        generation: u64,
        max_items: usize,
    ) -> Result<u64, EngineError> {
        let ctx = self.fenced_context(account_id, generation)?;
        Ok(run_brc150_pass(&ctx, max_items.clamp(1, 10)).await)
    }

    /// Phase 2: Seal pending append-only facts into one immutable, tamper-evident segment.
    pub async fn seal_delta_segment(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<Option<FactSegment>, EngineError> {
        let store = self.fenced_store(account_id, generation)?;
        let now = now_ms();
        let sealed = self
            .scheduler
            .run_maintenance_blocking(move || store.seal_fact_segment(256, now))
            .await
            .map_err(EngineError::InvalidParam)?
            .map_err(EngineError::Storage)?;
        Ok(sealed.map(|(seg, _)| seg))
    }

    pub fn record_holding_checked(&self, now_ms: u64) {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rt) = active.as_ref() {
            let mut h = rt.holding.lock().unwrap_or_else(|e| e.into_inner());
            h.mark_checked(now_ms);
        }
    }

    pub fn status(&self) -> Value {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let bg_stats: BackgroundStats = active
            .as_ref()
            .map(|r| r.background.stats())
            .unwrap_or_default();
        let holding_needs_check = active
            .as_ref()
            .map(|r| {
                r.holding
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .needs_check()
            })
            .unwrap_or(true);
        json!({
            "engine": "handcash-wallet-core",
            "phase": 2,
            "storage": "sqlite-wal",
            "scheduler": "4-lane-tokio",
            "spendActive": self.scheduler.is_spend_active(),
            "activeAccount": active.as_ref().map(|r| r.account_id.clone()),
            "generation": active.as_ref().map(|r| r.generation).unwrap_or(0),
            "holdingNeedsCheck": holding_needs_check,
            "background": bg_stats,
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use handcash_bitcoin::tx::{TxInput, TxOutput};

    #[test]
    fn engine_activates_imports_brc38_reads_wal_and_fences_generations() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-engine-test-{nanos}"));
        let engine = WalletEngine::open(&dir, false).unwrap();

        let a1 = engine.activate_account("acct-alpha").unwrap();
        assert_eq!(a1.generation, 1);
        assert_eq!(a1.balance.spendable_sats, 0);

        let doc = serde_json::json!({
            "brc": 38,
            "tables": {
                "outputBaskets": [{ "basketId": 1, "name": "default" }, { "basketId": 2, "name": "1sat" }],
                "transactions": [{ "transactionId": 1, "txid": "11".repeat(32), "status": "completed", "isOutgoing": false, "satoshis": 77777, "description": "Seed" }],
                "outputs": [
                    { "outputId": 1, "transactionId": 1, "vout": 0, "satoshis": 77777, "basketId": 1, "spendable": true, "change": true },
                    { "outputId": 2, "transactionId": 1, "vout": 1, "satoshis": 1, "basketId": 2, "spendable": true, "change": false }
                ]
            }
        });

        let stats = engine
            .runtime_handle()
            .block_on(engine.import_brc38("acct-alpha", a1.generation, doc.to_string()))
            .unwrap();
        assert_eq!(stats.utxos, 2);
        assert_eq!(stats.items, 1);

        let bal = engine
            .runtime_handle()
            .block_on(engine.read_balance("acct-alpha", a1.generation))
            .unwrap();
        assert_eq!(bal.spendable_sats, 77_777);
        assert_eq!(bal.item_count, 1);

        let page = engine
            .runtime_handle()
            .block_on(engine.read_items_page("acct-alpha", a1.generation, "1sat".into(), None, 50))
            .unwrap();
        assert_eq!(page.items.len(), 1);

        // Switching accounts immediately stops old background runtime and invalidates gen 1.
        let a2 = engine.activate_account("acct-beta").unwrap();
        assert_eq!(a2.generation, 2);
        let stale = engine
            .runtime_handle()
            .block_on(engine.read_balance("acct-alpha", a1.generation));
        assert!(matches!(stale, Err(EngineError::WrongAccount)));

        engine.lock();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn phase2_brc150_verifies_from_local_sqlite_cold_blobs_and_upgrades_item() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hc-engine-p2-{nanos}"));
        let engine = WalletEngine::open(&dir, false).unwrap();
        let a1 = engine.activate_account("acct-brc150").unwrap();

        // Construct a real 2-hop 1Sat mint -> transfer pair stored in SQLite cold blobs.
        let mut ord_script = vec![0x00, 0x63, 3];
        ord_script.extend_from_slice(b"ord");
        ord_script.push(0x51);
        ord_script.push(9);
        ord_script.extend_from_slice(b"image/png");
        ord_script.push(0x00);
        ord_script.push(4);
        ord_script.extend_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
        ord_script.push(0x68);

        let mint = handcash_bitcoin::tx::Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev_txid: "01".repeat(32),
                prev_vout: 0,
                unlocking_script: vec![],
                sequence: u32::MAX,
            }],
            outputs: vec![TxOutput {
                satoshis: 1,
                locking_script: ord_script,
            }],
            lock_time: 0,
        };
        let mint_bytes = mint.to_bytes().unwrap();
        let mint_txid = mint.txid_hex().unwrap();

        let transfer = handcash_bitcoin::tx::Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev_txid: mint_txid.clone(),
                prev_vout: 0,
                unlocking_script: vec![],
                sequence: u32::MAX,
            }],
            outputs: vec![TxOutput {
                satoshis: 1,
                locking_script: vec![0x76, 0xa9],
            }],
            lock_time: 0,
        };
        let transfer_bytes = transfer.to_bytes().unwrap();
        let transfer_txid = transfer.txid_hex().unwrap();

        // Seed BRC-38 containing both raw txs and the transferred 1sat output.
        let doc = serde_json::json!({
            "brc": 38,
            "tables": {
                "outputBaskets": [{ "basketId": 2, "name": "1sat" }],
                "transactions": [
                    { "transactionId": 1, "txid": mint_txid, "status": "completed", "isOutgoing": false, "satoshis": 1, "rawTx": BASE64.encode(&mint_bytes) },
                    { "transactionId": 2, "txid": transfer_txid, "status": "completed", "isOutgoing": false, "satoshis": 1, "rawTx": BASE64.encode(&transfer_bytes) }
                ],
                "outputs": [
                    { "outputId": 10, "transactionId": 2, "vout": 0, "satoshis": 1, "basketId": 2, "spendable": true, "change": false }
                ]
            }
        });
        engine
            .runtime_handle()
            .block_on(engine.import_brc38("acct-brc150", a1.generation, doc.to_string()))
            .unwrap();

        // Run Lane 3 BRC-150 pass — proves the item offline from SQLite cold blobs + seals delta fact!
        let proven = engine
            .runtime_handle()
            .block_on(engine.run_brc150_pass("acct-brc150", a1.generation, 5))
            .unwrap();
        assert_eq!(proven, 1);

        let page = engine
            .runtime_handle()
            .block_on(engine.read_items_page("acct-brc150", a1.generation, "1sat".into(), None, 10))
            .unwrap();
        assert_eq!(page.items[0].authenticity_status, "proven_brc150");
        assert_eq!(page.items[0].origin_outpoint, format!("{mint_txid}.0"));
        assert_eq!(page.items[0].mime, "image/png");
        assert!(page.items[0].art_blob_hash.is_some());

        let seg = engine
            .runtime_handle()
            .block_on(engine.seal_delta_segment("acct-brc150", a1.generation))
            .unwrap()
            .unwrap();
        assert_eq!(seg.fact_count, 1);

        engine.lock();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
