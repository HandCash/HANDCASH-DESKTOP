// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Coalesced push-based ViewProjector eliminating 100+ commit/10s React render storms.
//!
//! Collects dirty view slices (`balance`, `items`, `activity`, `sync`) and flushes
//! at most one `EngineViewPatch` per 50 ms window (<= 20 Hz, 0 Hz when idle).

use handcash_storage::BalanceBreakdown;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub const COALESCE_WINDOW_MS: u64 = 50;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtySlices {
    pub balance: bool,
    pub items: bool,
    pub activity: bool,
    pub sync: bool,
}

impl DirtySlices {
    pub fn any(&self) -> bool {
        self.balance || self.items || self.activity || self.sync
    }

    pub fn merge(&mut self, other: &DirtySlices) {
        self.balance |= other.balance;
        self.items |= other.items;
        self.activity |= other.activity;
        self.sync |= other.sync;
    }

    pub fn all() -> Self {
        Self {
            balance: true,
            items: true,
            activity: true,
            sync: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineViewPatch {
    pub account_id: String,
    pub generation: u64,
    pub seq: u64,
    pub dirty: DirtySlices,
    pub balance: Option<BalanceBreakdown>,
}

type PushFn = Arc<dyn Fn(EngineViewPatch) + Send + Sync>;

struct PendingState {
    account_id: String,
    generation: u64,
    seq: u64,
    dirty: DirtySlices,
    balance: Option<BalanceBreakdown>,
    push: Option<PushFn>,
}

#[derive(Clone)]
pub struct ViewProjector {
    inner: Arc<Mutex<PendingState>>,
    notify: Arc<Notify>,
}

impl Default for ViewProjector {
    fn default() -> Self {
        Self::new()
    }
}

impl ViewProjector {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(PendingState {
                account_id: String::new(),
                generation: 0,
                seq: 0,
                dirty: DirtySlices::default(),
                balance: None,
                push: None,
            })),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Register the host push callback (e.g. `window.__handcashNativePush('engine:patch', ...)`).
    pub fn set_push_handler<F>(&self, handler: F)
    where
        F: Fn(EngineViewPatch) + Send + Sync + 'static,
    {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.push = Some(Arc::new(handler));
    }

    /// Start the coalescing flush task on the provided Tokio runtime handle.
    pub fn spawn_flusher(&self, handle: &tokio::runtime::Handle) {
        let inner = Arc::clone(&self.inner);
        let notify = Arc::clone(&self.notify);
        handle.spawn(async move {
            loop {
                notify.notified().await;
                tokio::time::sleep(Duration::from_millis(COALESCE_WINDOW_MS)).await;
                let (patch, push_cb) = {
                    let mut state = inner.lock().unwrap_or_else(|e| e.into_inner());
                    if !state.dirty.any() || state.account_id.is_empty() {
                        continue;
                    }
                    state.seq = state.seq.saturating_add(1);
                    let dirty = std::mem::take(&mut state.dirty);
                    let balance = state.balance.take();
                    let patch = EngineViewPatch {
                        account_id: state.account_id.clone(),
                        generation: state.generation,
                        seq: state.seq,
                        dirty,
                        balance,
                    };
                    (patch, state.push.clone())
                };
                if let Some(cb) = push_cb {
                    cb(patch);
                }
            }
        });
    }

    /// Mark slices dirty for `(account_id, generation)`. Coalesces bursts into one push.
    pub fn mark_dirty(
        &self,
        account_id: &str,
        generation: u64,
        dirty: DirtySlices,
        balance: Option<BalanceBreakdown>,
    ) {
        if !dirty.any() {
            return;
        }
        {
            let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if state.account_id != account_id || state.generation != generation {
                state.account_id = account_id.to_string();
                state.generation = generation;
                state.dirty = DirtySlices::default();
                state.balance = None;
            }
            state.dirty.merge(&dirty);
            if balance.is_some() {
                state.balance = balance;
            }
        }
        self.notify.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn coalesces_100_rapid_mutations_into_one_patch() {
        let projector = ViewProjector::new();
        let received = Arc::new(Mutex::new(Vec::<EngineViewPatch>::new()));
        let rec_clone = Arc::clone(&received);
        projector.set_push_handler(move |p| {
            rec_clone.lock().unwrap().push(p);
        });
        projector.spawn_flusher(&tokio::runtime::Handle::current());

        for _ in 0..100 {
            projector.mark_dirty(
                "acct-1",
                1,
                DirtySlices {
                    balance: true,
                    items: true,
                    activity: false,
                    sync: false,
                },
                None,
            );
        }

        tokio::time::sleep(Duration::from_millis(120)).await;
        let patches = received.lock().unwrap();
        assert_eq!(patches.len(), 1);
        assert!(patches[0].dirty.balance);
        assert!(patches[0].dirty.items);
        assert_eq!(patches[0].generation, 1);
    }
}
