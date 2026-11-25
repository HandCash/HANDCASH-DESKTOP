// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/burnMachine.ts` and `src/wallet/burnPlan.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BurnRefusalReason {
    NoTips,
    UnknownLock,
    CovenantLocked,
    NotOwned,
    NotOneSat,
}

impl BurnRefusalReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoTips => "no_tips",
            Self::UnknownLock => "unknown_lock",
            Self::CovenantLocked => "covenant_locked",
            Self::NotOwned => "not_owned",
            Self::NotOneSat => "not_one_sat",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BurnInput {
    pub outpoint: String,
    pub satoshis: u64,
    pub locking_script: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OneSatBurnPlan {
    Refuse {
        reason: BurnRefusalReason,
    },
    BurnOneSat {
        inputs: Vec<BurnInput>,
        recover_satoshis: u64,
    },
}

pub type BurnPlan = OneSatBurnPlan;

pub const fn burn_recovery_output_satoshis(recover_satoshis: u64) -> u64 {
    if recover_satoshis == 0 {
        0
    } else if recover_satoshis < 2 {
        2
    } else {
        recover_satoshis
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BurnState {
    Idle,
    Planning,
    Building,
    Signing,
    Broadcasting,
    Internalizing,
    Refreshing,
    Done,
    Failed,
}

impl BurnState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Planning => "planning",
            Self::Building => "building",
            Self::Signing => "signing",
            Self::Broadcasting => "broadcasting",
            Self::Internalizing => "internalizing",
            Self::Refreshing => "refreshing",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BurnContext {
    pub plan: Option<BurnPlan>,
    pub reference: Option<String>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BurnEvent {
    Start { plan: BurnPlan },
    Built { reference: Option<String> },
    Signed { txid: String },
    Broadcasted,
    Internalized,
    Refreshed,
    Fail { error: String },
    Reset,
}

pub struct BurnMachine;

impl Statechart for BurnMachine {
    type State = BurnState;
    type Context = BurnContext;
    type Event = BurnEvent;
    type Input = ();

    const ID: &'static str = "burn";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(BurnState::Idle, BurnContext::default())
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

impl HandCashChart for BurnMachine {
    const MANIFEST_ID: &'static str = "burn";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "planning",
        "building",
        "signing",
        "broadcasting",
        "internalizing",
        "refreshing",
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
            (BurnState::Idle, BurnEvent::Start { plan }) => {
                ctx.plan = Some(plan);
                ctx.reference = None;
                ctx.txid = None;
                ctx.error = None;
                match &ctx.plan {
                    Some(BurnPlan::BurnOneSat { .. }) => BurnState::Building,
                    Some(BurnPlan::Refuse { reason }) => {
                        ctx.error = Some(reason.as_str().to_string());
                        BurnState::Failed
                    }
                    None => {
                        ctx.error = Some("Burn plan was not classified".to_string());
                        BurnState::Failed
                    }
                }
            }
            (BurnState::Building, BurnEvent::Built { reference }) => {
                ctx.reference = reference;
                BurnState::Signing
            }
            (BurnState::Building, BurnEvent::Fail { error }) => {
                ctx.error = Some(error);
                BurnState::Failed
            }
            (BurnState::Signing, BurnEvent::Signed { txid }) => {
                ctx.txid = Some(txid);
                BurnState::Broadcasting
            }
            (BurnState::Signing, BurnEvent::Fail { error }) => {
                ctx.error = Some(error);
                BurnState::Failed
            }
            (BurnState::Broadcasting, BurnEvent::Broadcasted) => BurnState::Internalizing,
            (BurnState::Broadcasting, BurnEvent::Fail { error }) => {
                ctx.error = Some(error);
                BurnState::Failed
            }
            (BurnState::Internalizing, BurnEvent::Internalized) => BurnState::Refreshing,
            (BurnState::Internalizing, BurnEvent::Fail { error }) => {
                ctx.error = Some(error);
                BurnState::Failed
            }
            (BurnState::Refreshing, BurnEvent::Refreshed) => BurnState::Done,
            (BurnState::Refreshing, BurnEvent::Fail { error }) => {
                ctx.error = Some(error);
                BurnState::Failed
            }
            (BurnState::Done | BurnState::Failed, BurnEvent::Reset) => {
                ctx = BurnContext::default();
                BurnState::Idle
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

    fn executable_plan() -> OneSatBurnPlan {
        OneSatBurnPlan::BurnOneSat {
            inputs: vec![BurnInput {
                outpoint: format!("{}.0", "ab".repeat(32)),
                satoshis: 1,
                locking_script: format!("76a914{}88ac", "11".repeat(20)),
            }],
            recover_satoshis: 1,
        }
    }

    #[test]
    fn requires_every_execution_phase_before_completion() {
        let mut actor = EffectActor::<BurnMachine>::default();
        actor.send(BurnEvent::Start {
            plan: executable_plan(),
        });
        assert_eq!(*actor.state(), BurnState::Building);
        actor.send(BurnEvent::Built {
            reference: Some("ref-1".to_string()),
        });
        actor.send(BurnEvent::Signed {
            txid: "cd".repeat(32),
        });
        actor.send(BurnEvent::Broadcasted);
        actor.send(BurnEvent::Internalized);
        actor.send(BurnEvent::Refreshed);
        assert_eq!(*actor.state(), BurnState::Done);
        assert_eq!(actor.context().txid.as_deref(), Some("cd".repeat(32).as_str()));
    }

    #[test]
    fn fails_closed_for_a_refused_plan() {
        let mut actor = EffectActor::<BurnMachine>::default();
        actor.send(BurnEvent::Start {
            plan: OneSatBurnPlan::Refuse {
                reason: BurnRefusalReason::UnknownLock,
            },
        });
        assert_eq!(*actor.state(), BurnState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("unknown_lock"));
    }

    #[test]
    fn records_a_terminal_execution_failure() {
        let mut actor = EffectActor::<BurnMachine>::default();
        actor.send(BurnEvent::Start {
            plan: executable_plan(),
        });
        actor.send(BurnEvent::Fail {
            error: "signing failed".to_string(),
        });
        assert_eq!(*actor.state(), BurnState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("signing failed"));
    }
}
