// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/bsvSendMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BsvSendState {
    Idle,
    Preparing,
    Broadcasting,
    Done,
    Failed,
}

impl BsvSendState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::Broadcasting => "broadcasting",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BsvSendContext {
    pub to: String,
    pub satoshis: u64,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BsvSendEvent {
    Start { to: String, satoshis: u64 },
    Ready,
    Broadcasted { txid: String },
    Fail { error: String },
    Reset,
}

pub struct BsvSendMachine;

impl Statechart for BsvSendMachine {
    type State = BsvSendState;
    type Context = BsvSendContext;
    type Event = BsvSendEvent;
    type Input = ();

    const ID: &'static str = "bsvSend";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(BsvSendState::Idle, BsvSendContext::default())
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

impl HandCashChart for BsvSendMachine {
    const MANIFEST_ID: &'static str = "bsvSend";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["idle", "preparing", "broadcasting", "done", "failed"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (BsvSendState::Idle, BsvSendEvent::Start { to, satoshis }) => {
                ctx.to = to;
                ctx.satoshis = satoshis;
                ctx.txid = None;
                ctx.error = None;
                BsvSendState::Preparing
            }
            (BsvSendState::Preparing, BsvSendEvent::Ready) => BsvSendState::Broadcasting,
            (BsvSendState::Preparing, BsvSendEvent::Fail { error }) => {
                ctx.error = Some(error);
                BsvSendState::Failed
            }
            (BsvSendState::Broadcasting, BsvSendEvent::Broadcasted { txid }) => {
                ctx.txid = Some(txid);
                ctx.error = None;
                BsvSendState::Done
            }
            (BsvSendState::Broadcasting, BsvSendEvent::Fail { error }) => {
                ctx.error = Some(error);
                BsvSendState::Failed
            }
            (BsvSendState::Done | BsvSendState::Failed, BsvSendEvent::Reset) => {
                ctx = BsvSendContext::default();
                BsvSendState::Idle
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
    fn preparing_to_broadcasting_to_done() {
        let mut actor = EffectActor::<BsvSendMachine>::default();
        actor.send(BsvSendEvent::Start {
            to: "1Abc".to_string(),
            satoshis: 1000,
        });
        assert_eq!(*actor.state(), BsvSendState::Preparing);
        actor.send(BsvSendEvent::Ready);
        assert_eq!(*actor.state(), BsvSendState::Broadcasting);
        actor.send(BsvSendEvent::Broadcasted {
            txid: "a".repeat(64),
        });
        assert_eq!(*actor.state(), BsvSendState::Done);
    }

    #[test]
    fn fail_from_preparing_surfaces_as_failed() {
        let mut actor = EffectActor::<BsvSendMachine>::default();
        actor.send(BsvSendEvent::Start {
            to: "1Abc".to_string(),
            satoshis: 1000,
        });
        actor.send(BsvSendEvent::Fail {
            error: "Not enough BSV".to_string(),
        });
        assert_eq!(*actor.state(), BsvSendState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("Not enough BSV"));
    }
}
