// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/pairingCodeMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingOutcome {
    Ok,
    Rejected {
        ended: bool,
        attempts_left: u32,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairingCodeState {
    Entering,
    Verifying,
    Sending,
    Approved,
    Ended,
}

impl PairingCodeState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Entering => "entering",
            Self::Verifying => "verifying",
            Self::Sending => "sending",
            Self::Approved => "approved",
            Self::Ended => "ended",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairingCodeInput {
    pub length: usize,
    pub attempts_left: u32,
}

impl Default for PairingCodeInput {
    fn default() -> Self {
        Self {
            length: 6,
            attempts_left: 3,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairingCodeContext {
    pub length: usize,
    pub attempts_left: u32,
    pub digits: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingCodeEvent {
    Type { value: String },
    VerifyDone { outcome: PairingOutcome },
    VerifyError { error: Option<String> },
    ApproveDone,
    ApproveError { error: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingCodeEffect {
    Verify { digits: String },
    Approve,
}

pub struct PairingCodeMachine;

impl Statechart for PairingCodeMachine {
    type State = PairingCodeState;
    type Context = PairingCodeContext;
    type Event = PairingCodeEvent;
    type Input = PairingCodeInput;

    const ID: &'static str = "pairingCode";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            PairingCodeState::Entering,
            PairingCodeContext {
                length: input.length,
                attempts_left: input.attempts_left,
                digits: String::new(),
                error: None,
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

fn is_ascii_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

impl HandCashChart for PairingCodeMachine {
    const MANIFEST_ID: &'static str = "pairingCode";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["entering", "verifying", "sending", "approved", "ended"];
    type Effect = PairingCodeEffect;

    fn is_done(state: &Self::State) -> bool {
        matches!(state, PairingCodeState::Approved | PairingCodeState::Ended)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (PairingCodeState::Entering, PairingCodeEvent::Type { value }) => {
                let one_digit_more = is_ascii_digits(&value)
                    && value.len() == ctx.digits.len() + 1
                    && value.starts_with(&ctx.digits)
                    && value.len() <= ctx.length;
                let complete = one_digit_more && value.len() == ctx.length;
                let one_less =
                    value.len() + 1 == ctx.digits.len() && ctx.digits.starts_with(&value);

                if complete {
                    ctx.digits = value.clone();
                    ctx.error = None;
                    effects.push(PairingCodeEffect::Verify { digits: value });
                    PairingCodeState::Verifying
                } else if one_digit_more {
                    ctx.digits = value;
                    ctx.error = None;
                    PairingCodeState::Entering
                } else if one_less {
                    ctx.digits = value;
                    PairingCodeState::Entering
                } else {
                    return (snapshot.clone(), Vec::new());
                }
            }
            (PairingCodeState::Verifying, PairingCodeEvent::VerifyDone { outcome }) => match outcome {
                PairingOutcome::Ok => {
                    effects.push(PairingCodeEffect::Approve);
                    PairingCodeState::Sending
                }
                PairingOutcome::Rejected {
                    ended: true,
                    message,
                    ..
                } => {
                    ctx.error = Some(message);
                    ctx.digits.clear();
                    PairingCodeState::Ended
                }
                PairingOutcome::Rejected {
                    ended: false,
                    attempts_left,
                    message,
                } => {
                    ctx.digits.clear();
                    ctx.attempts_left = attempts_left;
                    ctx.error = Some(message);
                    PairingCodeState::Entering
                }
            },
            (PairingCodeState::Verifying, PairingCodeEvent::VerifyError { error }) => {
                ctx.digits.clear();
                ctx.error = Some(
                    error.unwrap_or_else(|| "Could not reach the other device".to_string()),
                );
                PairingCodeState::Entering
            }
            (PairingCodeState::Sending, PairingCodeEvent::ApproveDone) => {
                PairingCodeState::Approved
            }
            (PairingCodeState::Sending, PairingCodeEvent::ApproveError { error }) => {
                ctx.error =
                    Some(error.unwrap_or_else(|| "Could not send the wallet".to_string()));
                PairingCodeState::Ended
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

    fn type_all(actor: &mut EffectActor<PairingCodeMachine>, code: &str) {
        let mut prefix = String::new();
        for ch in code.chars() {
            prefix.push(ch);
            actor.send(PairingCodeEvent::Type {
                value: prefix.clone(),
            });
        }
    }

    #[test]
    fn waits_for_receiver_receipt_before_showing_approved() {
        let mut actor = EffectActor::<PairingCodeMachine>::default();
        type_all(&mut actor, "123456");
        assert_eq!(*actor.state(), PairingCodeState::Verifying);
        assert_eq!(
            actor.take_effects(),
            vec![PairingCodeEffect::Verify {
                digits: "123456".to_string()
            }]
        );
        let fx = actor.send(PairingCodeEvent::VerifyDone {
            outcome: PairingOutcome::Ok,
        });
        assert_eq!(*actor.state(), PairingCodeState::Sending);
        assert_eq!(fx, vec![PairingCodeEffect::Approve]);
        assert!(!actor.is_done());
        actor.send(PairingCodeEvent::ApproveDone);
        assert_eq!(*actor.state(), PairingCodeState::Approved);
        assert!(actor.is_done());
    }

    #[test]
    fn ignores_autofill_paste_and_any_multi_character_change() {
        let mut actor = EffectActor::<PairingCodeMachine>::default();
        for bad in ["123456", "12", "1a"] {
            actor.send(PairingCodeEvent::Type {
                value: bad.to_string(),
            });
        }
        assert_eq!(*actor.state(), PairingCodeState::Entering);
        assert_eq!(actor.context().digits, "");
        actor.send(PairingCodeEvent::Type {
            value: "1".to_string(),
        });
        for bad in ["123456", "1x"] {
            actor.send(PairingCodeEvent::Type {
                value: bad.to_string(),
            });
        }
        assert_eq!(actor.context().digits, "1");
        assert!(actor.effects().is_empty());
    }

    #[test]
    fn wrong_code_clears_field_and_shows_tries_left_without_approving() {
        let mut actor = EffectActor::<PairingCodeMachine>::default();
        type_all(&mut actor, "111111");
        actor.take_effects();
        let fx = actor.send(PairingCodeEvent::VerifyDone {
            outcome: PairingOutcome::Rejected {
                ended: false,
                attempts_left: 2,
                message: "Not that code. 2 tries left".to_string(),
            },
        });
        assert_eq!(*actor.state(), PairingCodeState::Entering);
        assert_eq!(actor.context().attempts_left, 2);
        assert_eq!(actor.context().digits, "");
        assert_eq!(
            actor.context().error.as_deref(),
            Some("Not that code. 2 tries left")
        );
        assert!(fx.is_empty());
    }

    #[test]
    fn locked_or_expired_session_ends_without_sending_the_wallet() {
        for message in ["Too many wrong codes", "The code expired"] {
            let mut actor = EffectActor::<PairingCodeMachine>::default();
            type_all(&mut actor, "222222");
            actor.take_effects();
            let fx = actor.send(PairingCodeEvent::VerifyDone {
                outcome: PairingOutcome::Rejected {
                    ended: true,
                    attempts_left: 0,
                    message: message.to_string(),
                },
            });
            assert_eq!(*actor.state(), PairingCodeState::Ended);
            assert!(actor.is_done());
            assert_eq!(actor.context().error.as_deref(), Some(message));
            assert!(fx.is_empty());
        }
    }

    #[test]
    fn failed_send_ends_with_the_reason_and_never_reaches_approved() {
        let mut actor = EffectActor::<PairingCodeMachine>::default();
        type_all(&mut actor, "333333");
        actor.send(PairingCodeEvent::VerifyDone {
            outcome: PairingOutcome::Ok,
        });
        actor.send(PairingCodeEvent::ApproveError {
            error: Some("Could not reach Mac".to_string()),
        });
        assert_eq!(*actor.state(), PairingCodeState::Ended);
        assert_eq!(actor.context().error.as_deref(), Some("Could not reach Mac"));
    }

    #[test]
    fn input_is_ignored_while_checking() {
        let mut actor = EffectActor::<PairingCodeMachine>::default();
        type_all(&mut actor, "444444");
        assert_eq!(*actor.state(), PairingCodeState::Verifying);
        actor.send(PairingCodeEvent::Type {
            value: "4".to_string(),
        });
        assert_eq!(actor.context().digits, "444444");
        actor.send(PairingCodeEvent::VerifyDone {
            outcome: PairingOutcome::Rejected {
                ended: false,
                attempts_left: 1,
                message: "no".to_string(),
            },
        });
        assert_eq!(*actor.state(), PairingCodeState::Entering);
    }
}
