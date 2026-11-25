// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/brc29SendMachine.ts` and `src/wallet/brc29SettlePath.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Brc29SettlePath {
    PeerDeliver { recipient_identity_key: String },
    SelfReceive,
}

pub fn is_valid_compressed_identity_key(key: &str) -> bool {
    key.len() == 66
        && (key.starts_with("02") || key.starts_with("03"))
        && key.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn choose_brc29_settle_path(
    payee_identity_key: &str,
    our_identity_key: Option<&str>,
) -> Result<Brc29SettlePath, &'static str> {
    let payee = payee_identity_key.trim().to_ascii_lowercase();
    let us = our_identity_key
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !us.is_empty() && payee == us {
        return Ok(Brc29SettlePath::SelfReceive);
    }
    if is_valid_compressed_identity_key(&payee) {
        return Ok(Brc29SettlePath::PeerDeliver {
            recipient_identity_key: payee,
        });
    }
    Err("Invalid payee identity key")
}

pub fn is_brc29_peer_deliver(path: Option<&Brc29SettlePath>) -> bool {
    matches!(path, Some(Brc29SettlePath::PeerDeliver { .. }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Brc29SendState {
    Idle,
    Preparing,
    Signing,
    ChooseSettle,
    PeerNotify,
    SelfReceive,
    Done,
    Failed,
}

impl Brc29SendState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::Signing => "signing",
            Self::ChooseSettle => "chooseSettle",
            Self::PeerNotify => "peerNotify",
            Self::SelfReceive => "selfReceive",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Brc29SendContext {
    pub payee: String,
    pub satoshis: u64,
    pub settle_path: Option<Brc29SettlePath>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Brc29SendEvent {
    Start {
        payee: String,
        satoshis: u64,
        settle_path: Brc29SettlePath,
    },
    Ready,
    Signed { txid: String },
    BeefInBox,
    RemitInBox,
    Direct,
    BoxUnreachable,
    Settled,
    Fail { error: String },
    Reset,
}

pub struct Brc29SendMachine;

impl Statechart for Brc29SendMachine {
    type State = Brc29SendState;
    type Context = Brc29SendContext;
    type Event = Brc29SendEvent;
    type Input = ();

    const ID: &'static str = "brc29Send";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(Brc29SendState::Idle, Brc29SendContext::default())
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

impl HandCashChart for Brc29SendMachine {
    const MANIFEST_ID: &'static str = "brc29Send";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "preparing",
        "signing",
        "chooseSettle",
        "peerNotify",
        "selfReceive",
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
                Brc29SendState::Idle,
                Brc29SendEvent::Start {
                    payee,
                    satoshis,
                    settle_path,
                },
            ) => {
                ctx.payee = payee;
                ctx.satoshis = satoshis;
                ctx.settle_path = Some(settle_path);
                ctx.txid = None;
                ctx.error = None;
                Brc29SendState::Preparing
            }
            (Brc29SendState::Preparing, Brc29SendEvent::Ready) => Brc29SendState::Signing,
            (Brc29SendState::Preparing, Brc29SendEvent::Fail { error }) => {
                ctx.error = Some(error);
                Brc29SendState::Failed
            }
            (Brc29SendState::Signing, Brc29SendEvent::Signed { txid }) => {
                ctx.txid = Some(txid);
                ctx.error = None;
                match ctx.settle_path {
                    Some(Brc29SettlePath::PeerDeliver { .. }) => Brc29SendState::PeerNotify,
                    Some(Brc29SettlePath::SelfReceive) => Brc29SendState::SelfReceive,
                    None => {
                        ctx.error = Some("BRC-29 settle path was not classified".to_string());
                        Brc29SendState::Failed
                    }
                }
            }
            (Brc29SendState::Signing, Brc29SendEvent::Fail { error }) => {
                ctx.error = Some(error);
                Brc29SendState::Failed
            }
            (
                Brc29SendState::PeerNotify,
                Brc29SendEvent::BeefInBox
                | Brc29SendEvent::RemitInBox
                | Brc29SendEvent::Direct
                | Brc29SendEvent::BoxUnreachable,
            ) => Brc29SendState::Done,
            (Brc29SendState::PeerNotify, Brc29SendEvent::Fail { error }) => {
                ctx.error = Some(error);
                Brc29SendState::Failed
            }
            (Brc29SendState::SelfReceive, Brc29SendEvent::Settled) => Brc29SendState::Done,
            (Brc29SendState::SelfReceive, Brc29SendEvent::Fail { error }) => {
                ctx.error = Some(error);
                Brc29SendState::Failed
            }
            (Brc29SendState::Done | Brc29SendState::Failed, Brc29SendEvent::Reset) => {
                ctx = Brc29SendContext::default();
                Brc29SendState::Idle
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

pub fn must_brc29_deliver_to_peer(snapshot: &Snapshot<Brc29SendState, Brc29SendContext>) -> bool {
    snapshot.value == Brc29SendState::PeerNotify
}

pub fn must_brc29_self_receive(snapshot: &Snapshot<Brc29SendState, Brc29SendContext>) -> bool {
    snapshot.value == Brc29SendState::SelfReceive
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    const PEER: &str = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    #[test]
    fn registers_the_signed_cheque_before_inbox_notify() {
        let mut actor = EffectActor::<Brc29SendMachine>::default();
        actor.send(Brc29SendEvent::Start {
            payee: PEER.to_string(),
            satoshis: 1000,
            settle_path: Brc29SettlePath::PeerDeliver {
                recipient_identity_key: PEER.to_string(),
            },
        });
        actor.send(Brc29SendEvent::Ready);
        assert_eq!(*actor.state(), Brc29SendState::Signing);
        assert!(!must_brc29_deliver_to_peer(actor.snapshot()));
        actor.send(Brc29SendEvent::Signed {
            txid: "a".repeat(64),
        });
        assert_eq!(*actor.state(), Brc29SendState::PeerNotify);
        assert!(must_brc29_deliver_to_peer(actor.snapshot()));
    }

    #[test]
    fn inbox_success_or_miss_both_finish_the_send_no_second_tx() {
        let mut actor = EffectActor::<Brc29SendMachine>::default();
        actor.send(Brc29SendEvent::Start {
            payee: PEER.to_string(),
            satoshis: 1000,
            settle_path: Brc29SettlePath::PeerDeliver {
                recipient_identity_key: PEER.to_string(),
            },
        });
        actor.send(Brc29SendEvent::Ready);
        actor.send(Brc29SendEvent::Signed {
            txid: "a".repeat(64),
        });
        actor.send(Brc29SendEvent::BoxUnreachable);
        assert_eq!(*actor.state(), Brc29SendState::Done);
    }

    #[test]
    fn beef_in_box_after_signing_reaches_done() {
        let mut actor = EffectActor::<Brc29SendMachine>::default();
        actor.send(Brc29SendEvent::Start {
            payee: PEER.to_string(),
            satoshis: 1000,
            settle_path: Brc29SettlePath::PeerDeliver {
                recipient_identity_key: PEER.to_string(),
            },
        });
        actor.send(Brc29SendEvent::Ready);
        actor.send(Brc29SendEvent::Signed {
            txid: "a".repeat(64),
        });
        actor.send(Brc29SendEvent::BeefInBox);
        assert_eq!(*actor.state(), Brc29SendState::Done);
    }

    #[test]
    fn self_receive_settles_locally_after_signing() {
        let mut actor = EffectActor::<Brc29SendMachine>::default();
        actor.send(Brc29SendEvent::Start {
            payee: PEER.to_string(),
            satoshis: 1000,
            settle_path: Brc29SettlePath::SelfReceive,
        });
        actor.send(Brc29SendEvent::Ready);
        actor.send(Brc29SendEvent::Signed {
            txid: "a".repeat(64),
        });
        assert_eq!(*actor.state(), Brc29SendState::SelfReceive);
        assert!(must_brc29_self_receive(actor.snapshot()));
        actor.send(Brc29SendEvent::Settled);
        assert_eq!(*actor.state(), Brc29SendState::Done);
    }
}
