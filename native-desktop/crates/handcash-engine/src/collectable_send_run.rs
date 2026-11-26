// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Pure selection planning and failure policy from collectableSendRun.ts.
//! No custody reads, transaction creation, signing, retries or broadcast here.

use std::collections::HashSet;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leg {
    pub index: usize,
    pub outpoints: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Plan {
    Refuse { reason: String },
    Legs { legs: Vec<Leg>, #[serde(rename = "itemCount")] item_count: usize },
}

/// Match the reference's string normalization, not outpoint validation.
/// Actual selected tips must still be looked up and verified by the spend owner.
pub fn normalize_outpoints(raw: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    raw.iter().filter_map(|raw| {
        let mut point = raw.trim().to_lowercase();
        if let Some((prefix, suffix)) = point.rsplit_once('_') {
            if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
                point = format!("{prefix}.{suffix}");
            }
        }
        if point.is_empty() || !seen.insert(point.clone()) { None } else { Some(point) }
    }).collect()
}

pub fn plan(raw: &[String]) -> Plan {
    let outpoints = normalize_outpoints(raw);
    if outpoints.is_empty() {
        Plan::Refuse { reason: "empty".into() }
    } else {
        Plan::Legs { item_count: outpoints.len(), legs: vec![Leg { index: 1, outpoints }] }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason { Wallet, Network, Ancestry, Unknown }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum FailureDecision {
    Split { reason: ItemConflict },
    Stop { reason: StopReason },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemConflict { ItemConflict }

/// Ordered classification is deliberate: wallet/network/ancestry faults must
/// never become exponential split retries, even when they mention a spent tip.
pub fn classify_failure(reason: &str) -> FailureDecision {
    let message = reason.to_lowercase();
    for (needles, reason) in [
        (&["wallet locked", "wallet is locked", "no wallet", "not enough", "insufficient",
            "invalid recipient", "select at least one", "cancelled", "canceled"][..], StopReason::Wallet),
        (&["offline", "no network", "network", "fetch failed", "timed out", "timeout",
            "status 429", "status 500", "status 502", "status 503", "status 504"][..], StopReason::Network),
        (&["ancestry incomplete", "ancestry_incomplete", "beef_ancestry_incomplete",
            "without create transaction", "missing source transaction"][..], StopReason::Ancestry),
    ] {
        if needles.iter().any(|needle| message.contains(needle)) {
            return FailureDecision::Stop { reason };
        }
    }
    if ["collectable is no longer in this wallet", "collectable is no longer unspent",
        "collectable utxo is not a 1-sat ordinal", "is no longer spendable",
        "input already spent", "already-spent input", "already spent input",
        "double spend", "doublespend", "txn-mempool-conflict",
        "bad-txns-inputs-missingorspent"].iter().any(|needle| message.contains(needle)) {
        FailureDecision::Split { reason: ItemConflict::ItemConflict }
    } else {
        FailureDecision::Stop { reason: StopReason::Unknown }
    }
}

pub fn failed_attempt_activity(item_count: usize) -> &'static str {
    if item_count > 1 { "discard" } else { "record" }
}

/// Only use after the chart accepts an item-local rejection. Never re-sign a
/// signed leg because change pinning, delivery or miner acknowledgement failed.
pub fn split_leg<T: Clone>(items: &[T]) -> (Vec<T>, Vec<T>) {
    let middle = items.len().div_ceil(2);
    (items[..middle].to_vec(), items[middle..].to_vec())
}
