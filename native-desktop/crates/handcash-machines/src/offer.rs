// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/offerMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferVenue {
    Market,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferOperation {
    List,
    Cancel,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OfferPath {
    Execute,
    Refuse { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferState {
    Idle,
    Classifying,
    Staging,
    PreSignAbortable,
    SignedUnknown,
    Broadcast,
    Recovery,
    Committed,
    Failed,
}

impl OfferState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Classifying => "classifying",
            Self::Staging => "staging",
            Self::PreSignAbortable => "preSignAbortable",
            Self::SignedUnknown => "signedUnknown",
            Self::Broadcast => "broadcast",
            Self::Recovery => "recovery",
            Self::Committed => "committed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OfferContext {
    pub venue: Option<OfferVenue>,
    pub operation: Option<OfferOperation>,
    pub path: Option<OfferPath>,
    pub reference: Option<String>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OfferEvent {
    List { venue: OfferVenue, path: OfferPath },
    Cancel { venue: OfferVenue, path: OfferPath },
    Staged { reference: String },
    SignedUnknown,
    Broadcasted { txid: String },
    Committed,
    Recover,
    Aborted { error: String },
    Fail { error: String },
}

pub struct OfferMachine;

impl Statechart for OfferMachine {
    type State = OfferState;
    type Context = OfferContext;
    type Event = OfferEvent;
    type Input = ();

    const ID: &'static str = "offer";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(OfferState::Idle, OfferContext::default())
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

impl HandCashChart for OfferMachine {
    const MANIFEST_ID: &'static str = "offer";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "classifying",
        "staging",
        "preSignAbortable",
        "signedUnknown",
        "broadcast",
        "recovery",
        "committed",
        "failed",
    ];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(state, OfferState::Committed | OfferState::Failed)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (OfferState::Idle, OfferEvent::List { venue, path }) => {
                let refused = matches!(&path, OfferPath::Refuse { .. });
                ctx.venue = Some(venue);
                ctx.operation = Some(OfferOperation::List);
                ctx.error = match &path {
                    OfferPath::Refuse { reason } => Some(reason.clone()),
                    OfferPath::Execute => None,
                };
                ctx.path = Some(path);
                ctx.reference = None;
                ctx.txid = None;
                if refused {
                    OfferState::Failed
                } else {
                    OfferState::Staging
                }
            }
            (OfferState::Idle, OfferEvent::Cancel { venue, path }) => {
                let refused = matches!(&path, OfferPath::Refuse { .. });
                ctx.venue = Some(venue);
                ctx.operation = Some(OfferOperation::Cancel);
                ctx.error = match &path {
                    OfferPath::Refuse { reason } => Some(reason.clone()),
                    OfferPath::Execute => None,
                };
                ctx.path = Some(path);
                ctx.reference = None;
                ctx.txid = None;
                if refused {
                    OfferState::Failed
                } else {
                    OfferState::Staging
                }
            }
            (OfferState::Staging, OfferEvent::Staged { reference }) => {
                ctx.reference = Some(reference);
                OfferState::PreSignAbortable
            }
            (OfferState::Staging, OfferEvent::Fail { error }) => {
                ctx.error = Some(error);
                OfferState::Failed
            }
            (OfferState::PreSignAbortable, OfferEvent::SignedUnknown) => OfferState::SignedUnknown,
            (OfferState::PreSignAbortable, OfferEvent::Aborted { error }) => {
                ctx.error = Some(error);
                OfferState::Failed
            }
            (OfferState::SignedUnknown, OfferEvent::Broadcasted { txid }) => {
                ctx.txid = Some(txid);
                OfferState::Broadcast
            }
            (OfferState::SignedUnknown, OfferEvent::Aborted { error }) => {
                ctx.error = Some(error);
                OfferState::Failed
            }
            (OfferState::SignedUnknown, OfferEvent::Recover) => OfferState::Recovery,
            (OfferState::SignedUnknown, OfferEvent::Fail { error }) => {
                ctx.error = Some(error);
                OfferState::Recovery
            }
            (OfferState::Broadcast, OfferEvent::Committed) => OfferState::Committed,
            (OfferState::Broadcast, OfferEvent::Recover) => OfferState::Recovery,
            (OfferState::Broadcast, OfferEvent::Fail { error }) => {
                ctx.error = Some(error);
                OfferState::Broadcast
            }
            (OfferState::Recovery, OfferEvent::Broadcasted { txid }) => {
                ctx.txid = Some(txid);
                OfferState::Broadcast
            }
            (OfferState::Recovery, OfferEvent::Committed) => OfferState::Committed,
            (OfferState::Recovery, OfferEvent::Aborted { error }) => {
                ctx.error = Some(error);
                OfferState::Failed
            }
            (OfferState::Recovery, OfferEvent::Fail { error }) => {
                ctx.error = Some(error);
                OfferState::Recovery
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn may_abort_offer(snapshot: &Snapshot<OfferState, OfferContext>) -> bool {
    match snapshot.value {
        OfferState::PreSignAbortable | OfferState::SignedUnknown => true,
        OfferState::Recovery => !snapshot.context.txid.as_deref().is_some_and(is_hex64),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn allows_abort_before_broadcast_and_forbids_it_once_txid_is_known() {
        let mut actor = EffectActor::<OfferMachine>::default();
        actor.send(OfferEvent::List {
            venue: OfferVenue::Market,
            path: OfferPath::Execute,
        });
        assert_eq!(*actor.state(), OfferState::Staging);
        actor.send(OfferEvent::Staged {
            reference: "ref-1".to_string(),
        });
        assert!(may_abort_offer(actor.snapshot()));
        actor.send(OfferEvent::SignedUnknown);
        assert!(may_abort_offer(actor.snapshot()));
        actor.send(OfferEvent::Recover);
        assert!(may_abort_offer(actor.snapshot()));
        actor.send(OfferEvent::Broadcasted {
            txid: "a".repeat(64),
        });
        assert!(!may_abort_offer(actor.snapshot()));
        actor.send(OfferEvent::Recover);
        assert!(!may_abort_offer(actor.snapshot()));
        actor.send(OfferEvent::Committed);
        assert_eq!(*actor.state(), OfferState::Committed);
        assert!(actor.is_done());
    }

    #[test]
    fn fails_closed_on_refused_path() {
        let mut actor = EffectActor::<OfferMachine>::default();
        actor.send(OfferEvent::Cancel {
            venue: OfferVenue::Market,
            path: OfferPath::Refuse {
                reason: "not listed".to_string(),
            },
        });
        assert_eq!(*actor.state(), OfferState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("not listed"));
        assert!(actor.is_done());
    }
}
