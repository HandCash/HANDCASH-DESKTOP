// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/relaySigninMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const RELAY_SIGNIN_POLL_MS: u64 = 2_000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewDeviceSignin {
    pub binding: String,
    pub online: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultTransfer {
    pub v: u32,
    pub kind: String,
    pub master_derivation: String,
    pub master_key_hex: String,
    pub sent_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SigninStep {
    Waiting {
        expires_at: u64,
    },
    Comparing {
        code: String,
        expires_at: u64,
    },
    Approved {
        transfer: VaultTransfer,
        approver_label: String,
    },
    Refused,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelaySigninState {
    Polling,
    Resting,
    Approved,
    Refused,
    Expired,
}

impl RelaySigninState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Polling => "polling",
            Self::Resting => "resting",
            Self::Approved => "approved",
            Self::Refused => "refused",
            Self::Expired => "expired",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelaySigninInput {
    pub signin: NewDeviceSignin,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelaySigninContext {
    pub signin: NewDeviceSignin,
    pub code: Option<String>,
    pub error: Option<String>,
    pub transfer: Option<VaultTransfer>,
    pub approver_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelaySigninEvent {
    AdvanceDone { step: SigninStep },
    AdvanceError { error: String },
    PollTimer,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelaySigninEffect {
    Advance,
    SchedulePoll { ms: u64 },
}

pub struct RelaySigninMachine;

impl Statechart for RelaySigninMachine {
    type State = RelaySigninState;
    type Context = RelaySigninContext;
    type Event = RelaySigninEvent;
    type Input = RelaySigninInput;

    const ID: &'static str = "relaySignin";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            RelaySigninState::Polling,
            RelaySigninContext {
                signin: input.signin,
                code: None,
                error: None,
                transfer: None,
                approver_label: None,
            },
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

impl HandCashChart for RelaySigninMachine {
    const MANIFEST_ID: &'static str = "relaySignin";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["polling", "resting", "approved", "refused", "expired"];
    type Effect = RelaySigninEffect;

    fn is_done(state: &Self::State) -> bool {
        matches!(
            state,
            RelaySigninState::Approved | RelaySigninState::Refused | RelaySigninState::Expired
        )
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (RelaySigninState::Polling, RelaySigninEvent::AdvanceDone { step }) => match step {
                SigninStep::Approved {
                    transfer,
                    approver_label,
                } => {
                    ctx.transfer = Some(transfer);
                    ctx.approver_label = Some(approver_label);
                    ctx.error = None;
                    RelaySigninState::Approved
                }
                SigninStep::Refused => RelaySigninState::Refused,
                SigninStep::Expired => RelaySigninState::Expired,
                SigninStep::Comparing { code, .. } => {
                    ctx.code = Some(code);
                    ctx.error = None;
                    effects.push(RelaySigninEffect::SchedulePoll {
                        ms: RELAY_SIGNIN_POLL_MS,
                    });
                    RelaySigninState::Resting
                }
                SigninStep::Waiting { .. } => {
                    ctx.code = None;
                    ctx.error = None;
                    effects.push(RelaySigninEffect::SchedulePoll {
                        ms: RELAY_SIGNIN_POLL_MS,
                    });
                    RelaySigninState::Resting
                }
            },
            (RelaySigninState::Polling, RelaySigninEvent::AdvanceError { error }) => {
                ctx.error = Some(error);
                effects.push(RelaySigninEffect::SchedulePoll {
                    ms: RELAY_SIGNIN_POLL_MS,
                });
                RelaySigninState::Resting
            }
            (RelaySigninState::Resting, RelaySigninEvent::PollTimer) => {
                effects.push(RelaySigninEffect::Advance);
                RelaySigninState::Polling
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn sample_input() -> RelaySigninInput {
        RelaySigninInput {
            signin: NewDeviceSignin {
                binding: "b".repeat(32),
                online: 1,
            },
        }
    }

    fn sample_transfer() -> VaultTransfer {
        VaultTransfer {
            v: 1,
            kind: "handcash-brc250-vault".to_string(),
            master_derivation: "brc-42".to_string(),
            master_key_hex: "11".repeat(32),
            sent_at: 1,
        }
    }

    #[test]
    fn never_starts_a_read_while_the_last_one_is_still_out() {
        let mut actor = EffectActor::<RelaySigninMachine>::new(sample_input());
        assert_eq!(*actor.state(), RelaySigninState::Polling);
        // Timer firing while still polling is ignored (no overlapping read).
        assert!(actor.send(RelaySigninEvent::PollTimer).is_empty());
        assert_eq!(*actor.state(), RelaySigninState::Polling);

        let fx = actor.send(RelaySigninEvent::AdvanceDone {
            step: SigninStep::Waiting { expires_at: 1 },
        });
        assert_eq!(*actor.state(), RelaySigninState::Resting);
        assert_eq!(
            fx,
            vec![RelaySigninEffect::SchedulePoll {
                ms: RELAY_SIGNIN_POLL_MS
            }]
        );
        let fx = actor.send(RelaySigninEvent::PollTimer);
        assert_eq!(*actor.state(), RelaySigninState::Polling);
        assert_eq!(fx, vec![RelaySigninEffect::Advance]);
    }

    #[test]
    fn shows_the_comparison_code_and_keeps_polling() {
        let mut actor = EffectActor::<RelaySigninMachine>::new(sample_input());
        actor.send(RelaySigninEvent::AdvanceDone {
            step: SigninStep::Comparing {
                code: "12345678".to_string(),
                expires_at: 1,
            },
        });
        assert_eq!(*actor.state(), RelaySigninState::Resting);
        assert_eq!(actor.context().code.as_deref(), Some("12345678"));
    }

    #[test]
    fn says_when_the_network_dropped_and_clears_it_once_the_relay_answers_again() {
        let mut actor = EffectActor::<RelaySigninMachine>::new(sample_input());
        actor.send(RelaySigninEvent::AdvanceError {
            error: "No connection".to_string(),
        });
        assert_eq!(actor.context().error.as_deref(), Some("No connection"));
        actor.send(RelaySigninEvent::PollTimer);
        actor.send(RelaySigninEvent::AdvanceDone {
            step: SigninStep::Waiting { expires_at: 1 },
        });
        assert!(actor.context().error.is_none());
        assert_eq!(*actor.state(), RelaySigninState::Resting);
    }

    #[test]
    fn stops_at_approval_with_the_vault_and_reads_no_more() {
        let transfer = sample_transfer();
        let mut actor = EffectActor::<RelaySigninMachine>::new(sample_input());
        let fx = actor.send(RelaySigninEvent::AdvanceDone {
            step: SigninStep::Approved {
                transfer: transfer.clone(),
                approver_label: "Mac".to_string(),
            },
        });
        assert!(fx.is_empty());
        assert!(actor.is_done());
        assert_eq!(*actor.state(), RelaySigninState::Approved);
        assert_eq!(actor.context().transfer.as_ref(), Some(&transfer));
        assert_eq!(actor.context().approver_label.as_deref(), Some("Mac"));
        assert!(actor.send(RelaySigninEvent::PollTimer).is_empty());
    }

    #[test]
    fn ends_on_refusal_or_expiry() {
        let mut refused = EffectActor::<RelaySigninMachine>::new(sample_input());
        refused.send(RelaySigninEvent::AdvanceDone {
            step: SigninStep::Refused,
        });
        assert_eq!(*refused.state(), RelaySigninState::Refused);
        assert!(refused.is_done());

        let mut expired = EffectActor::<RelaySigninMachine>::new(sample_input());
        expired.send(RelaySigninEvent::AdvanceDone {
            step: SigninStep::Expired,
        });
        assert_eq!(*expired.state(), RelaySigninState::Expired);
        assert!(expired.is_done());
    }
}
