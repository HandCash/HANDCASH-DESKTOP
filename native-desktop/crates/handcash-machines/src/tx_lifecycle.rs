// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/txLifecycleMachine.ts` and `src/wallet/txLifecycle.ts` transitions.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

/// Durable local tx states — map 1:1 onto ARC pipeline where applicable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxStatus {
    Draft,
    Validating,
    Broadcasting,
    SeenInMempool,
    Mined,
    FailedRejected,
    ReorgOrphaned,
}

impl TxStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Validating => "VALIDATING",
            Self::Broadcasting => "BROADCASTING",
            Self::SeenInMempool => "SEEN_IN_MEMPOOL",
            Self::Mined => "MINED",
            Self::FailedRejected => "FAILED_REJECTED",
            Self::ReorgOrphaned => "REORG_ORPHANED",
        }
    }
}

/// Legal status transition? Fail-closed for unknown edges (mirrors `canTransitionTx`).
pub const fn can_transition_tx(from: TxStatus, to: TxStatus) -> bool {
    if matches!((from, to), (a, b) if a as u8 == b as u8) {
        return true;
    }
    matches!(
        (from, to),
        (TxStatus::Draft, TxStatus::Validating | TxStatus::FailedRejected)
            | (
                TxStatus::Validating,
                TxStatus::Broadcasting | TxStatus::SeenInMempool | TxStatus::FailedRejected
            )
            | (
                TxStatus::Broadcasting,
                TxStatus::SeenInMempool | TxStatus::Mined | TxStatus::FailedRejected
            )
            | (
                TxStatus::SeenInMempool,
                TxStatus::Mined | TxStatus::FailedRejected | TxStatus::ReorgOrphaned
            )
            | (TxStatus::Mined, TxStatus::ReorgOrphaned)
            | (
                TxStatus::ReorgOrphaned,
                TxStatus::SeenInMempool | TxStatus::FailedRejected
            )
    )
}

/// ARC broadcast / callback statuses (BSV Association ARC).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArcStatus {
    Stored,
    AnnouncedToNetwork,
    SeenOnNetwork,
    Mined,
    Rejected,
    DoubleSpendAttempted,
}

impl ArcStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stored => "STORED",
            Self::AnnouncedToNetwork => "ANNOUNCED_TO_NETWORK",
            Self::SeenOnNetwork => "SEEN_ON_NETWORK",
            Self::Mined => "MINED",
            Self::Rejected => "REJECTED",
            Self::DoubleSpendAttempted => "DOUBLE_SPEND_ATTEMPTED",
        }
    }
}

/// User-facing diagnostic codes — halt before UTXO mutation when validation fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxDiagnosticCode {
    DustOutput,
    InvalidSatoshis,
    InsufficientFunds,
    EmptyInputs,
    FeeTooLow,
    ScriptInvalid,
    ProtocolRefuse,
    ArcRejected,
    ArcDoubleSpend,
    BumpUnverified,
    Reorg,
    Unknown,
}

impl TxDiagnosticCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DustOutput => "DUST_OUTPUT",
            Self::InvalidSatoshis => "INVALID_SATOSHIS",
            Self::InsufficientFunds => "INSUFFICIENT_FUNDS",
            Self::EmptyInputs => "EMPTY_INPUTS",
            Self::FeeTooLow => "FEE_TOO_LOW",
            Self::ScriptInvalid => "SCRIPT_INVALID",
            Self::ProtocolRefuse => "PROTOCOL_REFUSE",
            Self::ArcRejected => "ARC_REJECTED",
            Self::ArcDoubleSpend => "ARC_DOUBLE_SPEND",
            Self::BumpUnverified => "BUMP_UNVERIFIED",
            Self::Reorg => "REORG",
            Self::Unknown => "UNKNOWN",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxLifecycleState {
    Idle,
    Draft,
    Validating,
    Broadcasting,
    SeenInMempool,
    Mined,
    ReorgOrphaned,
    Failed,
}

impl TxLifecycleState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Draft => "draft",
            Self::Validating => "validating",
            Self::Broadcasting => "broadcasting",
            Self::SeenInMempool => "seenInMempool",
            Self::Mined => "mined",
            Self::ReorgOrphaned => "reorgOrphaned",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxLifecycleContext {
    pub id: String,
    pub txid: Option<String>,
    pub status: TxStatus,
    pub arc_status: Option<ArcStatus>,
    pub diagnostic: Option<TxDiagnosticCode>,
    pub mined_height: Option<u64>,
    pub error: Option<String>,
}

impl Default for TxLifecycleContext {
    fn default() -> Self {
        Self {
            id: String::new(),
            txid: None,
            status: TxStatus::Draft,
            arc_status: None,
            diagnostic: None,
            mined_height: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TxLifecycleEvent {
    Start {
        id: String,
    },
    Validated,
    ValidateFail {
        code: TxDiagnosticCode,
        detail: Option<String>,
    },
    Dispatch,
    Txid {
        txid: String,
    },
    Arc {
        status: ArcStatus,
    },
    Mempool,
    BumpVerified {
        height: u64,
    },
    BumpFail {
        detail: Option<String>,
    },
    Reject {
        code: TxDiagnosticCode,
        detail: Option<String>,
    },
    Reorg,
    Reannounced,
    Reset,
}

pub struct TxLifecycleMachine;

impl TxLifecycleMachine {
    const fn is_arc_reject(status: ArcStatus) -> bool {
        matches!(status, ArcStatus::Rejected | ArcStatus::DoubleSpendAttempted)
    }

    const fn is_arc_seen(status: ArcStatus) -> bool {
        matches!(
            status,
            ArcStatus::SeenOnNetwork
                | ArcStatus::Stored
                | ArcStatus::AnnouncedToNetwork
                | ArcStatus::Mined
        )
    }

    fn apply_fail(ctx: &mut TxLifecycleContext, code: TxDiagnosticCode, detail: Option<String>) {
        ctx.status = TxStatus::FailedRejected;
        ctx.diagnostic = Some(code);
        ctx.error = Some(detail.unwrap_or_else(|| code.as_str().to_string()));
    }

    fn apply_arc_reject(ctx: &mut TxLifecycleContext, status: ArcStatus) {
        let code = if status == ArcStatus::DoubleSpendAttempted {
            TxDiagnosticCode::ArcDoubleSpend
        } else {
            TxDiagnosticCode::ArcRejected
        };
        ctx.arc_status = Some(status);
        ctx.status = TxStatus::FailedRejected;
        ctx.diagnostic = Some(code);
        ctx.error = Some(code.as_str().to_string());
    }

    fn apply_mempool(ctx: &mut TxLifecycleContext) {
        ctx.status = TxStatus::SeenInMempool;
        ctx.diagnostic = None;
        ctx.error = None;
    }

    fn apply_orphaned(ctx: &mut TxLifecycleContext) {
        ctx.status = TxStatus::ReorgOrphaned;
        ctx.mined_height = None;
        ctx.diagnostic = Some(TxDiagnosticCode::Reorg);
        ctx.error = Some("Block reorg orphaned this transaction".to_string());
    }
}

impl Statechart for TxLifecycleMachine {
    const ID: &'static str = "txLifecycle";
    type State = TxLifecycleState;
    type Context = TxLifecycleContext;
    type Event = TxLifecycleEvent;
    type Input = ();

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(TxLifecycleState::Idle, TxLifecycleContext::default())
    }

    fn state_value(state: &Self::State) -> StateValue {
        StateValue::leaf(state.as_str())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (TxLifecycleState::Idle, TxLifecycleEvent::Start { id }) => {
                ctx = TxLifecycleContext {
                    id,
                    ..TxLifecycleContext::default()
                };
                TxLifecycleState::Draft
            }
            (TxLifecycleState::Draft, TxLifecycleEvent::Validated) => {
                ctx.status = TxStatus::Validating;
                TxLifecycleState::Validating
            }
            (TxLifecycleState::Draft, TxLifecycleEvent::ValidateFail { code, detail }) => {
                Self::apply_fail(&mut ctx, code, detail);
                TxLifecycleState::Failed
            }
            (TxLifecycleState::Validating, TxLifecycleEvent::Dispatch) => {
                ctx.status = TxStatus::Broadcasting;
                TxLifecycleState::Broadcasting
            }
            (TxLifecycleState::Validating, TxLifecycleEvent::Txid { txid }) => {
                ctx.txid = Some(txid.to_lowercase());
                TxLifecycleState::Validating
            }
            (TxLifecycleState::Validating, TxLifecycleEvent::Mempool) => {
                Self::apply_mempool(&mut ctx);
                TxLifecycleState::SeenInMempool
            }
            (TxLifecycleState::Validating, TxLifecycleEvent::ValidateFail { code, detail }) => {
                Self::apply_fail(&mut ctx, code, detail);
                TxLifecycleState::Failed
            }
            (TxLifecycleState::Broadcasting, TxLifecycleEvent::Txid { txid }) => {
                ctx.txid = Some(txid.to_lowercase());
                TxLifecycleState::Broadcasting
            }
            (TxLifecycleState::Broadcasting, TxLifecycleEvent::Mempool) => {
                Self::apply_mempool(&mut ctx);
                TxLifecycleState::SeenInMempool
            }
            (TxLifecycleState::Broadcasting, TxLifecycleEvent::Arc { status })
                if Self::is_arc_reject(status) =>
            {
                Self::apply_arc_reject(&mut ctx, status);
                TxLifecycleState::Failed
            }
            (TxLifecycleState::Broadcasting, TxLifecycleEvent::Arc { status })
                if Self::is_arc_seen(status) =>
            {
                ctx.arc_status = Some(status);
                Self::apply_mempool(&mut ctx);
                TxLifecycleState::SeenInMempool
            }
            (TxLifecycleState::Broadcasting, TxLifecycleEvent::Reject { code, detail }) => {
                Self::apply_fail(&mut ctx, code, detail);
                TxLifecycleState::Failed
            }
            (TxLifecycleState::SeenInMempool, TxLifecycleEvent::BumpVerified { height }) => {
                ctx.status = TxStatus::Mined;
                ctx.mined_height = Some(height);
                ctx.arc_status = Some(ArcStatus::Mined);
                ctx.diagnostic = None;
                ctx.error = None;
                TxLifecycleState::Mined
            }
            (TxLifecycleState::SeenInMempool, TxLifecycleEvent::BumpFail { detail }) => {
                ctx.status = TxStatus::SeenInMempool;
                ctx.diagnostic = Some(TxDiagnosticCode::BumpUnverified);
                ctx.error = Some(detail.unwrap_or_else(|| "BUMP_UNVERIFIED".to_string()));
                TxLifecycleState::SeenInMempool
            }
            (TxLifecycleState::SeenInMempool, TxLifecycleEvent::Arc { status })
                if Self::is_arc_reject(status) =>
            {
                Self::apply_arc_reject(&mut ctx, status);
                TxLifecycleState::Failed
            }
            (TxLifecycleState::SeenInMempool, TxLifecycleEvent::Arc { status }) => {
                ctx.arc_status = Some(status);
                TxLifecycleState::SeenInMempool
            }
            (TxLifecycleState::SeenInMempool, TxLifecycleEvent::Reject { code, detail }) => {
                Self::apply_fail(&mut ctx, code, detail);
                TxLifecycleState::Failed
            }
            (TxLifecycleState::SeenInMempool, TxLifecycleEvent::Reorg) => {
                Self::apply_orphaned(&mut ctx);
                TxLifecycleState::ReorgOrphaned
            }
            (TxLifecycleState::Mined, TxLifecycleEvent::Reorg) => {
                Self::apply_orphaned(&mut ctx);
                TxLifecycleState::ReorgOrphaned
            }
            (TxLifecycleState::Mined, TxLifecycleEvent::Reset) => {
                ctx = TxLifecycleContext::default();
                TxLifecycleState::Idle
            }
            (TxLifecycleState::ReorgOrphaned, TxLifecycleEvent::Reannounced)
            | (TxLifecycleState::ReorgOrphaned, TxLifecycleEvent::Mempool) => {
                Self::apply_mempool(&mut ctx);
                TxLifecycleState::SeenInMempool
            }
            (TxLifecycleState::ReorgOrphaned, TxLifecycleEvent::Reject { code, detail }) => {
                Self::apply_fail(&mut ctx, code, detail);
                TxLifecycleState::Failed
            }
            (TxLifecycleState::Failed, TxLifecycleEvent::Reset) => {
                ctx = TxLifecycleContext::default();
                TxLifecycleState::Idle
            }
            _ => return snapshot.clone(),
        };
        Snapshot::new(next, ctx)
    }
}

impl HandCashChart for TxLifecycleMachine {
    const MANIFEST_ID: &'static str = "txLifecycle";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "draft",
        "validating",
        "broadcasting",
        "seenInMempool",
        "mined",
        "reorgOrphaned",
        "failed",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        (Self::transition(snapshot, event), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn draft_validating_broadcasting_mempool_mined() {
        let mut actor = EffectActor::<TxLifecycleMachine>::default();
        actor.send(TxLifecycleEvent::Start { id: "t1".into() });
        assert_eq!(*actor.state(), TxLifecycleState::Draft);
        actor.send(TxLifecycleEvent::Validated);
        actor.send(TxLifecycleEvent::Dispatch);
        assert_eq!(*actor.state(), TxLifecycleState::Broadcasting);
        actor.send(TxLifecycleEvent::Arc {
            status: ArcStatus::SeenOnNetwork,
        });
        assert_eq!(*actor.state(), TxLifecycleState::SeenInMempool);
        actor.send(TxLifecycleEvent::BumpVerified { height: 42 });
        assert_eq!(*actor.state(), TxLifecycleState::Mined);
        assert_eq!(actor.context().mined_height, Some(42));
    }

    #[test]
    fn arc_double_spend_failed() {
        let mut actor = EffectActor::<TxLifecycleMachine>::default();
        actor.send(TxLifecycleEvent::Start { id: "t2".into() });
        actor.send(TxLifecycleEvent::Validated);
        actor.send(TxLifecycleEvent::Dispatch);
        actor.send(TxLifecycleEvent::Arc {
            status: ArcStatus::DoubleSpendAttempted,
        });
        assert_eq!(*actor.state(), TxLifecycleState::Failed);
        assert_eq!(actor.context().diagnostic, Some(TxDiagnosticCode::ArcDoubleSpend));
    }

    #[test]
    fn reorg_from_mined_orphaned_mempool() {
        let mut actor = EffectActor::<TxLifecycleMachine>::default();
        actor.send(TxLifecycleEvent::Start { id: "t3".into() });
        actor.send(TxLifecycleEvent::Validated);
        actor.send(TxLifecycleEvent::Dispatch);
        actor.send(TxLifecycleEvent::Mempool);
        actor.send(TxLifecycleEvent::BumpVerified { height: 1 });
        actor.send(TxLifecycleEvent::Reorg);
        assert_eq!(*actor.state(), TxLifecycleState::ReorgOrphaned);
        actor.send(TxLifecycleEvent::Reannounced);
        assert_eq!(*actor.state(), TxLifecycleState::SeenInMempool);
    }

    #[test]
    fn txid_lowercases_and_bump_fail_keeps_mempool_with_diagnostic() {
        let mut actor = EffectActor::<TxLifecycleMachine>::default();
        actor.send(TxLifecycleEvent::Start { id: "t4".into() });
        actor.send(TxLifecycleEvent::Validated);
        actor.send(TxLifecycleEvent::Txid {
            txid: "AABBCC".into(),
        });
        assert_eq!(actor.context().txid.as_deref(), Some("aabbcc"));
        actor.send(TxLifecycleEvent::Mempool);
        actor.send(TxLifecycleEvent::BumpFail { detail: None });
        assert_eq!(*actor.state(), TxLifecycleState::SeenInMempool);
        assert_eq!(actor.context().diagnostic, Some(TxDiagnosticCode::BumpUnverified));
        assert_eq!(actor.context().error.as_deref(), Some("BUMP_UNVERIFIED"));
    }

    #[test]
    fn can_transition_tx_is_fail_closed() {
        assert!(can_transition_tx(TxStatus::Draft, TxStatus::Validating));
        assert!(!can_transition_tx(TxStatus::Draft, TxStatus::Mined));
        assert!(!can_transition_tx(TxStatus::FailedRejected, TxStatus::Draft));
        assert!(can_transition_tx(TxStatus::Mined, TxStatus::ReorgOrphaned));
    }
}
