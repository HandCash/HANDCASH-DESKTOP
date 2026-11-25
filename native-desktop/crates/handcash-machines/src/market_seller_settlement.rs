// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/marketSellerSettlementMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarketSellerSettlePath {
    Execute,
    Refuse { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketSellerSettlementState {
    Idle,
    Classifying,
    Validating,
    SigningSellerInputs,
    PeerDeliver,
    AwaitingBroadcast,
    InternalizingProceeds,
    RetiringItem,
    Recovery,
    Settled,
    Refused,
}

impl MarketSellerSettlementState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Classifying => "classifying",
            Self::Validating => "validating",
            Self::SigningSellerInputs => "signingSellerInputs",
            Self::PeerDeliver => "peerDeliver",
            Self::AwaitingBroadcast => "awaitingBroadcast",
            Self::InternalizingProceeds => "internalizingProceeds",
            Self::RetiringItem => "retiringItem",
            Self::Recovery => "recovery",
            Self::Settled => "settled",
            Self::Refused => "refused",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MarketSellerSettlementContext {
    pub listing_key: String,
    pub buyer_identity_key: String,
    pub path: Option<MarketSellerSettlePath>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarketSellerSettlementEvent {
    Start {
        listing_key: String,
        buyer_identity_key: String,
        path: MarketSellerSettlePath,
    },
    Validated,
    SellerInputsSigned,
    Delivered,
    BroadcastConfirmed,
    ProceedsInternalized,
    ItemRetired,
    Timeout,
    Duplicate,
    CompetingBuyer,
    Fail {
        error: String,
    },
    Reset,
}

pub struct MarketSellerSettlementMachine;

impl Statechart for MarketSellerSettlementMachine {
    type State = MarketSellerSettlementState;
    type Context = MarketSellerSettlementContext;
    type Event = MarketSellerSettlementEvent;
    type Input = ();

    const ID: &'static str = "marketSellerSettlement";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            MarketSellerSettlementState::Idle,
            MarketSellerSettlementContext::default(),
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

impl HandCashChart for MarketSellerSettlementMachine {
    const MANIFEST_ID: &'static str = "marketSellerSettlement";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "classifying",
        "validating",
        "signingSellerInputs",
        "peerDeliver",
        "awaitingBroadcast",
        "internalizingProceeds",
        "retiringItem",
        "recovery",
        "settled",
        "refused",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (
                MarketSellerSettlementState::Idle,
                MarketSellerSettlementEvent::Start {
                    listing_key,
                    buyer_identity_key,
                    path,
                },
            ) => {
                let refused = matches!(&path, MarketSellerSettlePath::Refuse { .. });
                ctx.listing_key = listing_key;
                ctx.buyer_identity_key = buyer_identity_key;
                ctx.error = match &path {
                    MarketSellerSettlePath::Refuse { reason } => Some(reason.clone()),
                    MarketSellerSettlePath::Execute => None,
                };
                ctx.path = Some(path);
                if refused {
                    MarketSellerSettlementState::Refused
                } else {
                    MarketSellerSettlementState::Validating
                }
            }
            (MarketSellerSettlementState::Validating, MarketSellerSettlementEvent::Validated) => {
                MarketSellerSettlementState::SigningSellerInputs
            }
            (MarketSellerSettlementState::Validating, MarketSellerSettlementEvent::Duplicate) => {
                ctx.error = Some("duplicate-request".to_string());
                MarketSellerSettlementState::Refused
            }
            (
                MarketSellerSettlementState::Validating,
                MarketSellerSettlementEvent::CompetingBuyer,
            ) => {
                ctx.error = Some("competing-buyer".to_string());
                MarketSellerSettlementState::Refused
            }
            (
                MarketSellerSettlementState::Validating
                | MarketSellerSettlementState::SigningSellerInputs
                | MarketSellerSettlementState::PeerDeliver
                | MarketSellerSettlementState::AwaitingBroadcast,
                MarketSellerSettlementEvent::Timeout,
            ) => {
                ctx.error = Some("timeout".to_string());
                MarketSellerSettlementState::Refused
            }
            (
                MarketSellerSettlementState::Validating
                | MarketSellerSettlementState::SigningSellerInputs
                | MarketSellerSettlementState::PeerDeliver
                | MarketSellerSettlementState::AwaitingBroadcast,
                MarketSellerSettlementEvent::Fail { error },
            ) => {
                ctx.error = Some(error);
                MarketSellerSettlementState::Refused
            }
            (
                MarketSellerSettlementState::SigningSellerInputs,
                MarketSellerSettlementEvent::SellerInputsSigned,
            ) => MarketSellerSettlementState::PeerDeliver,
            (MarketSellerSettlementState::PeerDeliver, MarketSellerSettlementEvent::Delivered) => {
                MarketSellerSettlementState::AwaitingBroadcast
            }
            (
                MarketSellerSettlementState::AwaitingBroadcast,
                MarketSellerSettlementEvent::BroadcastConfirmed,
            ) => MarketSellerSettlementState::InternalizingProceeds,
            (
                MarketSellerSettlementState::InternalizingProceeds,
                MarketSellerSettlementEvent::ProceedsInternalized,
            ) => MarketSellerSettlementState::RetiringItem,
            (
                MarketSellerSettlementState::InternalizingProceeds
                | MarketSellerSettlementState::RetiringItem,
                MarketSellerSettlementEvent::Fail { error },
            ) => {
                ctx.error = Some(error);
                MarketSellerSettlementState::Recovery
            }
            (MarketSellerSettlementState::RetiringItem, MarketSellerSettlementEvent::ItemRetired) => {
                MarketSellerSettlementState::Settled
            }
            (
                MarketSellerSettlementState::Recovery,
                MarketSellerSettlementEvent::BroadcastConfirmed,
            ) => MarketSellerSettlementState::InternalizingProceeds,
            (
                MarketSellerSettlementState::Recovery,
                MarketSellerSettlementEvent::ProceedsInternalized,
            ) => MarketSellerSettlementState::RetiringItem,
            (MarketSellerSettlementState::Recovery, MarketSellerSettlementEvent::ItemRetired) => {
                MarketSellerSettlementState::Settled
            }
            (MarketSellerSettlementState::Recovery, MarketSellerSettlementEvent::Fail { error }) => {
                ctx.error = Some(error);
                MarketSellerSettlementState::Recovery
            }
            (
                MarketSellerSettlementState::Settled | MarketSellerSettlementState::Refused,
                MarketSellerSettlementEvent::Reset,
            ) => {
                ctx = MarketSellerSettlementContext::default();
                MarketSellerSettlementState::Idle
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

pub fn seller_may_confirm_broadcast(
    snapshot: &Snapshot<MarketSellerSettlementState, MarketSellerSettlementContext>,
) -> bool {
    snapshot.value == MarketSellerSettlementState::AwaitingBroadcast
}
