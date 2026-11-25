// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/collectableSendRunMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStopReason {
    Fault,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollectableSendRunState {
    Idle,
    Sending,
    Splitting,
    Checking,
    Done,
    Halted,
}

impl CollectableSendRunState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Sending => "sending",
            Self::Splitting => "splitting",
            Self::Checking => "checking",
            Self::Done => "done",
            Self::Halted => "halted",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CollectableSendRunContext {
    pub planned: u32,
    pub queued: u32,
    pub sent_legs: u32,
    pub sent_items: u32,
    pub failed_items: u32,
    pub stopped: Option<RunStopReason>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CollectableSendRunEvent {
    Start { legs: u32 },
    LegSent { items: u32 },
    LegRejected { items: u32, reason: String },
    RunFault { reason: String, remaining_items: u32 },
    Reset,
}

pub struct CollectableSendRunMachine;

impl Statechart for CollectableSendRunMachine {
    type State = CollectableSendRunState;
    type Context = CollectableSendRunContext;
    type Event = CollectableSendRunEvent;
    type Input = ();

    const ID: &'static str = "collectableSendRun";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            CollectableSendRunState::Idle,
            CollectableSendRunContext::default(),
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

impl HandCashChart for CollectableSendRunMachine {
    const MANIFEST_ID: &'static str = "collectableSendRun";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "sending",
        "splitting",
        "checking",
        "done",
        "halted",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (CollectableSendRunState::Idle, CollectableSendRunEvent::Start { legs }) => {
                ctx = CollectableSendRunContext {
                    planned: legs,
                    queued: legs,
                    ..CollectableSendRunContext::default()
                };
                CollectableSendRunState::Sending
            }
            (CollectableSendRunState::Sending, CollectableSendRunEvent::LegSent { items }) => {
                ctx.queued = ctx.queued.saturating_sub(1);
                ctx.sent_legs += 1;
                ctx.sent_items += items;
                if ctx.queued > 0 {
                    CollectableSendRunState::Sending
                } else {
                    CollectableSendRunState::Done
                }
            }
            (
                CollectableSendRunState::Sending,
                CollectableSendRunEvent::LegRejected { items, reason },
            ) => {
                if items > 1 {
                    ctx.queued += 1;
                    ctx.error = Some(reason);
                    CollectableSendRunState::Sending
                } else {
                    ctx.queued = ctx.queued.saturating_sub(1);
                    ctx.failed_items += items;
                    ctx.error = Some(reason);
                    if ctx.queued > 0 {
                        CollectableSendRunState::Sending
                    } else {
                        CollectableSendRunState::Done
                    }
                }
            }
            (
                CollectableSendRunState::Sending,
                CollectableSendRunEvent::RunFault {
                    reason,
                    remaining_items,
                },
            ) => {
                ctx.failed_items += remaining_items;
                ctx.queued = 0;
                ctx.stopped = Some(RunStopReason::Fault);
                ctx.error = Some(reason);
                CollectableSendRunState::Halted
            }
            (
                CollectableSendRunState::Done | CollectableSendRunState::Halted,
                CollectableSendRunEvent::Reset,
            ) => {
                ctx = CollectableSendRunContext::default();
                CollectableSendRunState::Idle
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
    fn sends_every_queued_leg_then_settles() {
        let mut actor = EffectActor::<CollectableSendRunMachine>::default();
        actor.send(CollectableSendRunEvent::Start { legs: 3 });
        for _ in 0..3 {
            assert_eq!(*actor.state(), CollectableSendRunState::Sending);
            actor.send(CollectableSendRunEvent::LegSent { items: 25 });
        }
        assert_eq!(*actor.state(), CollectableSendRunState::Done);
        assert_eq!(actor.context().sent_legs, 3);
        assert_eq!(actor.context().sent_items, 75);
        assert!(actor.context().stopped.is_none());
    }

    #[test]
    fn queues_two_halves_when_a_multi_tip_leg_is_rejected() {
        let mut actor = EffectActor::<CollectableSendRunMachine>::default();
        actor.send(CollectableSendRunEvent::Start { legs: 1 });
        actor.send(CollectableSendRunEvent::LegRejected {
            items: 4,
            reason: "rejected".to_string(),
        });
        assert_eq!(*actor.state(), CollectableSendRunState::Sending);
        assert_eq!(actor.context().queued, 2);
        actor.send(CollectableSendRunEvent::LegSent { items: 2 });
        actor.send(CollectableSendRunEvent::LegRejected {
            items: 2,
            reason: "rejected".to_string(),
        });
        assert_eq!(actor.context().queued, 2);
    }

    #[test]
    fn records_a_failure_instead_of_splitting_a_single_tip() {
        let mut actor = EffectActor::<CollectableSendRunMachine>::default();
        actor.send(CollectableSendRunEvent::Start { legs: 1 });
        actor.send(CollectableSendRunEvent::LegRejected {
            items: 1,
            reason: "unspendable".to_string(),
        });
        assert_eq!(*actor.state(), CollectableSendRunState::Done);
        assert_eq!(actor.context().failed_items, 1);
        assert_eq!(actor.context().error.as_deref(), Some("unspendable"));
        assert!(actor.context().stopped.is_none());
    }

    #[test]
    fn halts_the_whole_run_on_a_wallet_fault_and_counts_the_untouched_legs() {
        let mut actor = EffectActor::<CollectableSendRunMachine>::default();
        actor.send(CollectableSendRunEvent::Start { legs: 10 });
        actor.send(CollectableSendRunEvent::LegSent { items: 25 });
        actor.send(CollectableSendRunEvent::RunFault {
            reason: "Not enough spendable BSV".to_string(),
            remaining_items: 225,
        });
        assert_eq!(*actor.state(), CollectableSendRunState::Halted);
        assert_eq!(actor.context().stopped, Some(RunStopReason::Fault));
        assert_eq!(actor.context().queued, 0);
        assert_eq!(actor.context().sent_items, 25);
        assert_eq!(actor.context().failed_items, 225);
    }

    #[test]
    fn will_not_accept_a_leg_outcome_once_halted() {
        let mut actor = EffectActor::<CollectableSendRunMachine>::default();
        actor.send(CollectableSendRunEvent::Start { legs: 2 });
        actor.send(CollectableSendRunEvent::RunFault {
            reason: "Wallet locked".to_string(),
            remaining_items: 50,
        });
        actor.send(CollectableSendRunEvent::LegSent { items: 25 });
        assert_eq!(actor.context().sent_items, 0);
        assert_eq!(*actor.state(), CollectableSendRunState::Halted);
    }

    #[test]
    fn splits_divisible_rejected_legs_and_completes_when_halves_send() {
        let mut actor = EffectActor::<CollectableSendRunMachine>::default();
        actor.send(CollectableSendRunEvent::Start { legs: 1 });
        assert_eq!(*actor.state(), CollectableSendRunState::Sending);
        actor.send(CollectableSendRunEvent::LegRejected {
            items: 2,
            reason: "too large".to_string(),
        });
        assert_eq!(*actor.state(), CollectableSendRunState::Sending);
        assert_eq!(actor.context().queued, 2);
        actor.send(CollectableSendRunEvent::LegSent { items: 1 });
        assert_eq!(*actor.state(), CollectableSendRunState::Sending);
        assert_eq!(actor.context().queued, 1);
        actor.send(CollectableSendRunEvent::LegSent { items: 1 });
        assert_eq!(*actor.state(), CollectableSendRunState::Done);
        assert_eq!(actor.context().sent_legs, 2);
        assert_eq!(actor.context().sent_items, 2);
    }

    #[test]
    fn halts_immediately_on_run_fault_and_resets_cleanly() {
        let mut actor = EffectActor::<CollectableSendRunMachine>::default();
        actor.send(CollectableSendRunEvent::Start { legs: 3 });
        actor.send(CollectableSendRunEvent::RunFault {
            reason: "not enough sats".to_string(),
            remaining_items: 6,
        });
        assert_eq!(*actor.state(), CollectableSendRunState::Halted);
        assert_eq!(actor.context().queued, 0);
        assert_eq!(actor.context().failed_items, 6);
        assert_eq!(actor.context().stopped, Some(RunStopReason::Fault));
        actor.send(CollectableSendRunEvent::Reset);
        assert_eq!(*actor.state(), CollectableSendRunState::Idle);
        assert_eq!(actor.context().planned, 0);
    }
}
