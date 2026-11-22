// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Platform-neutral wallet layer boundaries, provenance enforcement, holding
//! freshness gap tracking, and bounded read-side projections.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_PAGE_SLICE: usize = 100;
pub const SUSPENSION_GAP_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WalletLayer {
    Custody,
    LocalState,
    ChainIngest,
    HistoryReplica,
    BalanceView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncOperation {
    DashboardRefresh,
    RecomposeWallet,
}

impl SyncOperation {
    pub const fn layers(self) -> &'static [WalletLayer] {
        match self {
            Self::DashboardRefresh => &[WalletLayer::ChainIngest],
            Self::RecomposeWallet => &[WalletLayer::HistoryReplica, WalletLayer::ChainIngest],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Authenticity {
    ProvenBrc150 {
        origin_outpoint: String,
        verified_at_ms: u64,
    },
    Unproven {
        reason: String,
    },
}

impl Authenticity {
    pub fn from_indexer(reason: impl Into<String>) -> Self {
        Self::Unproven {
            reason: reason.into(),
        }
    }

    pub fn is_proven(&self) -> bool {
        matches!(self, Self::ProvenBrc150 { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreshnessGap {
    Start,
    Lock,
    AccountSwitch,
    Online,
    ServePause,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldingFreshness {
    fresh: bool,
    last_tick_ms: Option<u64>,
    last_gap: Option<FreshnessGap>,
}

impl Default for HoldingFreshness {
    fn default() -> Self {
        Self {
            fresh: false,
            last_tick_ms: None,
            last_gap: Some(FreshnessGap::Start),
        }
    }
}

impl HoldingFreshness {
    pub fn needs_check(&self) -> bool {
        !self.fresh
    }

    pub fn last_gap(&self) -> Option<FreshnessGap> {
        self.last_gap
    }

    pub fn mark_checked(&mut self, now_ms: u64) {
        self.fresh = true;
        self.last_tick_ms = Some(now_ms);
        self.last_gap = None;
    }

    pub fn record_gap(&mut self, gap: FreshnessGap) {
        self.fresh = false;
        self.last_gap = Some(gap);
    }

    pub fn record_serve_tick(&mut self, now_ms: u64) -> bool {
        let paused = self
            .last_tick_ms
            .is_some_and(|prev| now_ms.saturating_sub(prev) > SUSPENSION_GAP_MS);
        self.last_tick_ms = Some(now_ms);
        if paused {
            self.fresh = false;
            self.last_gap = Some(FreshnessGap::ServePause);
        }
        paused
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayBalanceSummary {
    pub account_id: String,
    pub generation: u64,
    pub spendable_sats: u64,
    pub item_count: usize,
    pub updated_at_ms: u64,
    pub display_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedItem {
    pub outpoint: String,
    pub basket: String,
    pub authenticity: Authenticity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPage {
    pub account_id: String,
    pub generation: u64,
    pub items: Vec<ProjectedItem>,
    pub next_cursor: Option<usize>,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    WrongAccount,
    StaleGeneration { expected: u64, got: u64 },
}

#[derive(Debug, Default)]
pub struct PagedProjectionStore {
    active_account: Option<String>,
    generation: u64,
    balances: HashMap<String, DisplayBalanceSummary>,
    items: HashMap<String, Vec<ProjectedItem>>,
}

impl PagedProjectionStore {
    pub fn activate_account(&mut self, account_id: impl Into<String>) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.active_account = Some(account_id.into());
        self.generation
    }

    pub fn active_generation(&self) -> u64 {
        self.generation
    }

    pub fn active_account(&self) -> Option<&str> {
        self.active_account.as_deref()
    }

    fn check_fence(&self, account_id: &str, generation: u64) -> Result<(), ProjectionError> {
        if self.active_account.as_deref() != Some(account_id) {
            return Err(ProjectionError::WrongAccount);
        }
        if generation != self.generation {
            return Err(ProjectionError::StaleGeneration {
                expected: self.generation,
                got: generation,
            });
        }
        Ok(())
    }

    pub fn put_balance(
        &mut self,
        account_id: &str,
        generation: u64,
        spendable_sats: u64,
        item_count: usize,
        updated_at_ms: u64,
    ) -> Result<DisplayBalanceSummary, ProjectionError> {
        self.check_fence(account_id, generation)?;
        let summary = DisplayBalanceSummary {
            account_id: account_id.to_string(),
            generation,
            spendable_sats,
            item_count,
            updated_at_ms,
            display_only: true,
        };
        self.balances
            .insert(account_id.to_string(), summary.clone());
        Ok(summary)
    }

    pub fn put_items(
        &mut self,
        account_id: &str,
        generation: u64,
        items: Vec<ProjectedItem>,
    ) -> Result<(), ProjectionError> {
        self.check_fence(account_id, generation)?;
        self.items.insert(account_id.to_string(), items);
        Ok(())
    }

    pub fn read_balance(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<Option<DisplayBalanceSummary>, ProjectionError> {
        self.check_fence(account_id, generation)?;
        Ok(self.balances.get(account_id).cloned())
    }

    pub fn read_items_page(
        &self,
        account_id: &str,
        generation: u64,
        cursor: usize,
        requested_limit: usize,
    ) -> Result<ItemPage, ProjectionError> {
        self.check_fence(account_id, generation)?;
        let limit = requested_limit.clamp(1, MAX_PAGE_SLICE);
        let all = self.items.get(account_id).map(Vec::as_slice).unwrap_or(&[]);
        let start = cursor.min(all.len());
        let end = start.saturating_add(limit).min(all.len());
        let next_cursor = (end < all.len()).then_some(end);
        Ok(ItemPage {
            account_id: account_id.to_string(),
            generation,
            items: all[start..end].to_vec(),
            next_cursor,
            total: all.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_layer_separation_keeps_refresh_chain_only() {
        assert_eq!(
            SyncOperation::DashboardRefresh.layers(),
            &[WalletLayer::ChainIngest]
        );
        assert_eq!(
            SyncOperation::RecomposeWallet.layers(),
            &[WalletLayer::HistoryReplica, WalletLayer::ChainIngest]
        );
    }

    #[test]
    fn authenticity_never_promotes_indexer_data_to_proven() {
        let idx = Authenticity::from_indexer("indexer_metadata_only");
        assert!(!idx.is_proven());
        let proven = Authenticity::ProvenBrc150 {
            origin_outpoint: "aa".repeat(32) + ".0",
            verified_at_ms: 1_700_000_000_000,
        };
        assert!(proven.is_proven());
    }

    #[test]
    fn holding_freshness_detects_suspension_and_explicit_gaps() {
        let mut hf = HoldingFreshness::default();
        assert!(hf.needs_check());
        assert_eq!(hf.last_gap(), Some(FreshnessGap::Start));

        hf.mark_checked(1_000);
        assert!(!hf.needs_check());
        assert!(!hf.record_serve_tick(16_000));
        assert!(!hf.needs_check());

        assert!(hf.record_serve_tick(31_001));
        assert!(hf.needs_check());
        assert_eq!(hf.last_gap(), Some(FreshnessGap::ServePause));

        hf.mark_checked(32_000);
        hf.record_gap(FreshnessGap::AccountSwitch);
        assert!(hf.needs_check());
        assert_eq!(hf.last_gap(), Some(FreshnessGap::AccountSwitch));
    }

    #[test]
    fn paged_projection_enforces_account_generation_fence_and_100_row_cap() {
        let mut store = PagedProjectionStore::default();
        let gen1 = store.activate_account("acct-1");
        let items: Vec<ProjectedItem> = (0..250)
            .map(|i| ProjectedItem {
                outpoint: format!("tx-{i}.0"),
                basket: "1sat".into(),
                authenticity: Authenticity::from_indexer("pending_brc150"),
            })
            .collect();
        store.put_items("acct-1", gen1, items).unwrap();
        let bal = store.put_balance("acct-1", gen1, 42_000, 250, 99).unwrap();
        assert!(bal.display_only);

        let p1 = store.read_items_page("acct-1", gen1, 0, 500).unwrap();
        assert_eq!(p1.items.len(), MAX_PAGE_SLICE);
        assert_eq!(p1.next_cursor, Some(100));
        assert_eq!(p1.total, 250);

        let gen2 = store.activate_account("acct-2");
        assert!(gen2 > gen1);
        assert_eq!(
            store.put_balance("acct-1", gen1, 0, 0, 100),
            Err(ProjectionError::WrongAccount)
        );
        assert_eq!(
            store.read_balance("acct-2", gen1),
            Err(ProjectionError::StaleGeneration {
                expected: gen2,
                got: gen1,
            })
        );
    }
}
