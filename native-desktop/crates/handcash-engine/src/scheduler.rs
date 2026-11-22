// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 4-lane priority scheduler replacing ~25 independent JS setInterval loops and
//! manual `spendPriorityHolds` choreography.
//!
//! - Lane 0 (`Spend`): Serialized, preemptive. Sets `spend_active = true`, cleanly
//!   pausing Lane 2 (`ChainSync`) and Lane 3 (`Maintenance`) at their next yield point.
//! - Lane 1 (`InteractiveRead`): Runs concurrently on SQLite WAL ReadPool; never
//!   waits on Spend, ChainSync, or Maintenance.
//! - Lane 2 (`ChainSync`): Pausable background network/proof sync.
//! - Lane 3 (`Maintenance`): Idle-only CPU-intensive work (`spawn_blocking` Argon2id,
//!   BRC-150 lineage walks, blob GC).

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{watch, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    Spend,
    InteractiveRead,
    ChainSync,
    Maintenance,
}

#[derive(Clone)]
pub struct WorkScheduler {
    spend_lock: Arc<Mutex<()>>,
    spend_waiting: Arc<AtomicUsize>,
    spend_tx: Arc<watch::Sender<bool>>,
    spend_rx: watch::Receiver<bool>,
}

impl Default for WorkScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkScheduler {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self {
            spend_lock: Arc::new(Mutex::new(())),
            spend_waiting: Arc::new(AtomicUsize::new(0)),
            spend_tx: Arc::new(tx),
            spend_rx: rx,
        }
    }

    pub fn is_spend_active(&self) -> bool {
        *self.spend_rx.borrow() || self.spend_waiting.load(Ordering::Acquire) > 0
    }

    /// Lane 0: Execute a spend exclusively while signaling background lanes to pause.
    pub async fn run_spend<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.spend_waiting.fetch_add(1, Ordering::AcqRel);
        let _ = self.spend_tx.send(true);
        let _guard = self.spend_lock.lock().await;
        let out = f().await;
        let remaining = self.spend_waiting.fetch_sub(1, Ordering::AcqRel) - 1;
        if remaining == 0 {
            let _ = self.spend_tx.send(false);
        }
        out
    }

    /// Lane 1: Execute an interactive WAL read immediately with zero contention.
    pub async fn run_read<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| format!("read task failed: {e}"))
    }

    /// Wait until Lane 0 (`Spend`) is idle before proceeding with Lane 2/3 work.
    pub async fn wait_until_spend_idle(&self) {
        let mut rx = self.spend_rx.clone();
        while *rx.borrow() {
            if rx.changed().await.is_err() {
                break;
            }
        }
    }

    /// Lane 2: Execute pausable background chain sync only when no spend is active.
    pub async fn run_chain_sync<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.wait_until_spend_idle().await;
        f().await
    }

    /// Lane 3: Execute heavy CPU work (e.g. native Argon2id BRC-39) on a blocking OS thread
    /// only after any foreground spend finishes. Never blocks UI or Lane 1 reads.
    pub async fn run_maintenance_blocking<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        self.wait_until_spend_idle().await;
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| format!("maintenance task failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    #[tokio::test]
    async fn lane0_spend_pauses_lane3_while_lane1_read_runs_unblocked() {
        let sched = WorkScheduler::new();
        let maint_ran_during_spend = Arc::new(AtomicBool::new(false));
        let spend_holding = Arc::new(AtomicBool::new(false));

        let s1 = sched.clone();
        let sh1 = Arc::clone(&spend_holding);
        let spend_task = tokio::spawn(async move {
            s1.run_spend(|| async move {
                sh1.store(true, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(80)).await;
                sh1.store(false, Ordering::SeqCst);
            })
            .await;
        });

        tokio::time::sleep(Duration::from_millis(15)).await;
        assert!(sched.is_spend_active());

        // Lane 1 interactive read completes immediately while Spend is active.
        let read_val = sched.run_read(|| 42u64).await.unwrap();
        assert_eq!(read_val, 42);
        assert!(spend_holding.load(Ordering::SeqCst));

        // Lane 3 maintenance waits until Spend finishes.
        let s3 = sched.clone();
        let sh3 = Arc::clone(&spend_holding);
        let flag = Arc::clone(&maint_ran_during_spend);
        let maint_task = tokio::spawn(async move {
            s3.run_maintenance_blocking(move || {
                if sh3.load(Ordering::SeqCst) {
                    flag.store(true, Ordering::SeqCst);
                }
            })
            .await
            .unwrap();
        });

        spend_task.await.unwrap();
        maint_task.await.unwrap();
        assert!(!maint_ran_during_spend.load(Ordering::SeqCst));
    }
}
