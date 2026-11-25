// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Compile-time-safe spend pipeline eliminating the `missing sourceTransaction`
//! and `abort-after-sign` failure classes by construction.
//!
//! State transitions:
//!   `DraftPlan` (UTXO reservation held, auto-released on failure/drop)
//!     -> `HydratedPlan` (100% of input txids resolved to validated source bytes)
//!     -> `VerifiedPlan` (holding freshness + certainty verified)
//!     -> `SignedTx` (committed atomically in SQLite; NO `.abort()` method exists)

use crate::layers::HoldingFreshness;
use handcash_net::{ChainFetcher, TxSourceKind};
use handcash_storage::{AccountStore, CommitSignedTx, NewOutputSpec, StorageError, UtxoRecord};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendInput {
    pub outpoint: String,
    pub txid: String,
    pub vout: u32,
    pub satoshis: u64,
}

impl From<&UtxoRecord> for SpendInput {
    fn from(r: &UtxoRecord) -> Self {
        Self {
            outpoint: r.outpoint.clone(),
            txid: r.txid.clone(),
            vout: r.vout,
            satoshis: r.satoshis,
        }
    }
}

#[derive(Debug)]
pub enum SpendPipelineError {
    Storage(StorageError),
    MissingInputTransactions { txids: Vec<String> },
    HoldingFreshnessRequired,
    SigningFailed(String),
}

impl fmt::Display for SpendPipelineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(e) => write!(f, "{e}"),
            Self::MissingInputTransactions { txids } => write!(
                f,
                "Could not load {} required input transaction(s) ({}). Refresh, then try again.",
                txids.len(),
                txids
                    .iter()
                    .take(3)
                    .map(|t| &t[..t.len().min(8)])
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Self::HoldingFreshnessRequired => {
                write!(f, "Account holding freshness check required after gap")
            }
            Self::SigningFailed(msg) => write!(f, "Signing failed: {msg}"),
        }
    }
}

impl std::error::Error for SpendPipelineError {}

impl From<StorageError> for SpendPipelineError {
    fn from(e: StorageError) -> Self {
        Self::Storage(e)
    }
}

/// Guard releasing a SQLite UTXO reservation unless explicitly disarmed upon signing.
struct ReservationLease {
    store: Arc<AccountStore>,
    intent_id: String,
    armed: bool,
}

impl ReservationLease {
    fn disarm(&mut self) {
        self.armed = false;
    }

    fn release_now(mut self, now_ms: i64) {
        if self.armed {
            self.armed = false;
            let _ = self.store.release_reservation(&self.intent_id, now_ms);
        }
    }
}

impl Drop for ReservationLease {
    fn drop(&mut self) {
        if self.armed {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let _ = self.store.release_reservation(&self.intent_id, now_ms);
        }
    }
}

/// Phase 1: Planned spend with an active SQLite UTXO reservation.
pub struct DraftPlan {
    intent_id: String,
    inputs: Vec<SpendInput>,
    lease: ReservationLease,
}

impl DraftPlan {
    /// Atomically reserve `outpoints` in `store` and create a `DraftPlan`.
    pub fn reserve(
        store: Arc<AccountStore>,
        intent_id: impl Into<String>,
        outpoints: &[String],
        now_ms: i64,
        ttl_ms: i64,
    ) -> Result<Self, SpendPipelineError> {
        let intent_id = intent_id.into();
        let reserved = store.reserve_utxos(&intent_id, outpoints, now_ms, ttl_ms)?;
        let inputs = reserved.iter().map(SpendInput::from).collect();
        Ok(Self {
            lease: ReservationLease {
                store,
                intent_id: intent_id.clone(),
                armed: true,
            },
            intent_id,
            inputs,
        })
    }

    pub fn intent_id(&self) -> &str {
        &self.intent_id
    }

    pub fn required_source_txids(&self) -> Vec<String> {
        let set: BTreeSet<String> = self
            .inputs
            .iter()
            .map(|i| i.txid.trim().to_ascii_lowercase())
            .collect();
        set.into_iter().collect()
    }

    /// Explicitly abort the unsigned draft and release all reserved UTXOs.
    pub fn abort(self, now_ms: i64) {
        self.lease.release_now(now_ms);
    }

    /// Phase 2: Resolve 100% of required input source transactions from local cold blobs
    /// first, then via the rate-limited `ChainFetcher`.
    ///
    /// Fails closed (and releases the reservation automatically via `Drop`) if even one
    /// source txid cannot be loaded — making `missing sourceTransaction` impossible.
    pub async fn hydrate(
        self,
        fetcher: Option<&ChainFetcher>,
        allow_raw: bool,
        now_ms: i64,
    ) -> Result<HydratedPlan, SpendPipelineError> {
        let required = self.required_source_txids();
        let mut sources: HashMap<String, (TxSourceKind, Vec<u8>)> = HashMap::new();
        let mut missing = Vec::new();

        for txid in &required {
            if let Some((kind_str, bytes)) = self.lease.store.get_tx_source_bytes(txid)? {
                let kind = if kind_str == "beef" {
                    TxSourceKind::Beef
                } else {
                    TxSourceKind::RawTx
                };
                sources.insert(txid.clone(), (kind, bytes));
            } else {
                missing.push(txid.clone());
            }
        }

        if !missing.is_empty() {
            if let Some(net) = fetcher {
                let (fetched, still_missing) = net.fetch_batch(&missing, allow_raw).await;
                for (txid, src) in fetched {
                    // Cache fetched blob locally so future spends hit SQLite cold storage instantly.
                    let kind_label = match src.kind {
                        TxSourceKind::Beef => "beef",
                        TxSourceKind::RawTx => "raw_tx",
                    };
                    let _ = self.lease.store.put_blob(kind_label, &src.bytes, now_ms);
                    sources.insert(txid, (src.kind, src.bytes));
                }
                missing = still_missing;
            }
        }

        if !missing.is_empty() {
            // Drop releases reservation automatically.
            return Err(SpendPipelineError::MissingInputTransactions { txids: missing });
        }

        Ok(HydratedPlan {
            intent_id: self.intent_id,
            inputs: self.inputs,
            sources,
            lease: self.lease,
        })
    }
}

/// Phase 2 output: Guaranteed by construction to carry source bytes for EVERY input txid.
pub struct HydratedPlan {
    intent_id: String,
    inputs: Vec<SpendInput>,
    sources: HashMap<String, (TxSourceKind, Vec<u8>)>,
    lease: ReservationLease,
}

impl HydratedPlan {
    pub fn inputs(&self) -> &[SpendInput] {
        &self.inputs
    }

    pub fn source_for(&self, txid: &str) -> &(TxSourceKind, Vec<u8>) {
        self.sources
            .get(&txid.trim().to_ascii_lowercase())
            .expect("HydratedPlan invariant guarantees every input txid is present")
    }

    pub fn abort(self, now_ms: i64) {
        self.lease.release_now(now_ms);
    }

    /// Phase 3: Enforce BRC-249 holding freshness before signing is permitted.
    pub fn verify_holding(
        self,
        freshness: &HoldingFreshness,
    ) -> Result<VerifiedPlan, SpendPipelineError> {
        if freshness.needs_check() {
            return Err(SpendPipelineError::HoldingFreshnessRequired);
        }
        Ok(VerifiedPlan {
            intent_id: self.intent_id,
            inputs: self.inputs,
            sources: self.sources,
            lease: self.lease,
        })
    }
}

/// Phase 3 output: Hydrated + holding-verified plan ready for atomic sign & seal.
pub struct VerifiedPlan {
    intent_id: String,
    inputs: Vec<SpendInput>,
    sources: HashMap<String, (TxSourceKind, Vec<u8>)>,
    lease: ReservationLease,
}

impl VerifiedPlan {
    pub fn inputs(&self) -> &[SpendInput] {
        &self.inputs
    }

    pub fn sources(&self) -> &HashMap<String, (TxSourceKind, Vec<u8>)> {
        &self.sources
    }

    /// Phase 4: Atomically commit the signed transaction to SQLite and disarm reservation release.
    /// Returns `SignedTx`, which intentionally exposes NO abort/release method.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_signed(
        mut self,
        txid: String,
        description: String,
        kind: String,
        net_satoshis: i64,
        fee_sats: u64,
        counterparty: Option<String>,
        app_origin: Option<String>,
        new_outputs: Vec<NewOutputSpec>,
        raw_tx: Vec<u8>,
        atomic_beef: Vec<u8>,
        now_ms: i64,
    ) -> Result<SignedTx, SpendPipelineError> {
        let spent_outpoints: Vec<String> =
            self.inputs.iter().map(|i| i.outpoint.clone()).collect();
        let fact_id = self.lease.store.commit_signed_tx(&CommitSignedTx {
            intent_id: self.intent_id.clone(),
            txid: txid.clone(),
            description,
            kind,
            net_satoshis,
            fee_sats,
            counterparty,
            app_origin,
            spent_outpoints,
            new_outputs,
            raw_tx,
            atomic_beef,
            now_ms,
        })?;
        self.lease.disarm();
        Ok(SignedTx { txid, fact_id })
    }
}

/// Phase 4 output: Point of no return. Cannot be aborted or have inputs released.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedTx {
    pub txid: String,
    pub fact_id: String,
}

/// Lossless port of `src/wallet/spendVerdict/classify.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendArcadeKind {
    Accepted,
    AncestryIncomplete,
    GhostMissingInputs,
    AlreadySpent,
    Unknown,
}

fn contains_with_optional_sep(lower: &str, left: &str, right: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = lower[start..].find(left) {
        let after = start + pos + left.len();
        let tail = &lower[after..];
        if tail.starts_with(right) {
            return true;
        }
        if let Some(ch) = tail.chars().next() {
            if tail[ch.len_utf8()..].starts_with(right) {
                return true;
            }
        }
        start = after;
    }
    false
}

pub fn classify_spend_failure_message(reason: &str) -> SpendArcadeKind {
    let text = reason.trim();
    if text.is_empty() {
        return SpendArcadeKind::Unknown;
    }
    let lower = text.to_ascii_lowercase();
    if contains_with_optional_sep(&lower, "ancestry", "incomplete")
        || lower.contains("beef_ancestry_incomplete")
        || lower.contains("beef ancestry incomplete")
    {
        return SpendArcadeKind::AncestryIncomplete;
    }
    let already_spent = contains_with_optional_sep(&lower, "already", "spent")
        || contains_with_optional_sep(&lower, "double", "spend")
        || lower.contains("doublespend");
    let missing_inputs = contains_with_optional_sep(&lower, "missing", "inputs")
        || lower.contains("missingorspent")
        || lower.contains("mempool-conflict");
    if already_spent {
        return SpendArcadeKind::AlreadySpent;
    }
    if missing_inputs {
        return SpendArcadeKind::GhostMissingInputs;
    }
    SpendArcadeKind::Unknown
}

/// Listing / market: MissingInputs-only is not already-spent.
pub fn is_already_spent_listing_failure(reason: &str) -> bool {
    classify_spend_failure_message(reason) == SpendArcadeKind::AlreadySpent
}

pub fn is_ghost_missing_inputs_message(reason: &str) -> bool {
    classify_spend_failure_message(reason) == SpendArcadeKind::GhostMissingInputs
}

/// createAction hide-inputs: missing inputs *or* already spent.
pub fn is_already_spent_input_error(message: &str) -> bool {
    matches!(
        classify_spend_failure_message(message),
        SpendArcadeKind::AlreadySpent | SpendArcadeKind::GhostMissingInputs
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported 1:1 from `src/wallet/spendVerdict/classify.test.ts`
    #[test]
    fn classify_spend_failure_message_matches_ts_matrix() {
        for (reason, expected) in [
            ("Already spent", SpendArcadeKind::AlreadySpent),
            ("ARCADE_HARD_REJECT: Already spent", SpendArcadeKind::AlreadySpent),
            ("double spend detected", SpendArcadeKind::AlreadySpent),
            ("doubleSpend", SpendArcadeKind::AlreadySpent),
            ("missing inputs on vin 2", SpendArcadeKind::GhostMissingInputs),
            ("ARCADE_HARD_REJECT: MissingInputs", SpendArcadeKind::GhostMissingInputs),
            ("bad-txns-inputs-missingorspent", SpendArcadeKind::GhostMissingInputs),
            ("txn-mempool-conflict", SpendArcadeKind::GhostMissingInputs),
            ("BEEF_ANCESTRY_INCOMPLETE: MissingInputs", SpendArcadeKind::AncestryIncomplete),
            ("ARCADE_HARD_REJECT: Not sent", SpendArcadeKind::Unknown),
            ("ITEM_ORIGIN_UNPROVEN", SpendArcadeKind::Unknown),
            ("ACTION_DENIED", SpendArcadeKind::Unknown),
        ] {
            assert_eq!(classify_spend_failure_message(reason), expected, "reason={reason}");
        }
    }

    #[test]
    fn already_spent_listing_and_input_error_helpers_match_ts() {
        assert!(!is_already_spent_listing_failure("missing inputs on vin 2"));
        assert!(is_already_spent_listing_failure("Already spent"));
        assert!(is_already_spent_input_error("Missing inputs"));
        assert!(is_already_spent_input_error("input already spent"));
        assert!(!is_already_spent_input_error("Insufficient funds"));
        assert!(is_ghost_missing_inputs_message("MissingInputs"));
        assert!(!is_ghost_missing_inputs_message("Already spent"));
    }
    use handcash_storage::{UtxoRecord, UtxoState};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_store(tag: &str) -> Arc<AccountStore> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("hc-pipeline-{tag}-{nanos}.sqlite3"));
        Arc::new(AccountStore::open(path, 2).unwrap())
    }

    #[tokio::test]
    async fn missing_source_tx_fails_closed_and_releases_utxo_reservation() {
        let store = temp_store("missing-src");
        let txid = "aa".repeat(32);
        let op = format!("{txid}.0");
        store
            .upsert_utxo(
                &UtxoRecord {
                    outpoint: op.clone(),
                    txid: txid.clone(),
                    vout: 0,
                    satoshis: 1,
                    basket: "1sat".into(),
                    state: UtxoState::Spendable,
                    is_change: false,
                    derivation_json: None,
                    script_blob_hash: None,
                    spent_by_txid: None,
                },
                1_000,
            )
            .unwrap();

        let draft = DraftPlan::reserve(Arc::clone(&store), "burn-1", std::slice::from_ref(&op), 2_000, 30_000).unwrap();
        let res = draft.hydrate(None, false, 2_000).await;
        assert!(matches!(
            res,
            Err(SpendPipelineError::MissingInputTransactions { txids }) if txids == vec![txid]
        ));

        // Reservation MUST have been released automatically so the user can retry immediately.
        let retry = DraftPlan::reserve(Arc::clone(&store), "burn-2", std::slice::from_ref(&op), 2_100, 30_000);
        assert!(retry.is_ok());
        let _ = std::fs::remove_file(store.path());
    }

    #[tokio::test]
    async fn full_pipeline_requires_holding_freshness_and_commits_atomically() {
        let store = temp_store("full-ok");
        let parent_txid = "bb".repeat(32);
        let op = format!("{parent_txid}.0");
        // Seed parent tx with local BEEF via BRC-38 style insert or commit.
        let doc = serde_json::json!({
            "brc": 38,
            "tables": {
                "outputBaskets": [{ "basketId": 1, "name": "default" }],
                "transactions": [{ "transactionId": 1, "txid": parent_txid, "status": "completed", "isOutgoing": false, "satoshis": 10000, "rawTx": "AQIDBA==" }],
                "outputs": [{ "outputId": 1, "transactionId": 1, "vout": 0, "satoshis": 10000, "basketId": 1, "spendable": true, "change": true }]
            }
        });
        handcash_storage::import_brc38_json(&store, &doc.to_string(), 1_000).unwrap();

        let draft = DraftPlan::reserve(Arc::clone(&store), "pay-1", std::slice::from_ref(&op), 2_000, 30_000).unwrap();
        let hydrated = draft.hydrate(None, false, 2_000).await.unwrap();
        assert_eq!(hydrated.source_for(&parent_txid).1, vec![1, 2, 3, 4]);

        // Unchecked holding freshness blocks signing.
        let mut freshness = HoldingFreshness::default();
        assert!(matches!(
            hydrated.verify_holding(&freshness),
            Err(SpendPipelineError::HoldingFreshnessRequired)
        ));

        // After holding check, re-reserve -> hydrate -> verify -> commit_signed succeeds.
        freshness.mark_checked(2_500);
        let draft2 = DraftPlan::reserve(Arc::clone(&store), "pay-2", std::slice::from_ref(&op), 2_600, 30_000).unwrap();
        let hydrated2 = draft2.hydrate(None, false, 2_600).await.unwrap();
        let verified = hydrated2.verify_holding(&freshness).unwrap();
        let signed = verified
            .commit_signed(
                "cc".repeat(32),
                "Burn 1sat".into(),
                "burn".into(),
                -100,
                100,
                None,
                None,
                vec![NewOutputSpec {
                    vout: 0,
                    satoshis: 9_900,
                    basket: "default".into(),
                    is_change: true,
                    derivation_json: None,
                    script_bytes: None,
                }],
                vec![9, 9],
                vec![8, 8],
                3_000,
            )
            .unwrap();
        assert_eq!(signed.txid, "cc".repeat(32));
        assert_eq!(store.balance_summary().unwrap().displayed_sats, 9_900);
        let _ = std::fs::remove_file(store.path());
    }
}
