// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/marketPurchaseMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarketPurchasePath {
    Execute,
    Refuse { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketPurchaseState {
    Idle,
    Classifying,
    Verifying,
    Reserving,
    PreSignAbortable,
    SellerSigned,
    SignedUnknown,
    Broadcast,
    Recovery,
    Aborting,
    Committed,
    Failed,
}

impl MarketPurchaseState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Classifying => "classifying",
            Self::Verifying => "verifying",
            Self::Reserving => "reserving",
            Self::PreSignAbortable => "preSignAbortable",
            Self::SellerSigned => "sellerSigned",
            Self::SignedUnknown => "signedUnknown",
            Self::Broadcast => "broadcast",
            Self::Recovery => "recovery",
            Self::Aborting => "aborting",
            Self::Committed => "committed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MarketPurchaseContext {
    pub listing_key: String,
    pub path: Option<MarketPurchasePath>,
    pub reference: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarketPurchaseEvent {
    Start {
        listing_key: String,
        path: MarketPurchasePath,
    },
    Verified,
    Reserved {
        reference: String,
    },
    SellerSigned,
    Signing,
    Broadcasted,
    Committed,
    Recover,
    Timeout,
    Duplicate,
    CompetingBuyer,
    Aborted,
    Fail {
        error: String,
    },
    Reset,
}

pub struct MarketPurchaseMachine;

impl Statechart for MarketPurchaseMachine {
    type State = MarketPurchaseState;
    type Context = MarketPurchaseContext;
    type Event = MarketPurchaseEvent;
    type Input = ();

    const ID: &'static str = "marketPurchase";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(MarketPurchaseState::Idle, MarketPurchaseContext::default())
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

impl HandCashChart for MarketPurchaseMachine {
    const MANIFEST_ID: &'static str = "marketPurchase";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "classifying",
        "verifying",
        "reserving",
        "preSignAbortable",
        "sellerSigned",
        "signedUnknown",
        "broadcast",
        "recovery",
        "aborting",
        "committed",
        "failed",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (MarketPurchaseState::Idle, MarketPurchaseEvent::Start { listing_key, path }) => {
                let refused = matches!(&path, MarketPurchasePath::Refuse { .. });
                ctx.listing_key = listing_key;
                ctx.reference = None;
                ctx.error = match &path {
                    MarketPurchasePath::Refuse { reason } => Some(reason.clone()),
                    MarketPurchasePath::Execute => None,
                };
                ctx.path = Some(path);
                if refused {
                    MarketPurchaseState::Failed
                } else {
                    MarketPurchaseState::Verifying
                }
            }
            (MarketPurchaseState::Verifying, MarketPurchaseEvent::Verified) => {
                MarketPurchaseState::Reserving
            }
            (MarketPurchaseState::Verifying, MarketPurchaseEvent::Fail { error }) => {
                ctx.error = Some(error);
                MarketPurchaseState::Failed
            }
            (MarketPurchaseState::Reserving, MarketPurchaseEvent::Reserved { reference }) => {
                ctx.reference = Some(reference);
                MarketPurchaseState::PreSignAbortable
            }
            (MarketPurchaseState::Reserving, MarketPurchaseEvent::Fail { error }) => {
                ctx.error = Some(error);
                MarketPurchaseState::Failed
            }
            (MarketPurchaseState::PreSignAbortable, MarketPurchaseEvent::SellerSigned) => {
                MarketPurchaseState::SellerSigned
            }
            (MarketPurchaseState::PreSignAbortable, MarketPurchaseEvent::Timeout) => {
                ctx.error = Some("timeout".to_string());
                MarketPurchaseState::Aborting
            }
            (MarketPurchaseState::PreSignAbortable, MarketPurchaseEvent::Duplicate) => {
                ctx.error = Some("duplicate-request".to_string());
                MarketPurchaseState::Aborting
            }
            (MarketPurchaseState::PreSignAbortable, MarketPurchaseEvent::CompetingBuyer) => {
                ctx.error = Some("competing-buyer".to_string());
                MarketPurchaseState::Aborting
            }
            (MarketPurchaseState::PreSignAbortable, MarketPurchaseEvent::Fail { error }) => {
                ctx.error = Some(error);
                MarketPurchaseState::Aborting
            }
            (MarketPurchaseState::SellerSigned, MarketPurchaseEvent::Signing) => {
                MarketPurchaseState::SignedUnknown
            }
            (MarketPurchaseState::SellerSigned, MarketPurchaseEvent::Timeout) => {
                ctx.error = Some("timeout".to_string());
                MarketPurchaseState::Aborting
            }
            (MarketPurchaseState::SellerSigned, MarketPurchaseEvent::Fail { error }) => {
                ctx.error = Some(error);
                MarketPurchaseState::Aborting
            }
            (MarketPurchaseState::SignedUnknown, MarketPurchaseEvent::Broadcasted) => {
                MarketPurchaseState::Broadcast
            }
            (MarketPurchaseState::SignedUnknown, MarketPurchaseEvent::Aborted) => {
                MarketPurchaseState::Failed
            }
            (MarketPurchaseState::SignedUnknown, MarketPurchaseEvent::Recover) => {
                MarketPurchaseState::Recovery
            }
            (MarketPurchaseState::SignedUnknown, MarketPurchaseEvent::Fail { error }) => {
                ctx.error = Some(error);
                MarketPurchaseState::Recovery
            }
            (MarketPurchaseState::Broadcast, MarketPurchaseEvent::Committed) => {
                MarketPurchaseState::Committed
            }
            (MarketPurchaseState::Broadcast, MarketPurchaseEvent::Recover) => {
                MarketPurchaseState::Recovery
            }
            (MarketPurchaseState::Recovery, MarketPurchaseEvent::Broadcasted) => {
                MarketPurchaseState::Broadcast
            }
            (MarketPurchaseState::Recovery, MarketPurchaseEvent::Committed) => {
                MarketPurchaseState::Committed
            }
            (MarketPurchaseState::Recovery, MarketPurchaseEvent::Aborted) => {
                MarketPurchaseState::Failed
            }
            (MarketPurchaseState::Recovery, MarketPurchaseEvent::Fail { error }) => {
                ctx.error = Some(error);
                MarketPurchaseState::Recovery
            }
            (MarketPurchaseState::Aborting, MarketPurchaseEvent::Aborted) => {
                MarketPurchaseState::Failed
            }
            (
                MarketPurchaseState::Committed | MarketPurchaseState::Failed,
                MarketPurchaseEvent::Reset,
            ) => {
                ctx = MarketPurchaseContext::default();
                MarketPurchaseState::Idle
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

pub fn may_abort_market_purchase(
    snapshot: &Snapshot<MarketPurchaseState, MarketPurchaseContext>,
) -> bool {
    matches!(
        snapshot.value,
        MarketPurchaseState::PreSignAbortable
            | MarketPurchaseState::SellerSigned
            | MarketPurchaseState::Aborting
            | MarketPurchaseState::SignedUnknown
            | MarketPurchaseState::Recovery
    )
}

pub fn must_abort_market_purchase(
    snapshot: &Snapshot<MarketPurchaseState, MarketPurchaseContext>,
) -> bool {
    snapshot.value == MarketPurchaseState::Aborting
}

pub fn may_broadcast_market_purchase(
    snapshot: &Snapshot<MarketPurchaseState, MarketPurchaseContext>,
) -> bool {
    snapshot.value == MarketPurchaseState::SignedUnknown
}
