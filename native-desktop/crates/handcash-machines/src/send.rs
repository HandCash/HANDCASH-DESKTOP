// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/sendMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendAmountState {
    Idle,
    Checking,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendEditingState {
    Destination,
    Amount(SendAmountState),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendState {
    Editing(SendEditingState),
    Confirming,
    Handoff,
    Failure,
}

impl SendState {
    pub const fn is_editing(self) -> bool {
        matches!(self, Self::Editing(_))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendContext {
    pub to: String,
    pub amount: String,
    pub friend_label: Option<String>,
    pub payee_identity_key: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendEdit {
    pub to: Option<String>,
    pub amount: Option<String>,
    /// `None` = leave unchanged; `Some(None)` = clear to null; `Some(Some(v))` = set.
    pub friend_label: Option<Option<String>>,
    /// `None` = leave unchanged; `Some(None)` = clear to null; `Some(Some(v))` = set.
    pub payee_identity_key: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendEvent {
    Edit(SendEdit),
    Next,
    Check,
    Review,
    Refuse,
    Back,
    Confirm,
    Fail { error: String },
    Reset,
}

pub struct SendMachine;

impl SendMachine {
    fn has_recipient(ctx: &SendContext) -> bool {
        !ctx.to.trim().is_empty()
    }

    fn reviewable(ctx: &SendContext) -> bool {
        Self::has_recipient(ctx)
            && ctx
                .amount
                .trim()
                .parse::<f64>()
                .is_ok_and(|v| v > 0.0 && v.is_finite())
    }
}

impl Statechart for SendMachine {
    type State = SendState;
    type Context = SendContext;
    type Event = SendEvent;
    type Input = ();

    const ID: &'static str = "sendPayment";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            SendState::Editing(SendEditingState::Destination),
            SendContext::default(),
        )
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            SendState::Editing(SendEditingState::Destination) => {
                StateValue::compound("editing", StateValue::leaf("destination"))
            }
            SendState::Editing(SendEditingState::Amount(SendAmountState::Idle)) => {
                StateValue::compound(
                    "editing",
                    StateValue::compound("amount", StateValue::leaf("idle")),
                )
            }
            SendState::Editing(SendEditingState::Amount(SendAmountState::Checking)) => {
                StateValue::compound(
                    "editing",
                    StateValue::compound("amount", StateValue::leaf("checking")),
                )
            }
            SendState::Confirming => StateValue::leaf("confirming"),
            SendState::Handoff => StateValue::leaf("handoff"),
            SendState::Failure => StateValue::leaf("failure"),
        }
    }
}

impl HandCashChart for SendMachine {
    const MANIFEST_ID: &'static str = "send";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["editing", "confirming", "handoff", "failure"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next_state = match (snapshot.value, event) {
            (SendState::Editing(sub), SendEvent::Edit(edit)) => {
                if let Some(to) = edit.to {
                    ctx.to = to;
                }
                if let Some(amount) = edit.amount {
                    ctx.amount = amount;
                }
                if let Some(label) = edit.friend_label {
                    ctx.friend_label = label;
                }
                if let Some(key) = edit.payee_identity_key {
                    ctx.payee_identity_key = key;
                }
                ctx.error = None;
                SendState::Editing(sub)
            }
            (SendState::Editing(SendEditingState::Destination), SendEvent::Next)
                if Self::has_recipient(&ctx) =>
            {
                SendState::Editing(SendEditingState::Amount(SendAmountState::Idle))
            }
            (SendState::Editing(SendEditingState::Amount(SendAmountState::Idle)), SendEvent::Back) => {
                SendState::Editing(SendEditingState::Destination)
            }
            (SendState::Editing(SendEditingState::Amount(SendAmountState::Idle)), SendEvent::Check)
                if Self::reviewable(&ctx) =>
            {
                SendState::Editing(SendEditingState::Amount(SendAmountState::Checking))
            }
            (
                SendState::Editing(SendEditingState::Amount(SendAmountState::Idle)),
                SendEvent::Review,
            ) if Self::reviewable(&ctx) => SendState::Confirming,
            (
                SendState::Editing(SendEditingState::Amount(SendAmountState::Checking)),
                SendEvent::Review,
            ) => SendState::Confirming,
            (
                SendState::Editing(SendEditingState::Amount(SendAmountState::Checking)),
                SendEvent::Refuse,
            ) => SendState::Editing(SendEditingState::Amount(SendAmountState::Idle)),
            (SendState::Confirming, SendEvent::Back) => {
                SendState::Editing(SendEditingState::Amount(SendAmountState::Idle))
            }
            (SendState::Confirming, SendEvent::Confirm) => SendState::Handoff,
            (SendState::Confirming, SendEvent::Fail { error }) => {
                ctx.error = Some(error);
                SendState::Failure
            }
            (SendState::Handoff, SendEvent::Reset) => {
                ctx = SendContext::default();
                SendState::Editing(SendEditingState::Destination)
            }
            (SendState::Failure, SendEvent::Back) => {
                SendState::Editing(SendEditingState::Amount(SendAmountState::Idle))
            }
            (SendState::Failure, SendEvent::Reset) => {
                ctx.error = None;
                SendState::Editing(SendEditingState::Destination)
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next_state, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn drafted() -> EffectActor<SendMachine> {
        let mut actor = EffectActor::<SendMachine>::default();
        actor.send(SendEvent::Edit(SendEdit {
            to: Some("1BitcoinAddress".into()),
            amount: Some("0.5".into()),
            ..Default::default()
        }));
        actor
    }

    #[test]
    fn walks_destination_to_check_review_and_back_to_amount_idle() {
        let mut actor = drafted();
        actor.send(SendEvent::Next);
        actor.send(SendEvent::Check);
        assert_eq!(actor.state_attr(), "editing:amount:checking");
        actor.send(SendEvent::Review);
        assert_eq!(actor.state_attr(), "confirming");
        actor.send(SendEvent::Back);
        assert_eq!(actor.state_attr(), "editing:amount:idle");
    }

    #[test]
    fn starts_on_the_destination_step() {
        let actor = EffectActor::<SendMachine>::default();
        assert_eq!(actor.state_attr(), "editing:destination");
    }

    #[test]
    fn moves_from_destination_to_amount_only_with_a_recipient() {
        let mut empty = EffectActor::<SendMachine>::default();
        empty.send(SendEvent::Next);
        assert_eq!(empty.state_attr(), "editing:destination");

        let mut actor = drafted();
        actor.send(SendEvent::Next);
        assert_eq!(actor.state_attr(), "editing:amount:idle");
    }

    #[test]
    fn goes_back_from_amount_to_destination_and_keeps_the_draft() {
        let mut actor = drafted();
        actor.send(SendEvent::Next);
        actor.send(SendEvent::Back);
        assert_eq!(actor.state_attr(), "editing:destination");
        assert_eq!(actor.context().to, "1BitcoinAddress");
    }

    #[test]
    fn runs_pre_review_balance_check_as_a_phase_of_the_amount_step() {
        let mut actor = drafted();
        actor.send(SendEvent::Next);
        actor.send(SendEvent::Check);
        assert!(actor.state().is_editing());
        assert_eq!(actor.state_attr(), "editing:amount:checking");
        actor.send(SendEvent::Review);
        assert_eq!(actor.state_attr(), "confirming");
    }

    #[test]
    fn refuses_to_check_or_review_without_an_amount() {
        let mut actor = EffectActor::<SendMachine>::default();
        actor.send(SendEvent::Edit(SendEdit {
            to: Some("1BitcoinAddress".into()),
            ..Default::default()
        }));
        actor.send(SendEvent::Next);
        actor.send(SendEvent::Check);
        assert_eq!(actor.state_attr(), "editing:amount:idle");
        actor.send(SendEvent::Review);
        assert_eq!(actor.state_attr(), "editing:amount:idle");
    }

    #[test]
    fn ignores_a_second_check_while_one_is_in_flight() {
        let mut actor = drafted();
        actor.send(SendEvent::Next);
        actor.send(SendEvent::Check);
        actor.send(SendEvent::Check);
        assert_eq!(actor.state_attr(), "editing:amount:checking");
    }

    #[test]
    fn drops_a_refused_check_back_to_amount_idle_with_the_draft_intact() {
        let mut actor = drafted();
        actor.send(SendEvent::Next);
        actor.send(SendEvent::Check);
        actor.send(SendEvent::Refuse);
        assert_eq!(actor.state_attr(), "editing:amount:idle");
        assert_eq!(actor.context().to, "1BitcoinAddress");
        assert_eq!(actor.context().amount, "0.5");
    }

    #[test]
    fn still_lets_the_draft_change_while_checking() {
        let mut actor = drafted();
        actor.send(SendEvent::Next);
        actor.send(SendEvent::Check);
        actor.send(SendEvent::Edit(SendEdit {
            amount: Some("0.75".into()),
            ..Default::default()
        }));
        assert_eq!(actor.state_attr(), "editing:amount:checking");
        assert_eq!(actor.context().amount, "0.75");
    }
}
