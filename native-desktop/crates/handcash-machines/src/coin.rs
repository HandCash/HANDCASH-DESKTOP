// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/coinMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoinOperation {
    Receive,
    Prove,
    Send,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoinState {
    Idle,
    Reading,
    Proving,
    Building,
    Broadcasting,
    Received,
    Refused,
    Pending,
    Proven,
    Voided,
    Sent,
    Queued,
    Failed,
}

impl CoinState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Reading => "reading",
            Self::Proving => "proving",
            Self::Building => "building",
            Self::Broadcasting => "broadcasting",
            Self::Received => "received",
            Self::Refused => "refused",
            Self::Pending => "pending",
            Self::Proven => "proven",
            Self::Voided => "voided",
            Self::Sent => "sent",
            Self::Queued => "queued",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CoinContext {
    pub operation: Option<CoinOperation>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoinEvent {
    Receive,
    Prove,
    Send,
    ResumeBroadcast { txid: String },
    Seen,
    Refused { error: String },
    Pending,
    Proven,
    Voided,
    Signed { txid: String },
    Broadcasted,
    BroadcastQueued { error: String },
    Fail { error: String },
}

pub struct CoinMachine;

impl Statechart for CoinMachine {
    type State = CoinState;
    type Context = CoinContext;
    type Event = CoinEvent;
    type Input = ();

    const ID: &'static str = "coin";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(CoinState::Idle, CoinContext::default())
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

impl HandCashChart for CoinMachine {
    const MANIFEST_ID: &'static str = "coin";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "reading",
        "proving",
        "building",
        "broadcasting",
        "received",
        "refused",
        "pending",
        "proven",
        "voided",
        "sent",
        "queued",
        "failed",
    ];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(
            state,
            CoinState::Received
                | CoinState::Refused
                | CoinState::Pending
                | CoinState::Proven
                | CoinState::Voided
                | CoinState::Sent
                | CoinState::Queued
                | CoinState::Failed
        )
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (CoinState::Idle, CoinEvent::Receive) => {
                ctx = CoinContext {
                    operation: Some(CoinOperation::Receive),
                    ..CoinContext::default()
                };
                CoinState::Reading
            }
            (CoinState::Idle, CoinEvent::Prove) => {
                ctx = CoinContext {
                    operation: Some(CoinOperation::Prove),
                    ..CoinContext::default()
                };
                CoinState::Proving
            }
            (CoinState::Idle, CoinEvent::Send) => {
                ctx = CoinContext {
                    operation: Some(CoinOperation::Send),
                    ..CoinContext::default()
                };
                CoinState::Building
            }
            (CoinState::Idle, CoinEvent::ResumeBroadcast { txid }) => {
                ctx = CoinContext {
                    operation: Some(CoinOperation::Send),
                    txid: Some(txid),
                    error: None,
                };
                CoinState::Broadcasting
            }
            (CoinState::Reading, CoinEvent::Seen) => CoinState::Received,
            (CoinState::Reading, CoinEvent::Refused { error }) => {
                ctx.error = Some(error);
                CoinState::Refused
            }
            (CoinState::Reading, CoinEvent::Fail { error }) => {
                ctx.error = Some(error);
                CoinState::Failed
            }
            (CoinState::Proving, CoinEvent::Proven) => CoinState::Proven,
            (CoinState::Proving, CoinEvent::Pending) => CoinState::Pending,
            (CoinState::Proving, CoinEvent::Voided) => CoinState::Voided,
            (CoinState::Proving, CoinEvent::Fail { error }) => {
                ctx.error = Some(error);
                CoinState::Failed
            }
            (CoinState::Building, CoinEvent::Signed { txid }) => {
                ctx.txid = Some(txid);
                CoinState::Broadcasting
            }
            (CoinState::Building, CoinEvent::Fail { error }) => {
                ctx.error = Some(error);
                CoinState::Failed
            }
            (CoinState::Broadcasting, CoinEvent::Broadcasted) => CoinState::Sent,
            (CoinState::Broadcasting, CoinEvent::BroadcastQueued { error }) => {
                ctx.error = Some(error);
                CoinState::Queued
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
    fn signed_coin_payment_never_fails_back_and_queues_broadcast_failures() {
        let mut actor = EffectActor::<CoinMachine>::default();
        actor.send(CoinEvent::Send);
        actor.send(CoinEvent::Signed {
            txid: "bb".repeat(32),
        });
        assert_eq!(*actor.state(), CoinState::Broadcasting);
        actor.send(CoinEvent::Fail {
            error: "ignored".to_string(),
        });
        assert_eq!(*actor.state(), CoinState::Broadcasting);
        actor.send(CoinEvent::BroadcastQueued {
            error: "rpc down".to_string(),
        });
        assert_eq!(*actor.state(), CoinState::Queued);
        assert!(actor.is_done());
    }
}
