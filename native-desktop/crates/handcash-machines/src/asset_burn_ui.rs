// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/assetBurnUiMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetBurnPreview {
    pub gross_sats: u64,
    pub protocol_output_sats: u64,
    pub estimated_fee_sats: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetBurnUiState {
    Closed,
    Editing,
    Confirming,
    Forgetting,
    Burning,
    Failure,
    Done,
}

impl AssetBurnUiState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Editing => "editing",
            Self::Confirming => "confirming",
            Self::Forgetting => "forgetting",
            Self::Burning => "burning",
            Self::Failure => "failure",
            Self::Done => "done",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssetBurnUiContext {
    pub error: Option<String>,
    pub txid: Option<String>,
    pub recovered_satoshis: u64,
    pub amount: String,
    pub preview: Option<AssetBurnPreview>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssetBurnUiEvent {
    Open { amount: Option<String> },
    SetAmount { amount: String },
    Preview { preview: Option<AssetBurnPreview> },
    Review,
    Back,
    Cancel,
    Confirm,
    Forget,
    Forgotten,
    Success { txid: String, recovered_satoshis: u64 },
    Fail { error: String },
    Reset,
}

pub struct AssetBurnUiMachine;

impl Statechart for AssetBurnUiMachine {
    type State = AssetBurnUiState;
    type Context = AssetBurnUiContext;
    type Event = AssetBurnUiEvent;
    type Input = ();

    const ID: &'static str = "assetBurn";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(AssetBurnUiState::Closed, AssetBurnUiContext::default())
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

impl HandCashChart for AssetBurnUiMachine {
    const MANIFEST_ID: &'static str = "assetBurnUi";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "closed",
        "editing",
        "confirming",
        "forgetting",
        "burning",
        "failure",
        "done",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (AssetBurnUiState::Closed, AssetBurnUiEvent::Open { amount }) => {
                ctx.amount = amount.unwrap_or_default();
                ctx.error = None;
                ctx.preview = None;
                AssetBurnUiState::Editing
            }
            (AssetBurnUiState::Editing, AssetBurnUiEvent::Cancel) => {
                ctx = AssetBurnUiContext::default();
                AssetBurnUiState::Closed
            }
            (AssetBurnUiState::Editing, AssetBurnUiEvent::SetAmount { amount }) => {
                ctx.amount = amount;
                ctx.error = None;
                ctx.preview = None;
                AssetBurnUiState::Editing
            }
            (AssetBurnUiState::Editing, AssetBurnUiEvent::Preview { preview }) => {
                ctx.preview = preview;
                AssetBurnUiState::Editing
            }
            (AssetBurnUiState::Editing, AssetBurnUiEvent::Review) => AssetBurnUiState::Confirming,
            (AssetBurnUiState::Editing, AssetBurnUiEvent::Fail { error }) => {
                ctx.error = Some(error);
                AssetBurnUiState::Failure
            }
            (AssetBurnUiState::Confirming, AssetBurnUiEvent::Back) => AssetBurnUiState::Editing,
            (AssetBurnUiState::Confirming, AssetBurnUiEvent::Cancel) => {
                ctx = AssetBurnUiContext::default();
                AssetBurnUiState::Closed
            }
            (AssetBurnUiState::Confirming, AssetBurnUiEvent::Forget) => {
                AssetBurnUiState::Forgetting
            }
            (AssetBurnUiState::Confirming, AssetBurnUiEvent::Preview { preview }) => {
                ctx.preview = preview;
                AssetBurnUiState::Confirming
            }
            (AssetBurnUiState::Confirming, AssetBurnUiEvent::Confirm) => AssetBurnUiState::Burning,
            (AssetBurnUiState::Confirming, AssetBurnUiEvent::Fail { error }) => {
                ctx.error = Some(error);
                AssetBurnUiState::Failure
            }
            (AssetBurnUiState::Forgetting, AssetBurnUiEvent::Forgotten) => {
                ctx = AssetBurnUiContext::default();
                AssetBurnUiState::Closed
            }
            (AssetBurnUiState::Forgetting, AssetBurnUiEvent::Fail { error }) => {
                ctx.error = Some(error);
                AssetBurnUiState::Failure
            }
            (
                AssetBurnUiState::Burning,
                AssetBurnUiEvent::Success {
                    txid,
                    recovered_satoshis,
                },
            ) => {
                ctx.error = None;
                ctx.txid = Some(txid);
                ctx.recovered_satoshis = recovered_satoshis;
                AssetBurnUiState::Done
            }
            (AssetBurnUiState::Burning, AssetBurnUiEvent::Fail { error }) => {
                ctx.error = Some(error);
                AssetBurnUiState::Failure
            }
            (AssetBurnUiState::Failure, AssetBurnUiEvent::Back) => {
                ctx.error = None;
                AssetBurnUiState::Editing
            }
            (AssetBurnUiState::Failure, AssetBurnUiEvent::SetAmount { amount }) => {
                ctx.amount = amount;
                ctx.error = None;
                ctx.preview = None;
                AssetBurnUiState::Failure
            }
            (AssetBurnUiState::Failure, AssetBurnUiEvent::Preview { preview }) => {
                ctx.preview = preview;
                AssetBurnUiState::Failure
            }
            (
                AssetBurnUiState::Failure,
                AssetBurnUiEvent::Cancel | AssetBurnUiEvent::Reset,
            ) => {
                ctx = AssetBurnUiContext::default();
                AssetBurnUiState::Closed
            }
            (AssetBurnUiState::Done, AssetBurnUiEvent::Reset) => {
                ctx = AssetBurnUiContext::default();
                AssetBurnUiState::Closed
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
    fn opens_on_editing_the_same_as_composing_a_payment() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open {
            amount: Some("5".to_string()),
        });
        assert_eq!(*actor.state(), AssetBurnUiState::Editing);
        assert_eq!(actor.context().amount, "5");
    }

    #[test]
    fn requires_review_then_an_explicit_confirm_before_burning() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open { amount: None });
        actor.send(AssetBurnUiEvent::Confirm);
        assert_eq!(*actor.state(), AssetBurnUiState::Editing);
        actor.send(AssetBurnUiEvent::Review);
        assert_eq!(*actor.state(), AssetBurnUiState::Confirming);
        actor.send(AssetBurnUiEvent::Confirm);
        assert_eq!(*actor.state(), AssetBurnUiState::Burning);
    }

    #[test]
    fn refuses_to_change_the_amount_once_it_is_being_confirmed() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open {
            amount: Some("5".to_string()),
        });
        actor.send(AssetBurnUiEvent::Review);
        actor.send(AssetBurnUiEvent::SetAmount {
            amount: "500".to_string(),
        });
        assert_eq!(actor.context().amount, "5");
        actor.send(AssetBurnUiEvent::Back);
        actor.send(AssetBurnUiEvent::SetAmount {
            amount: "500".to_string(),
        });
        assert_eq!(actor.context().amount, "500");
    }

    #[test]
    fn allows_a_reviewed_item_to_take_the_explicit_local_forget_path() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open { amount: None });
        actor.send(AssetBurnUiEvent::Review);
        actor.send(AssetBurnUiEvent::Forget);
        assert_eq!(*actor.state(), AssetBurnUiState::Forgetting);
        actor.send(AssetBurnUiEvent::Confirm);
        assert_eq!(*actor.state(), AssetBurnUiState::Forgetting);
        actor.send(AssetBurnUiEvent::Forgotten);
        assert_eq!(*actor.state(), AssetBurnUiState::Closed);
    }

    #[test]
    fn surfaces_a_failed_forget_as_a_failure_the_user_can_edit_out_of() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open { amount: None });
        actor.send(AssetBurnUiEvent::Review);
        actor.send(AssetBurnUiEvent::Forget);
        actor.send(AssetBurnUiEvent::Fail {
            error: "still referenced".to_string(),
        });
        assert_eq!(*actor.state(), AssetBurnUiState::Failure);
        assert_eq!(actor.context().error.as_deref(), Some("still referenced"));
    }

    #[test]
    fn sends_a_failure_back_to_editing_with_the_amount_intact() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open {
            amount: Some("5".to_string()),
        });
        actor.send(AssetBurnUiEvent::Review);
        actor.send(AssetBurnUiEvent::Confirm);
        actor.send(AssetBurnUiEvent::Fail {
            error: "broadcast rejected".to_string(),
        });
        assert_eq!(*actor.state(), AssetBurnUiState::Failure);
        assert_eq!(actor.context().error.as_deref(), Some("broadcast rejected"));
        actor.send(AssetBurnUiEvent::Back);
        assert_eq!(*actor.state(), AssetBurnUiState::Editing);
        assert!(actor.context().error.is_none());
        assert_eq!(actor.context().amount, "5");
    }

    #[test]
    fn cannot_burn_again_straight_from_a_failure() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open { amount: None });
        actor.send(AssetBurnUiEvent::Review);
        actor.send(AssetBurnUiEvent::Confirm);
        actor.send(AssetBurnUiEvent::Fail {
            error: "broadcast rejected".to_string(),
        });
        actor.send(AssetBurnUiEvent::Confirm);
        assert_eq!(*actor.state(), AssetBurnUiState::Failure);
    }

    #[test]
    fn stores_the_irreversible_result_until_reset() {
        let mut actor = EffectActor::<AssetBurnUiMachine>::default();
        actor.send(AssetBurnUiEvent::Open { amount: None });
        actor.send(AssetBurnUiEvent::Review);
        actor.send(AssetBurnUiEvent::Confirm);
        actor.send(AssetBurnUiEvent::Success {
            txid: "aa".repeat(32),
            recovered_satoshis: 4,
        });
        assert_eq!(*actor.state(), AssetBurnUiState::Done);
        assert_eq!(actor.context().recovered_satoshis, 4);
        actor.send(AssetBurnUiEvent::Reset);
        assert_eq!(*actor.state(), AssetBurnUiState::Closed);
        assert!(actor.context().txid.is_none());
    }
}
