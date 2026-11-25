// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/walletCoordinatorMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinatorRegionState {
    Idle,
    Active,
}

impl CoordinatorRegionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Active => "active",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WalletCoordinatorSnapshot {
    pub chain_ingest: CoordinatorRegionState,
    pub spend: CoordinatorRegionState,
    pub history_replica: CoordinatorRegionState,
    pub recompose: CoordinatorRegionState,
}

impl Default for WalletCoordinatorSnapshot {
    fn default() -> Self {
        Self {
            chain_ingest: CoordinatorRegionState::Idle,
            spend: CoordinatorRegionState::Idle,
            history_replica: CoordinatorRegionState::Idle,
            recompose: CoordinatorRegionState::Idle,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalletCoordinatorContext {
    pub chain_ingest_depth: u32,
    pub spend_depth: u32,
    pub history_replica_depth: u32,
    pub recompose_depth: u32,
}

pub fn snapshot_from_context(context: &WalletCoordinatorContext) -> WalletCoordinatorSnapshot {
    WalletCoordinatorSnapshot {
        chain_ingest: if context.chain_ingest_depth > 0 {
            CoordinatorRegionState::Active
        } else {
            CoordinatorRegionState::Idle
        },
        spend: if context.spend_depth > 0 {
            CoordinatorRegionState::Active
        } else {
            CoordinatorRegionState::Idle
        },
        history_replica: if context.history_replica_depth > 0 {
            CoordinatorRegionState::Active
        } else {
            CoordinatorRegionState::Idle
        },
        recompose: if context.recompose_depth > 0 {
            CoordinatorRegionState::Active
        } else {
            CoordinatorRegionState::Idle
        },
    }
}

pub fn can_begin_chain_ingest(context: &WalletCoordinatorContext, nested: bool) -> bool {
    if context.recompose_depth > 0 {
        return false;
    }
    if nested {
        return context.spend_depth > 0 && context.chain_ingest_depth == 0;
    }
    context.chain_ingest_depth == 0
        && context.spend_depth == 0
        && context.history_replica_depth == 0
}

pub fn can_begin_spend(context: &WalletCoordinatorContext) -> bool {
    context.recompose_depth == 0 && context.spend_depth == 0 && context.history_replica_depth == 0
}

pub fn can_begin_history_replica(context: &WalletCoordinatorContext) -> bool {
    context.recompose_depth == 0
        && context.chain_ingest_depth == 0
        && context.spend_depth == 0
        && context.history_replica_depth == 0
}

pub fn can_begin_recompose(context: &WalletCoordinatorContext) -> bool {
    context.recompose_depth == 0
        && context.chain_ingest_depth == 0
        && context.spend_depth == 0
        && context.history_replica_depth == 0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalletCoordinatorEvent {
    ChainIngestBegin { nested: bool },
    ChainIngestEnd,
    SpendBegin,
    SpendEnd,
    HistoryBegin,
    HistoryEnd,
    RecomposeBegin,
    RecomposeEnd,
}

pub struct WalletCoordinatorMachine;

impl Statechart for WalletCoordinatorMachine {
    type State = WalletCoordinatorSnapshot;
    type Context = WalletCoordinatorContext;
    type Event = WalletCoordinatorEvent;
    type Input = ();

    const ID: &'static str = "walletCoordinator";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        let ctx = WalletCoordinatorContext::default();
        Snapshot::new(snapshot_from_context(&ctx), ctx)
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        StateValue::parallel(vec![
            ("chainIngest", StateValue::leaf(state.chain_ingest.as_str())),
            ("spend", StateValue::leaf(state.spend.as_str())),
            ("historyReplica", StateValue::leaf(state.history_replica.as_str())),
            ("recompose", StateValue::leaf(state.recompose.as_str())),
        ])
    }
}

impl HandCashChart for WalletCoordinatorMachine {
    const MANIFEST_ID: &'static str = "walletCoordinator";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "chainIngest",
        "spend",
        "historyReplica",
        "recompose",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        match event {
            WalletCoordinatorEvent::ChainIngestBegin { nested }
                if can_begin_chain_ingest(&ctx, nested) =>
            {
                ctx.chain_ingest_depth += 1;
            }
            WalletCoordinatorEvent::ChainIngestEnd => {
                ctx.chain_ingest_depth = ctx.chain_ingest_depth.saturating_sub(1);
            }
            WalletCoordinatorEvent::SpendBegin if can_begin_spend(&ctx) => {
                ctx.spend_depth += 1;
            }
            WalletCoordinatorEvent::SpendEnd => {
                ctx.spend_depth = ctx.spend_depth.saturating_sub(1);
            }
            WalletCoordinatorEvent::HistoryBegin if can_begin_history_replica(&ctx) => {
                ctx.history_replica_depth += 1;
            }
            WalletCoordinatorEvent::HistoryEnd => {
                ctx.history_replica_depth = ctx.history_replica_depth.saturating_sub(1);
            }
            WalletCoordinatorEvent::RecomposeBegin if can_begin_recompose(&ctx) => {
                ctx.recompose_depth += 1;
            }
            WalletCoordinatorEvent::RecomposeEnd => {
                ctx.recompose_depth = ctx.recompose_depth.saturating_sub(1);
            }
            _ => return (snapshot.clone(), Vec::new()),
        }
        let next_state = snapshot_from_context(&ctx);
        (Snapshot::new(next_state, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn allows_spend_during_active_chain_ingest_but_blocks_new_ingest_during_spend() {
        let mut actor = EffectActor::<WalletCoordinatorMachine>::default();
        actor.send(WalletCoordinatorEvent::ChainIngestBegin { nested: false });
        assert_eq!(actor.state().chain_ingest, CoordinatorRegionState::Active);
        assert!(actor.can(&WalletCoordinatorEvent::SpendBegin));
        actor.send(WalletCoordinatorEvent::SpendBegin);
        assert_eq!(actor.state().spend, CoordinatorRegionState::Active);
        assert!(!actor.can(&WalletCoordinatorEvent::HistoryBegin));
        assert!(!actor.can(&WalletCoordinatorEvent::RecomposeBegin));
        actor.send(WalletCoordinatorEvent::ChainIngestEnd);
        assert_eq!(actor.state().chain_ingest, CoordinatorRegionState::Idle);
        // Non-nested ingest cannot start while spend is active, nested ingest can
        assert!(!actor.can(&WalletCoordinatorEvent::ChainIngestBegin { nested: false }));
        assert!(actor.can(&WalletCoordinatorEvent::ChainIngestBegin { nested: true }));
    }

    #[test]
    fn recompose_blocks_all_other_regions_and_clamps_underflow() {
        let mut actor = EffectActor::<WalletCoordinatorMachine>::default();
        actor.send(WalletCoordinatorEvent::RecomposeBegin);
        assert!(!actor.can(&WalletCoordinatorEvent::ChainIngestBegin { nested: false }));
        assert!(!actor.can(&WalletCoordinatorEvent::ChainIngestBegin { nested: true }));
        assert!(!actor.can(&WalletCoordinatorEvent::SpendBegin));
        assert!(!actor.can(&WalletCoordinatorEvent::HistoryBegin));
        actor.send(WalletCoordinatorEvent::RecomposeEnd);
        actor.send(WalletCoordinatorEvent::RecomposeEnd);
        assert_eq!(actor.context().recompose_depth, 0);
        assert!(actor.can(&WalletCoordinatorEvent::HistoryBegin));
    }

    #[test]
    fn history_replica_blocks_spend_and_chain_ingest() {
        let mut actor = EffectActor::<WalletCoordinatorMachine>::default();
        actor.send(WalletCoordinatorEvent::HistoryBegin);
        assert!(!actor.can(&WalletCoordinatorEvent::SpendBegin));
        assert!(!actor.can(&WalletCoordinatorEvent::ChainIngestBegin { nested: false }));
        assert!(!actor.can(&WalletCoordinatorEvent::RecomposeBegin));
        actor.send(WalletCoordinatorEvent::HistoryEnd);
        assert!(actor.can(&WalletCoordinatorEvent::SpendBegin));
    }
}
