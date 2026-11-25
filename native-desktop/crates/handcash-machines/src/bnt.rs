// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/bntMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BntOperation {
    Issue,
    Mint,
    Transfer,
    Burn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BntState {
    Idle,
    Building,
    Signing,
    Signed,
    Delivering,
    Committed,
    Failed,
}

impl BntState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Building => "building",
            Self::Signing => "signing",
            Self::Signed => "signed",
            Self::Delivering => "delivering",
            Self::Committed => "committed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BntContext {
    pub operation: Option<BntOperation>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BntEvent {
    Issue,
    Mint,
    Transfer,
    Burn,
    Built,
    Signed { txid: String },
    Broadcasted,
    Delivered,
    Queued,
    Fail { error: String },
}

pub struct BntMachine;

impl Statechart for BntMachine {
    type State = BntState;
    type Context = BntContext;
    type Event = BntEvent;
    type Input = ();

    const ID: &'static str = "bnt";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(BntState::Idle, BntContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        StateValue::leaf(state.as_str())
    }
}

impl HandCashChart for BntMachine {
    const MANIFEST_ID: &'static str = "bnt";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "building",
        "signing",
        "signed",
        "delivering",
        "committed",
        "failed",
    ];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(state, BntState::Committed | BntState::Failed)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (BntState::Idle, BntEvent::Issue) => {
                ctx = BntContext {
                    operation: Some(BntOperation::Issue),
                    ..BntContext::default()
                };
                BntState::Building
            }
            (BntState::Idle, BntEvent::Mint) => {
                ctx = BntContext {
                    operation: Some(BntOperation::Mint),
                    ..BntContext::default()
                };
                BntState::Building
            }
            (BntState::Idle, BntEvent::Transfer) => {
                ctx = BntContext {
                    operation: Some(BntOperation::Transfer),
                    ..BntContext::default()
                };
                BntState::Building
            }
            (BntState::Idle, BntEvent::Burn) => {
                ctx = BntContext {
                    operation: Some(BntOperation::Burn),
                    ..BntContext::default()
                };
                BntState::Building
            }
            (BntState::Building, BntEvent::Built) => BntState::Signing,
            (BntState::Building, BntEvent::Fail { error }) => {
                ctx.error = Some(error);
                BntState::Failed
            }
            (BntState::Signing, BntEvent::Signed { txid }) => {
                ctx.txid = Some(txid);
                BntState::Signed
            }
            (BntState::Signing, BntEvent::Fail { error }) => {
                ctx.error = Some(error);
                BntState::Failed
            }
            (BntState::Signed, BntEvent::Broadcasted) => BntState::Delivering,
            (BntState::Signed, BntEvent::Fail { error }) => {
                ctx.error = Some(error);
                BntState::Signed
            }
            (BntState::Delivering, BntEvent::Delivered | BntEvent::Queued) => BntState::Committed,
            (BntState::Delivering, BntEvent::Fail { error }) => {
                ctx.error = Some(error);
                BntState::Delivering
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn never_voids_a_transfer_after_signed_and_commits_on_queued_delivery() {
        let mut actor = EffectActor::<BntMachine>::default();
        actor.send(BntEvent::Transfer);
        actor.send(BntEvent::Built);
        actor.send(BntEvent::Signed {
            txid: "aa".repeat(32),
        });
        assert_eq!(*actor.state(), BntState::Signed);
        actor.send(BntEvent::Fail {
            error: "network glitch".to_string(),
        });
        assert_eq!(*actor.state(), BntState::Signed);
        actor.send(BntEvent::Broadcasted);
        actor.send(BntEvent::Queued);
        assert_eq!(*actor.state(), BntState::Committed);
        assert!(actor.is_done());
    }
}
