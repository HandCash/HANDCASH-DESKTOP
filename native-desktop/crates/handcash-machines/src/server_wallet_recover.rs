// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/serverWalletRecoverMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDevRecover {
    pub txid: String,
    pub atomic_beef_b64: String,
    pub satoshis: u64,
    pub derivation_prefix: String,
    pub derivation_suffix: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DevWalletRecoverPlan {
    Recover { satoshis: u64 },
    Finish { pending: PendingDevRecover },
    Refuse { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerWalletRecoverState {
    Idle,
    Planning,
    Spending,
    Internalizing,
    Done,
    Failed,
}

impl ServerWalletRecoverState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Planning => "planning",
            Self::Spending => "spending",
            Self::Internalizing => "internalizing",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServerWalletRecoverContext {
    pub plan: Option<DevWalletRecoverPlan>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerWalletRecoverEvent {
    Start { plan: DevWalletRecoverPlan },
    Spent { txid: String },
    Internalized,
    Fail { error: String },
    Reset,
}

pub struct ServerWalletRecoverMachine;

impl Statechart for ServerWalletRecoverMachine {
    type State = ServerWalletRecoverState;
    type Context = ServerWalletRecoverContext;
    type Event = ServerWalletRecoverEvent;
    type Input = ();

    const ID: &'static str = "serverWalletRecover";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            ServerWalletRecoverState::Idle,
            ServerWalletRecoverContext::default(),
        )
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

impl HandCashChart for ServerWalletRecoverMachine {
    const MANIFEST_ID: &'static str = "serverWalletRecover";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "planning",
        "spending",
        "internalizing",
        "done",
        "failed",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (ServerWalletRecoverState::Idle, ServerWalletRecoverEvent::Start { plan }) => {
                ctx.plan = Some(plan);
                ctx.txid = None;
                ctx.error = None;
                match &ctx.plan {
                    Some(DevWalletRecoverPlan::Recover { .. }) => {
                        ServerWalletRecoverState::Spending
                    }
                    Some(DevWalletRecoverPlan::Finish { pending }) => {
                        ctx.txid = Some(pending.txid.clone());
                        ServerWalletRecoverState::Internalizing
                    }
                    Some(DevWalletRecoverPlan::Refuse { reason }) => {
                        ctx.error = Some(reason.clone());
                        ServerWalletRecoverState::Failed
                    }
                    None => {
                        ctx.error = Some("Recover plan was not classified".to_string());
                        ServerWalletRecoverState::Failed
                    }
                }
            }
            (ServerWalletRecoverState::Spending, ServerWalletRecoverEvent::Spent { txid }) => {
                ctx.txid = Some(txid);
                ServerWalletRecoverState::Internalizing
            }
            (ServerWalletRecoverState::Spending, ServerWalletRecoverEvent::Fail { error }) => {
                ctx.error = Some(error);
                ServerWalletRecoverState::Failed
            }
            (ServerWalletRecoverState::Internalizing, ServerWalletRecoverEvent::Internalized) => {
                ServerWalletRecoverState::Done
            }
            (ServerWalletRecoverState::Internalizing, ServerWalletRecoverEvent::Fail { error }) => {
                ctx.error = Some(error);
                ServerWalletRecoverState::Failed
            }
            (
                ServerWalletRecoverState::Done | ServerWalletRecoverState::Failed,
                ServerWalletRecoverEvent::Reset,
            ) => {
                ctx = ServerWalletRecoverContext::default();
                ServerWalletRecoverState::Idle
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

    fn sample_pending() -> PendingDevRecover {
        PendingDevRecover {
            txid: "bb".repeat(32),
            atomic_beef_b64: "AA==".to_string(),
            satoshis: 9_000,
            derivation_prefix: "a".to_string(),
            derivation_suffix: "b".to_string(),
        }
    }

    #[test]
    fn walks_recover_from_the_server_spend_to_internalize() {
        let pending = sample_pending();
        let mut actor = EffectActor::<ServerWalletRecoverMachine>::default();
        actor.send(ServerWalletRecoverEvent::Start {
            plan: DevWalletRecoverPlan::Recover { satoshis: 9_900 },
        });
        assert_eq!(*actor.state(), ServerWalletRecoverState::Spending);
        actor.send(ServerWalletRecoverEvent::Spent {
            txid: pending.txid.clone(),
        });
        assert_eq!(*actor.state(), ServerWalletRecoverState::Internalizing);
        actor.send(ServerWalletRecoverEvent::Internalized);
        assert_eq!(*actor.state(), ServerWalletRecoverState::Done);
        assert_eq!(actor.context().txid.as_deref(), Some(pending.txid.as_str()));
    }

    #[test]
    fn finishes_a_broadcast_recovery_by_internalizing_only() {
        let pending = sample_pending();
        let expected_txid = pending.txid.clone();
        let mut actor = EffectActor::<ServerWalletRecoverMachine>::default();
        actor.send(ServerWalletRecoverEvent::Start {
            plan: DevWalletRecoverPlan::Finish { pending },
        });
        assert_eq!(*actor.state(), ServerWalletRecoverState::Internalizing);
        assert_eq!(actor.context().txid.as_deref(), Some(expected_txid.as_str()));
    }

    #[test]
    fn fails_closed_with_the_named_refusal() {
        let mut actor = EffectActor::<ServerWalletRecoverMachine>::default();
        actor.send(ServerWalletRecoverEvent::Start {
            plan: DevWalletRecoverPlan::Refuse {
                reason: "uneconomical".to_string(),
            },
        });
        assert_eq!(*actor.state(), ServerWalletRecoverState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("uneconomical"));
    }
}
