// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Unified Phase 2 background runtime on Tokio Lanes 2 & 3.
//!
//! Replaces ~25 independent JS `setInterval` loops with ONE generation-fenced,
//! cancellation-safe background worker per active account:
//! - Holding freshness clock (5 s tick detecting >15 s suspension gaps)
//! - Lane 2: PoW-verified Header sync, Broadcast outbox drain, SPV Proof monitor
//! - Lane 3 (idle-only): BRC-150 lineage proof walker & append-only fact segment sealer
//!
//! Every step yields immediately when Lane 0 (`Spend`) is active and terminates
//! immediately when the account switches or locks.

use crate::layers::HoldingFreshness;
use crate::projector::{DirtySlices, ViewProjector};
use crate::scheduler::WorkScheduler;
use handcash_bitcoin::beef::Beef;
use handcash_bitcoin::brc150::{verify_lineage, Brc150Verdict, DEFAULT_MAX_HOPS};
use handcash_bitcoin::header::BlockHeader;
use handcash_net::{BroadcastVerdict, Broadcaster, ChainFetcher, HeaderFetcher, TxSourceKind};
use handcash_storage::{AccountStore, BlockHeaderRow};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

const HOLDING_TICK_SECS: u64 = 5;
const PROOF_POLL_SECS: u64 = 20;
const BRC150_IDLE_SECS: u64 = 30;
const DELTA_SEAL_SECS: u64 = 45;
const MAX_BRC150_FETCH_HOPS_PER_ITEM: usize = 32;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStats {
    pub running: bool,
    pub tip_height: Option<u64>,
    pub proofs_settled: u64,
    pub broadcasts_accepted: u64,
    pub items_proven_brc150: u64,
    pub segments_sealed: u64,
    pub suspension_gaps_detected: u64,
}

pub struct BackgroundHandle {
    cancel_tx: watch::Sender<bool>,
    running: Arc<AtomicBool>,
    tip_height: Arc<AtomicU64>,
    proofs_settled: Arc<AtomicU64>,
    broadcasts_accepted: Arc<AtomicU64>,
    items_proven: Arc<AtomicU64>,
    segments_sealed: Arc<AtomicU64>,
    suspension_gaps: Arc<AtomicU64>,
}

impl BackgroundHandle {
    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
        let _ = self.cancel_tx.send(true);
    }

    pub fn stats(&self) -> BackgroundStats {
        let tip = self.tip_height.load(Ordering::Acquire);
        BackgroundStats {
            running: self.running.load(Ordering::Acquire),
            tip_height: (tip > 0).then_some(tip),
            proofs_settled: self.proofs_settled.load(Ordering::Acquire),
            broadcasts_accepted: self.broadcasts_accepted.load(Ordering::Acquire),
            items_proven_brc150: self.items_proven.load(Ordering::Acquire),
            segments_sealed: self.segments_sealed.load(Ordering::Acquire),
            suspension_gaps_detected: self.suspension_gaps.load(Ordering::Acquire),
        }
    }
}

impl Drop for BackgroundHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
pub struct BackgroundContext {
    pub account_id: String,
    pub generation: u64,
    pub store: Arc<AccountStore>,
    pub holding: Arc<Mutex<HoldingFreshness>>,
    pub scheduler: WorkScheduler,
    pub fetcher: ChainFetcher,
    pub headers: HeaderFetcher,
    pub broadcaster: Broadcaster,
    pub projector: ViewProjector,
}

/// Spawn the unified generation-fenced background runtime on the Tokio handle.
pub fn spawn_background_runtime(
    handle: &tokio::runtime::Handle,
    ctx: BackgroundContext,
) -> BackgroundHandle {
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let running = Arc::new(AtomicBool::new(true));
    let tip_height = Arc::new(AtomicU64::new(
        ctx.store.latest_header_height().ok().flatten().unwrap_or(0),
    ));
    let proofs_settled = Arc::new(AtomicU64::new(0));
    let broadcasts_accepted = Arc::new(AtomicU64::new(0));
    let items_proven = Arc::new(AtomicU64::new(0));
    let segments_sealed = Arc::new(AtomicU64::new(0));
    let suspension_gaps = Arc::new(AtomicU64::new(0));

    let bg = BackgroundHandle {
        cancel_tx,
        running: Arc::clone(&running),
        tip_height: Arc::clone(&tip_height),
        proofs_settled: Arc::clone(&proofs_settled),
        broadcasts_accepted: Arc::clone(&broadcasts_accepted),
        items_proven: Arc::clone(&items_proven),
        segments_sealed: Arc::clone(&segments_sealed),
        suspension_gaps: Arc::clone(&suspension_gaps),
    };

    handle.spawn(async move {
        let mut holding_tick = tokio::time::interval(Duration::from_secs(HOLDING_TICK_SECS));
        let mut proof_tick = tokio::time::interval(Duration::from_secs(PROOF_POLL_SECS));
        let mut brc150_tick = tokio::time::interval(Duration::from_secs(BRC150_IDLE_SECS));
        let mut seal_tick = tokio::time::interval(Duration::from_secs(DELTA_SEAL_SECS));

        // Skip immediate burst on boot so unlock/paint gets full priority.
        holding_tick.reset();
        proof_tick.reset();
        brc150_tick.reset();
        seal_tick.reset();

        loop {
            tokio::select! {
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        break;
                    }
                }
                _ = holding_tick.tick() => {
                    let now = now_ms() as u64;
                    let paused = {
                        let mut h = ctx.holding.lock().unwrap_or_else(|e| e.into_inner());
                        h.record_serve_tick(now)
                    };
                    if paused {
                        suspension_gaps.fetch_add(1, Ordering::AcqRel);
                    }
                }
                _ = proof_tick.tick() => {
                    if *cancel_rx.borrow() || ctx.scheduler.is_spend_active() {
                        continue;
                    }
                    let summary = ctx
                        .scheduler
                        .run_chain_sync(|| run_lane2_sync_pass(&ctx))
                        .await;
                    if let Some(h) = summary.tip_height {
                        tip_height.store(h, Ordering::Release);
                    }
                    if summary.proofs_settled > 0 {
                        proofs_settled.fetch_add(summary.proofs_settled, Ordering::AcqRel);
                    }
                    if summary.broadcasts_accepted > 0 {
                        broadcasts_accepted.fetch_add(summary.broadcasts_accepted, Ordering::AcqRel);
                    }
                }
                _ = brc150_tick.tick() => {
                    if *cancel_rx.borrow() || ctx.scheduler.is_spend_active() {
                        continue;
                    }
                    let proven = run_brc150_pass(&ctx, 2).await;
                    if proven > 0 {
                        items_proven.fetch_add(proven, Ordering::AcqRel);
                    }
                }
                _ = seal_tick.tick() => {
                    if *cancel_rx.borrow() || ctx.scheduler.is_spend_active() {
                        continue;
                    }
                    let store = Arc::clone(&ctx.store);
                    let now = now_ms();
                    if let Ok(Ok(Some(_))) = ctx
                        .scheduler
                        .run_maintenance_blocking(move || store.seal_fact_segment(256, now))
                        .await
                    {
                        segments_sealed.fetch_add(1, Ordering::AcqRel);
                    }
                }
            }
        }
        running.store(false, Ordering::Release);
    });

    bg
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane2SyncSummary {
    pub tip_height: Option<u64>,
    pub broadcasts_accepted: u64,
    pub proofs_settled: u64,
}

/// One Lane 2 pass: sync tip header -> drain durable broadcast outbox -> SPV-verify due proof_requests.
pub async fn run_lane2_sync_pass(ctx: &BackgroundContext) -> Lane2SyncSummary {
    let mut out = Lane2SyncSummary::default();
    let now = now_ms();

    // 1. Sync PoW-verified chain tip header.
    if let Some(tip) = ctx.headers.fetch_tip_header().await {
        let row = header_to_row(&tip);
        let _ = ctx.store.put_verified_header(&row, now);
        out.tip_height = Some(tip.height);
    }

    if ctx.scheduler.is_spend_active() {
        return out;
    }

    // 2. Drain durable broadcast outbox (never aborts a signed tx on network silence).
    if let Ok(entries) = ctx.store.list_due_outbox(now, 8) {
        for entry in entries {
            if ctx.scheduler.is_spend_active() {
                break;
            }
            if entry.kind != "broadcast" {
                continue;
            }
            let Ok(Some(bytes)) = ctx.store.get_blob(&entry.payload_blob_hash) else {
                continue;
            };
            match ctx.broadcaster.post_beef(&bytes).await {
                BroadcastVerdict::Accepted { .. } => {
                    let _ = ctx.store.mark_outbox_delivered(&entry.id, now_ms());
                    if let Some(txid) = &entry.txid {
                        let _ = ctx.store.update_tx_status(txid, "accepted", now_ms());
                    }
                    out.broadcasts_accepted += 1;
                }
                BroadcastVerdict::ProvenRejected { .. } => {
                    let _ = ctx.store.mark_outbox_delivered(&entry.id, now_ms());
                    if let Some(txid) = &entry.txid {
                        let _ = ctx.store.update_tx_status(txid, "proven_rejected", now_ms());
                    }
                }
                BroadcastVerdict::Retryable { .. } => {
                    let backoff_ms = 15_000i64 * (1i64 << entry.attempts.min(5));
                    let _ = ctx
                        .store
                        .bump_outbox_retry(&entry.id, now_ms() + backoff_ms, now_ms());
                }
            }
        }
    }

    // 3. Poll due proof_requests and SPV-verify BUMPs against PoW-verified block headers.
    if let Ok(reqs) = ctx.store.list_due_proof_requests(now, 6) {
        for req in reqs {
            if ctx.scheduler.is_spend_active() {
                break;
            }
            if settle_proof_request(ctx, &req.txid).await {
                out.proofs_settled += 1;
            } else {
                let backoff_ms = 20_000i64 * (1i64 << req.attempts.min(5));
                let _ = ctx
                    .store
                    .bump_proof_request_retry(&req.txid, now_ms() + backoff_ms, now_ms());
            }
        }
    }

    if out.proofs_settled > 0 || out.broadcasts_accepted > 0 {
        let bal = ctx.store.balance_summary().ok();
        ctx.projector.mark_dirty(
            &ctx.account_id,
            ctx.generation,
            DirtySlices {
                balance: out.proofs_settled > 0,
                items: false,
                activity: true,
                sync: true,
            },
            bal,
        );
    }

    out
}

async fn settle_proof_request(ctx: &BackgroundContext, txid: &str) -> bool {
    let Ok(src) = ctx.fetcher.fetch_tx_source(txid, false).await else {
        return false;
    };
    if src.kind != TxSourceKind::Beef {
        return false;
    }
    let Ok(beef) = Beef::from_bytes(&src.bytes) else {
        return false;
    };
    let Some(bump) = beef.find_bump(txid) else {
        return false;
    };
    let header = match load_or_fetch_verified_header(ctx, bump.block_height).await {
        Some(h) => h,
        None => return false,
    };
    let Ok(merkle_root) = bump.verify_against_header(txid, &header) else {
        return false;
    };
    let bump_bytes = bump.to_bytes();
    let now = now_ms();
    let _ = ctx.store.upsert_tx_blob(txid, "beef", &src.bytes, now);
    ctx.store
        .mark_tx_mined(txid, header.height, &merkle_root, &bump_bytes, now)
        .is_ok()
}

pub async fn load_or_fetch_verified_header(
    ctx: &BackgroundContext,
    height: u64,
) -> Option<BlockHeader> {
    if let Ok(Some(row)) = ctx.store.get_header(height) {
        let h = row_to_header(&row);
        if h.self_proving() {
            return Some(h);
        }
    }
    let fetched = ctx.headers.fetch_header_at_height(height).await?;
    let _ = ctx
        .store
        .put_verified_header(&header_to_row(&fetched), now_ms());
    Some(fetched)
}

/// One Lane 3 idle pass: verify up to `max_items` unproven 1Sat items via BRC-150 off-thread.
pub async fn run_brc150_pass(ctx: &BackgroundContext, max_items: usize) -> u64 {
    let Ok(items) = ctx.store.list_unproven_items(max_items) else {
        return 0;
    };
    let mut proven_count = 0u64;

    for item in items {
        if ctx.scheduler.is_spend_active() {
            break;
        }
        let verdict = verify_brc150_with_hydration(
            ctx,
            &item.outpoint,
            (item.origin_outpoint != item.outpoint).then_some(item.origin_outpoint.as_str()),
            None,
        )
        .await;
        if let Brc150Verdict::Proven {
            origin_outpoint,
            content_type,
            name,
            issuer,
            body_bytes,
            ..
        } = verdict
        {
            if ctx
                .store
                .mark_item_proven_brc150(
                    &item.outpoint,
                    &origin_outpoint,
                    &content_type,
                    name.as_deref(),
                    issuer.as_deref(),
                    Some(&body_bytes),
                    now_ms(),
                )
                .is_ok()
            {
                proven_count += 1;
            }
        }
    }

    if proven_count > 0 {
        ctx.projector.mark_dirty(
            &ctx.account_id,
            ctx.generation,
            DirtySlices {
                balance: false,
                items: true,
                activity: false,
                sync: false,
            },
            None,
        );
    }

    proven_count
}

/// Verify BRC-150 lineage for `tip_outpoint`, hydrating any missing hop transactions
/// from SQLite cold blobs first, then through the rate-limited singleflight `ChainFetcher`.
pub async fn verify_brc150_with_hydration(
    ctx: &BackgroundContext,
    tip_outpoint: &str,
    expected_origin: Option<&str>,
    seed_beef_bytes: Option<&[u8]>,
) -> Brc150Verdict {
    let mut beef = match seed_beef_bytes {
        Some(bytes) if !bytes.is_empty() => match Beef::from_bytes(bytes) {
            Ok(b) => b,
            Err(e) => {
                return Brc150Verdict::Unproven {
                    reason: format!("invalid seed BEEF: {e}"),
                    missing_txid: None,
                };
            }
        },
        _ => Beef::default(),
    };

    for _step in 0..MAX_BRC150_FETCH_HOPS_PER_ITEM {
        let verdict = verify_lineage(tip_outpoint, expected_origin, &beef, DEFAULT_MAX_HOPS);
        let missing_txid = match &verdict {
            Brc150Verdict::Proven { .. } => return verdict,
            Brc150Verdict::Unproven {
                missing_txid: Some(id),
                ..
            } => id.clone(),
            Brc150Verdict::Unproven { .. } => return verdict,
        };

        // Try local SQLite cold blob store first (microseconds).
        if let Ok(Some((kind, bytes))) = ctx.store.get_tx_source_bytes(&missing_txid) {
            let merged = if kind == "beef" {
                Beef::from_bytes(&bytes)
                    .map(|b| {
                        beef.merge_beef(b);
                        true
                    })
                    .unwrap_or(false)
            } else {
                beef.merge_raw_tx(&bytes).is_ok()
            };
            if merged && beef.find_tx(&missing_txid).is_some() {
                continue;
            }
        }

        // Fall back to rate-limited, singleflight ChainFetcher and persist in SQLite cold blobs.
        match ctx.fetcher.fetch_tx_source(&missing_txid, true).await {
            Ok(src) => {
                let kind_label = match src.kind {
                    TxSourceKind::Beef => "beef",
                    TxSourceKind::RawTx => "raw_tx",
                };
                let _ = ctx
                    .store
                    .upsert_tx_blob(&missing_txid, kind_label, &src.bytes, now_ms());
                let merged = match src.kind {
                    TxSourceKind::Beef => Beef::from_bytes(&src.bytes)
                        .map(|b| {
                            beef.merge_beef(b);
                            true
                        })
                        .unwrap_or(false),
                    TxSourceKind::RawTx => beef.merge_raw_tx(&src.bytes).is_ok(),
                };
                if !merged || beef.find_tx(&missing_txid).is_none() {
                    return Brc150Verdict::Unproven {
                        reason: format!("fetched source for {missing_txid} did not decode cleanly"),
                        missing_txid: Some(missing_txid),
                    };
                }
            }
            Err(_) => return verdict,
        }
    }

    Brc150Verdict::Unproven {
        reason: format!("exceeded {MAX_BRC150_FETCH_HOPS_PER_ITEM} hydration hops"),
        missing_txid: None,
    }
}

pub fn header_to_row(h: &BlockHeader) -> BlockHeaderRow {
    BlockHeaderRow {
        height: h.height,
        hash: h.hash.clone(),
        version: h.version,
        previous_hash: h.previous_hash.clone(),
        merkle_root: h.merkle_root.clone(),
        time: h.time,
        bits: h.bits,
        nonce: h.nonce,
    }
}

pub fn row_to_header(r: &BlockHeaderRow) -> BlockHeader {
    BlockHeader {
        height: r.height,
        hash: r.hash.clone(),
        version: r.version,
        previous_hash: r.previous_hash.clone(),
        merkle_root: r.merkle_root.clone(),
        time: r.time,
        bits: r.bits,
        nonce: r.nonce,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
