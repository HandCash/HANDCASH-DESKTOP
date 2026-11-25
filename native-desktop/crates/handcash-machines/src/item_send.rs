// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/itemSendMachine.ts` and `src/wallet/itemSettlePath.ts`.

use crate::brc29_send::is_valid_compressed_identity_key;
use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalBroadcastReason {
    NoPeerIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemSettlePath {
    PeerDeliver { recipient_identity_key: String },
    SelfReceive,
    ExternalBroadcast { reason: ExternalBroadcastReason },
}

pub fn choose_item_settle_path(
    pays_our_address: bool,
    recipient_identity_key: Option<&str>,
) -> ItemSettlePath {
    if pays_our_address {
        return ItemSettlePath::SelfReceive;
    }
    let raw = recipient_identity_key.map(str::trim).unwrap_or_default();
    if !raw.is_empty() && is_valid_compressed_identity_key(raw) {
        return ItemSettlePath::PeerDeliver {
            recipient_identity_key: raw.to_ascii_lowercase(),
        };
    }
    ItemSettlePath::ExternalBroadcast {
        reason: ExternalBroadcastReason::NoPeerIdentity,
    }
}

pub fn is_peer_deliver_settle(path: Option<&ItemSettlePath>) -> bool {
    matches!(path, Some(ItemSettlePath::PeerDeliver { .. }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemSendState {
    Idle,
    Building,
    CreateAction,
    Signing,
    ChooseSettle,
    PeerDeliver,
    SelfReceive,
    ExternalBroadcast,
    ConfirmBroadcast,
    Done,
    Failed,
}

impl ItemSendState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Building => "building",
            Self::CreateAction => "createAction",
            Self::Signing => "signing",
            Self::ChooseSettle => "chooseSettle",
            Self::PeerDeliver => "peerDeliver",
            Self::SelfReceive => "selfReceive",
            Self::ExternalBroadcast => "externalBroadcast",
            Self::ConfirmBroadcast => "confirmBroadcast",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ItemSendContext {
    pub outpoint: String,
    pub settle_path: Option<ItemSettlePath>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemSendEvent {
    Start {
        outpoint: String,
        settle_path: ItemSettlePath,
    },
    RetryBroadcast {
        outpoint: String,
        txid: String,
    },
    Built,
    Created {
        txid: Option<String>,
    },
    Signed {
        txid: String,
    },
    Broadcasted,
    Skipped,
    Fail {
        error: String,
    },
    Reset,
}

pub struct ItemSendMachine;

impl Statechart for ItemSendMachine {
    type State = ItemSendState;
    type Context = ItemSendContext;
    type Event = ItemSendEvent;
    type Input = ();

    const ID: &'static str = "itemSend";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(ItemSendState::Idle, ItemSendContext::default())
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

fn resolve_choose_settle(ctx: &mut ItemSendContext) -> ItemSendState {
    match ctx.settle_path {
        Some(ItemSettlePath::PeerDeliver { .. }) => ItemSendState::PeerDeliver,
        Some(ItemSettlePath::SelfReceive) => ItemSendState::SelfReceive,
        Some(ItemSettlePath::ExternalBroadcast { .. }) => ItemSendState::ExternalBroadcast,
        None => {
            ctx.error = Some("Item settle path was not classified".to_string());
            ItemSendState::Failed
        }
    }
}

impl HandCashChart for ItemSendMachine {
    const MANIFEST_ID: &'static str = "itemSend";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "building",
        "createAction",
        "signing",
        "chooseSettle",
        "peerDeliver",
        "confirmBroadcast",
        "selfReceive",
        "externalBroadcast",
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
            (
                ItemSendState::Idle,
                ItemSendEvent::Start {
                    outpoint,
                    settle_path,
                },
            ) => {
                ctx.outpoint = outpoint;
                ctx.settle_path = Some(settle_path);
                ctx.txid = None;
                ctx.error = None;
                ItemSendState::Building
            }
            (ItemSendState::Idle, ItemSendEvent::RetryBroadcast { outpoint, txid }) => {
                ctx.outpoint = outpoint;
                ctx.settle_path = None;
                ctx.txid = Some(txid);
                ctx.error = None;
                ItemSendState::ConfirmBroadcast
            }
            (ItemSendState::Building, ItemSendEvent::Built) => ItemSendState::CreateAction,
            (ItemSendState::Building, ItemSendEvent::Fail { error }) => {
                ctx.error = Some(error);
                ItemSendState::Failed
            }
            (ItemSendState::CreateAction, ItemSendEvent::Created { txid }) => {
                if let Some(txid) = txid.filter(|t| !t.is_empty()) {
                    ctx.txid = Some(txid);
                    resolve_choose_settle(&mut ctx)
                } else {
                    ItemSendState::Signing
                }
            }
            (ItemSendState::CreateAction, ItemSendEvent::Fail { error }) => {
                ctx.error = Some(error);
                ItemSendState::Failed
            }
            (ItemSendState::Signing, ItemSendEvent::Signed { txid }) => {
                ctx.txid = Some(txid);
                resolve_choose_settle(&mut ctx)
            }
            (ItemSendState::Signing, ItemSendEvent::Fail { error }) => {
                ctx.error = Some(error);
                ItemSendState::Failed
            }
            (
                ItemSendState::PeerDeliver
                | ItemSendState::SelfReceive
                | ItemSendState::ExternalBroadcast,
                ItemSendEvent::Broadcasted,
            ) => ItemSendState::Done,
            (
                ItemSendState::ConfirmBroadcast,
                ItemSendEvent::Broadcasted | ItemSendEvent::Skipped,
            ) => ItemSendState::Done,
            (
                ItemSendState::PeerDeliver
                | ItemSendState::ConfirmBroadcast
                | ItemSendState::SelfReceive
                | ItemSendState::ExternalBroadcast,
                ItemSendEvent::Fail { error },
            ) => {
                ctx.error = Some(error);
                ItemSendState::Failed
            }
            (ItemSendState::Done | ItemSendState::Failed, ItemSendEvent::Reset) => {
                ctx = ItemSendContext::default();
                ItemSendState::Idle
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

pub fn may_sender_broadcast(snapshot: &Snapshot<ItemSendState, ItemSendContext>) -> bool {
    matches!(
        snapshot.value,
        ItemSendState::PeerDeliver
            | ItemSendState::SelfReceive
            | ItemSendState::ExternalBroadcast
            | ItemSendState::ConfirmBroadcast
    )
}

pub fn is_silent_sender_broadcast(snapshot: &Snapshot<ItemSendState, ItemSendContext>) -> bool {
    snapshot.value == ItemSendState::ConfirmBroadcast
}

pub fn must_deliver_to_peer(snapshot: &Snapshot<ItemSendState, ItemSendContext>) -> bool {
    snapshot.value == ItemSendState::PeerDeliver
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    const IDENTITY: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

    fn start(settle_path: ItemSettlePath) -> EffectActor<ItemSendMachine> {
        let mut actor = EffectActor::<ItemSendMachine>::default();
        actor.send(ItemSendEvent::Start {
            outpoint: format!("{}.0", "a".repeat(64)),
            settle_path,
        });
        actor.send(ItemSendEvent::Built);
        actor
    }

    #[test]
    fn peer_metadata_does_not_change_the_common_broadcast_rule() {
        let peer_settle = choose_item_settle_path(false, Some(IDENTITY));
        let mut actor = start(peer_settle);
        actor.send(ItemSendEvent::Created {
            txid: Some("b".repeat(64)),
        });
        assert_eq!(*actor.state(), ItemSendState::PeerDeliver);
        assert!(must_deliver_to_peer(actor.snapshot()));
        assert!(may_sender_broadcast(actor.snapshot()));
    }

    #[test]
    fn create_action_without_txid_requires_signing_before_settle() {
        let peer_settle = choose_item_settle_path(false, Some(IDENTITY));
        let mut actor = start(peer_settle);
        actor.send(ItemSendEvent::Created { txid: None });
        assert_eq!(*actor.state(), ItemSendState::Signing);
        actor.send(ItemSendEvent::Signed {
            txid: "c".repeat(64),
        });
        assert_eq!(*actor.state(), ItemSendState::PeerDeliver);
    }

    #[test]
    fn peer_transfer_completes_its_transaction_lifecycle_on_broadcasted() {
        let peer_settle = choose_item_settle_path(false, Some(IDENTITY));
        let mut actor = start(peer_settle);
        actor.send(ItemSendEvent::Created {
            txid: Some("b".repeat(64)),
        });
        actor.send(ItemSendEvent::Broadcasted);
        assert_eq!(*actor.state(), ItemSendState::Done);
    }

    #[test]
    fn retries_an_existing_signed_beef_through_confirm_broadcast() {
        let mut actor = EffectActor::<ItemSendMachine>::default();
        actor.send(ItemSendEvent::RetryBroadcast {
            outpoint: format!("{}.0", "a".repeat(64)),
            txid: "b".repeat(64),
        });
        assert_eq!(*actor.state(), ItemSendState::ConfirmBroadcast);
        assert!(may_sender_broadcast(actor.snapshot()));
        assert_eq!(actor.context().txid.as_deref(), Some("b".repeat(64).as_str()));
        actor.send(ItemSendEvent::Broadcasted);
        assert_eq!(*actor.state(), ItemSendState::Done);
    }

    #[test]
    fn self_receive_may_broadcast_immediately() {
        let self_settle = choose_item_settle_path(true, Some(IDENTITY));
        let mut actor = start(self_settle);
        actor.send(ItemSendEvent::Created {
            txid: Some("b".repeat(64)),
        });
        assert_eq!(*actor.state(), ItemSendState::SelfReceive);
        assert!(may_sender_broadcast(actor.snapshot()));
        assert!(!must_deliver_to_peer(actor.snapshot()));
        actor.send(ItemSendEvent::Broadcasted);
        assert_eq!(*actor.state(), ItemSendState::Done);
    }

    #[test]
    fn external_address_may_broadcast_no_identity_box() {
        let external_settle = choose_item_settle_path(false, None);
        let mut actor = start(external_settle);
        actor.send(ItemSendEvent::Created {
            txid: Some("b".repeat(64)),
        });
        assert_eq!(*actor.state(), ItemSendState::ExternalBroadcast);
        assert!(may_sender_broadcast(actor.snapshot()));
        actor.send(ItemSendEvent::Broadcasted);
        assert_eq!(*actor.state(), ItemSendState::Done);
    }

    #[test]
    fn fail_from_create_action_does_not_invent_another_path() {
        let peer_settle = choose_item_settle_path(false, Some(IDENTITY));
        let mut actor = start(peer_settle);
        actor.send(ItemSendEvent::Fail {
            error: "insufficient".to_string(),
        });
        assert_eq!(*actor.state(), ItemSendState::Failed);
        assert!(!may_sender_broadcast(actor.snapshot()));
    }
}
