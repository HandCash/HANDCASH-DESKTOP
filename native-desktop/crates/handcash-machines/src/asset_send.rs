// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/assetSendMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetSendState {
    Editing,
    Confirming,
    Handoff,
    Failure,
}

impl AssetSendState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Editing => "editing",
            Self::Confirming => "confirming",
            Self::Handoff => "handoff",
            Self::Failure => "failure",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssetSendInput {
    pub needs_quantity: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssetSendContext {
    pub to: String,
    pub quantity: String,
    pub needs_quantity: bool,
    pub friend_label: Option<String>,
    pub payee_identity_key: Option<String>,
    pub refuse_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssetSendEvent {
    Edit {
        to: Option<String>,
        quantity: Option<String>,
        friend_label: Option<Option<String>>,
        payee_identity_key: Option<Option<String>>,
    },
    Classify {
        refuse_reason: Option<String>,
    },
    Review,
    Back,
    Confirm,
    Fail {
        error: String,
    },
    Reset,
}

fn can_review(ctx: &AssetSendContext) -> bool {
    let not_refused = ctx
        .refuse_reason
        .as_deref()
        .is_none_or(|r| r.is_empty());
    let has_to = !ctx.to.trim().is_empty();
    let quantity_ok = !ctx.needs_quantity
        || ctx
            .quantity
            .trim()
            .parse::<f64>()
            .ok()
            .is_some_and(|n| n > 0.0);
    not_refused && has_to && quantity_ok
}

pub struct AssetSendMachine;

impl Statechart for AssetSendMachine {
    type State = AssetSendState;
    type Context = AssetSendContext;
    type Event = AssetSendEvent;
    type Input = AssetSendInput;

    const ID: &'static str = "assetSend";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            AssetSendState::Editing,
            AssetSendContext {
                needs_quantity: input.needs_quantity,
                ..AssetSendContext::default()
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

impl HandCashChart for AssetSendMachine {
    const MANIFEST_ID: &'static str = "assetSend";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["editing", "confirming", "handoff", "failure"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (
                AssetSendState::Editing,
                AssetSendEvent::Edit {
                    to,
                    quantity,
                    friend_label,
                    payee_identity_key,
                },
            ) => {
                if let Some(to) = to {
                    ctx.to = to;
                }
                if let Some(quantity) = quantity {
                    ctx.quantity = quantity;
                }
                if let Some(friend_label) = friend_label {
                    ctx.friend_label = friend_label;
                }
                if let Some(payee_identity_key) = payee_identity_key {
                    ctx.payee_identity_key = payee_identity_key;
                }
                ctx.error = None;
                AssetSendState::Editing
            }
            (AssetSendState::Editing, AssetSendEvent::Classify { refuse_reason }) => {
                ctx.refuse_reason = refuse_reason.clone();
                ctx.error = refuse_reason;
                AssetSendState::Editing
            }
            (AssetSendState::Editing, AssetSendEvent::Review) => {
                if !can_review(&ctx) {
                    return (snapshot.clone(), Vec::new());
                }
                AssetSendState::Confirming
            }
            (AssetSendState::Confirming, AssetSendEvent::Back) => AssetSendState::Editing,
            (AssetSendState::Confirming, AssetSendEvent::Classify { refuse_reason }) => {
                if refuse_reason.as_deref().is_some_and(|r| !r.is_empty()) {
                    ctx.refuse_reason = refuse_reason.clone();
                    ctx.error = refuse_reason;
                    AssetSendState::Failure
                } else {
                    ctx.refuse_reason = refuse_reason;
                    ctx.error = None;
                    AssetSendState::Confirming
                }
            }
            (AssetSendState::Confirming, AssetSendEvent::Confirm) => AssetSendState::Handoff,
            (AssetSendState::Confirming, AssetSendEvent::Fail { error }) => {
                ctx.error = Some(error);
                AssetSendState::Failure
            }
            (AssetSendState::Handoff, AssetSendEvent::Reset) => {
                let needs_quantity = ctx.needs_quantity;
                ctx = AssetSendContext {
                    needs_quantity,
                    ..AssetSendContext::default()
                };
                AssetSendState::Editing
            }
            (AssetSendState::Failure, AssetSendEvent::Back) => AssetSendState::Editing,
            (AssetSendState::Failure, AssetSendEvent::Reset) => {
                ctx.error = None;
                ctx.refuse_reason = None;
                AssetSendState::Editing
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
    fn reviews_a_collectable_send_from_a_recipient_without_inventing_an_amount() {
        let mut actor = EffectActor::<AssetSendMachine>::default();
        actor.send(AssetSendEvent::Edit {
            to: Some("1Addressxxxxxxxxxxxxxxxxx".to_string()),
            quantity: None,
            friend_label: None,
            payee_identity_key: None,
        });
        actor.send(AssetSendEvent::Review);
        assert_eq!(*actor.state(), AssetSendState::Confirming);
    }

    #[test]
    fn will_not_review_a_token_send_until_quantity_is_set() {
        let mut actor = EffectActor::<AssetSendMachine>::new(AssetSendInput {
            needs_quantity: true,
        });
        actor.send(AssetSendEvent::Edit {
            to: Some("1Addressxxxxxxxxxxxxxxxxx".to_string()),
            quantity: None,
            friend_label: None,
            payee_identity_key: None,
        });
        actor.send(AssetSendEvent::Review);
        assert_eq!(*actor.state(), AssetSendState::Editing);
        actor.send(AssetSendEvent::Edit {
            to: None,
            quantity: Some("2.5".to_string()),
            friend_label: None,
            payee_identity_key: None,
        });
        actor.send(AssetSendEvent::Review);
        assert_eq!(*actor.state(), AssetSendState::Confirming);
    }

    #[test]
    fn will_not_review_when_the_domain_send_chart_refused() {
        let mut actor = EffectActor::<AssetSendMachine>::default();
        actor.send(AssetSendEvent::Edit {
            to: Some("1Addressxxxxxxxxxxxxxxxxx".to_string()),
            quantity: None,
            friend_label: None,
            payee_identity_key: None,
        });
        actor.send(AssetSendEvent::Classify {
            refuse_reason: Some(
                "This collectable is covenant-locked and can no longer be sent.".to_string(),
            ),
        });
        actor.send(AssetSendEvent::Review);
        assert_eq!(*actor.state(), AssetSendState::Editing);
        assert!(actor
            .context()
            .refuse_reason
            .as_deref()
            .unwrap_or_default()
            .contains("covenant-locked"));
    }
}
