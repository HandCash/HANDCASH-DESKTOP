// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/onboardEmailMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub fn onboard_email_code(raw: &str) -> String {
    raw.chars().filter(|c| c.is_ascii_digit()).take(6).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnboardEmailState {
    Entering,
    Sending,
    Code,
    Saving,
    Saved,
    Skipped,
}

impl OnboardEmailState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Entering => "entering",
            Self::Sending => "sending",
            Self::Code => "code",
            Self::Saving => "saving",
            Self::Saved => "saved",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OnboardEmailContext {
    pub email: String,
    pub code: String,
    pub request_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OnboardEmailEvent {
    EditEmail { email: String },
    EditCode { code: String },
    Send,
    SendCodeDone { request_id: String, dev_code: Option<String> },
    SendCodeError { error: String },
    Confirm,
    RegisterDone { email: String },
    RegisterError { error: String },
    Back,
    Skip,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OnboardEmailEffect {
    SendCode { email: String },
    Register { request_id: String, code: String },
}

pub struct OnboardEmailMachine;

impl Statechart for OnboardEmailMachine {
    type State = OnboardEmailState;
    type Context = OnboardEmailContext;
    type Event = OnboardEmailEvent;
    type Input = ();

    const ID: &'static str = "onboardEmail";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            OnboardEmailState::Entering,
            OnboardEmailContext::default(),
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

impl HandCashChart for OnboardEmailMachine {
    const MANIFEST_ID: &'static str = "onboardEmail";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["entering", "sending", "code", "saving", "saved", "skipped"];
    type Effect = OnboardEmailEffect;

    fn is_done(state: &Self::State) -> bool {
        matches!(state, OnboardEmailState::Saved | OnboardEmailState::Skipped)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (OnboardEmailState::Entering, OnboardEmailEvent::EditEmail { email }) => {
                ctx.email = email;
                OnboardEmailState::Entering
            }
            (OnboardEmailState::Entering, OnboardEmailEvent::Send) => {
                let trimmed = ctx.email.trim().to_string();
                if trimmed.is_empty() {
                    return (snapshot.clone(), Vec::new());
                }
                ctx.error = None;
                effects.push(OnboardEmailEffect::SendCode { email: trimmed });
                OnboardEmailState::Sending
            }
            (OnboardEmailState::Entering, OnboardEmailEvent::Skip) => OnboardEmailState::Skipped,
            (
                OnboardEmailState::Sending,
                OnboardEmailEvent::SendCodeDone {
                    request_id,
                    dev_code,
                },
            ) => {
                ctx.request_id = Some(request_id);
                ctx.code = onboard_email_code(dev_code.as_deref().unwrap_or_default());
                OnboardEmailState::Code
            }
            (OnboardEmailState::Sending, OnboardEmailEvent::SendCodeError { error }) => {
                ctx.error = Some(error);
                OnboardEmailState::Entering
            }
            (OnboardEmailState::Code, OnboardEmailEvent::EditCode { code }) => {
                ctx.code = onboard_email_code(&code);
                OnboardEmailState::Code
            }
            (OnboardEmailState::Code, OnboardEmailEvent::Confirm) => {
                if ctx.code.len() != 6 || ctx.request_id.is_none() {
                    return (snapshot.clone(), Vec::new());
                }
                ctx.error = None;
                effects.push(OnboardEmailEffect::Register {
                    request_id: ctx.request_id.clone().unwrap_or_default(),
                    code: ctx.code.clone(),
                });
                OnboardEmailState::Saving
            }
            (OnboardEmailState::Code, OnboardEmailEvent::Back) => {
                ctx.code.clear();
                ctx.request_id = None;
                ctx.error = None;
                OnboardEmailState::Entering
            }
            (OnboardEmailState::Code, OnboardEmailEvent::Skip) => OnboardEmailState::Skipped,
            (OnboardEmailState::Saving, OnboardEmailEvent::RegisterDone { email }) => {
                ctx.email = email;
                OnboardEmailState::Saved
            }
            (OnboardEmailState::Saving, OnboardEmailEvent::RegisterError { error }) => {
                ctx.error = Some(error);
                OnboardEmailState::Code
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

    #[test]
    fn sends_a_code_to_the_trimmed_email_then_saves_once_the_6_digit_code_is_in() {
        let mut actor = EffectActor::<OnboardEmailMachine>::default();
        actor.send(OnboardEmailEvent::EditEmail {
            email: "  me@example.com ".to_string(),
        });
        let fx = actor.send(OnboardEmailEvent::Send);
        assert_eq!(*actor.state(), OnboardEmailState::Sending);
        assert_eq!(
            fx,
            vec![OnboardEmailEffect::SendCode {
                email: "me@example.com".to_string()
            }]
        );
        actor.send(OnboardEmailEvent::SendCodeDone {
            request_id: "req-1".to_string(),
            dev_code: None,
        });
        assert_eq!(*actor.state(), OnboardEmailState::Code);

        actor.send(OnboardEmailEvent::EditCode {
            code: "12a34".to_string(),
        });
        actor.send(OnboardEmailEvent::Confirm);
        assert_eq!(*actor.state(), OnboardEmailState::Code);

        actor.send(OnboardEmailEvent::EditCode {
            code: "123 456 7".to_string(),
        });
        assert_eq!(actor.context().code, "123456");
        let fx = actor.send(OnboardEmailEvent::Confirm);
        assert_eq!(*actor.state(), OnboardEmailState::Saving);
        assert_eq!(
            fx,
            vec![OnboardEmailEffect::Register {
                request_id: "req-1".to_string(),
                code: "123456".to_string()
            }]
        );
        actor.send(OnboardEmailEvent::RegisterDone {
            email: "me@example.com".to_string(),
        });
        assert_eq!(*actor.state(), OnboardEmailState::Saved);
        assert!(actor.is_done());
    }

    #[test]
    fn needs_an_email_before_sending_and_can_be_skipped() {
        let mut actor = EffectActor::<OnboardEmailMachine>::default();
        actor.send(OnboardEmailEvent::EditEmail {
            email: "   ".to_string(),
        });
        let fx = actor.send(OnboardEmailEvent::Send);
        assert_eq!(*actor.state(), OnboardEmailState::Entering);
        assert!(fx.is_empty());
        actor.send(OnboardEmailEvent::Skip);
        assert_eq!(*actor.state(), OnboardEmailState::Skipped);
        assert!(actor.is_done());
    }

    #[test]
    fn fills_the_code_a_dev_relay_returns() {
        let mut actor = EffectActor::<OnboardEmailMachine>::default();
        actor.send(OnboardEmailEvent::EditEmail {
            email: "me@example.com".to_string(),
        });
        actor.send(OnboardEmailEvent::Send);
        actor.send(OnboardEmailEvent::SendCodeDone {
            request_id: "req-2".to_string(),
            dev_code: Some("654321".to_string()),
        });
        assert_eq!(*actor.state(), OnboardEmailState::Code);
        assert_eq!(actor.context().code, "654321");
    }

    #[test]
    fn returns_to_the_email_with_the_reason_when_sending_fails() {
        let mut actor = EffectActor::<OnboardEmailMachine>::default();
        actor.send(OnboardEmailEvent::EditEmail {
            email: "nope".to_string(),
        });
        actor.send(OnboardEmailEvent::Send);
        actor.send(OnboardEmailEvent::SendCodeError {
            error: "Enter a valid email address.".to_string(),
        });
        assert_eq!(*actor.state(), OnboardEmailState::Entering);
        assert_eq!(
            actor.context().error.as_deref(),
            Some("Enter a valid email address.")
        );
        assert_eq!(actor.context().email, "nope");
    }

    #[test]
    fn stays_on_the_code_with_the_reason_when_saving_fails_and_can_go_back() {
        let mut actor = EffectActor::<OnboardEmailMachine>::default();
        actor.send(OnboardEmailEvent::EditEmail {
            email: "me@example.com".to_string(),
        });
        actor.send(OnboardEmailEvent::Send);
        actor.send(OnboardEmailEvent::SendCodeDone {
            request_id: "req-1".to_string(),
            dev_code: None,
        });
        actor.send(OnboardEmailEvent::EditCode {
            code: "000000".to_string(),
        });
        actor.send(OnboardEmailEvent::Confirm);
        actor.send(OnboardEmailEvent::RegisterError {
            error: "That code is wrong.".to_string(),
        });
        assert_eq!(*actor.state(), OnboardEmailState::Code);
        assert_eq!(
            actor.context().error.as_deref(),
            Some("That code is wrong.")
        );

        actor.send(OnboardEmailEvent::Back);
        assert_eq!(*actor.state(), OnboardEmailState::Entering);
        assert_eq!(actor.context().email, "me@example.com");
        assert_eq!(actor.context().code, "");
        assert!(actor.context().request_id.is_none());
        assert!(actor.context().error.is_none());
    }

    #[test]
    fn keeps_only_digits_at_most_six() {
        assert_eq!(onboard_email_code("12-34 5678"), "123456");
    }
}
