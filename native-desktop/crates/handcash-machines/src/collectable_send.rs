// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/collectableSendMachine.ts` and tip classification helpers
//! from `src/wallet/collectableTipKind.ts`.

use crate::{EffectActor, HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TipKind {
    CovenantLocked { locking_script: String },
    P2pkh { locking_script: String },
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendPath {
    P2pkhSend,
    Refuse { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProvenTier {
    Brc150,
    Unproven,
}

const P2PKH_PREFIX: &str = "76a914";
const P2PKH_SUFFIX: &str = "88ac";

pub fn normalize_locking_script_hex(locking_script: &str) -> String {
    let trimmed = locking_script.trim();
    let stripped = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    stripped.to_string()
}

pub fn has_spendable_p2pkh_branch(script_hex: &str) -> bool {
    let script = script_hex.trim().to_ascii_lowercase();
    if script.is_empty()
        || !script.len().is_multiple_of(2)
        || !script.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return false;
    }
    let mut offset = 0;
    while let Some(pos) = script[offset..].find(P2PKH_PREFIX) {
        let idx = offset + pos;
        if idx + 50 > script.len() {
            break;
        }
        if idx.is_multiple_of(2) && script[idx + 46..].starts_with(P2PKH_SUFFIX) {
            return true;
        }
        offset = idx + 1;
    }
    false
}

pub fn classify_tip_kind(locking_script: Option<&str>) -> TipKind {
    let hex = locking_script
        .map(normalize_locking_script_hex)
        .unwrap_or_default();
    if hex.is_empty() {
        return TipKind::Unknown;
    }
    if has_spendable_p2pkh_branch(&hex) {
        return TipKind::P2pkh {
            locking_script: hex,
        };
    }
    if hex.len() >= 80 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return TipKind::CovenantLocked {
            locking_script: hex,
        };
    }
    TipKind::Unknown
}

pub fn is_covenant_locked_script(script_hex: Option<&str>) -> bool {
    matches!(classify_tip_kind(script_hex), TipKind::CovenantLocked { .. })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollectableSendState {
    Idle,
    Classifying,
    P2pkhSend,
    Refusing,
    Done,
    Failed,
}

impl CollectableSendState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Classifying => "classifying",
            Self::P2pkhSend => "p2pkhSend",
            Self::Refusing => "refusing",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CollectableSendContext {
    pub outpoint: String,
    pub send_path: Option<SendPath>,
    pub txid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CollectableSendEvent {
    Start { outpoint: String, send_path: SendPath },
    PathP2pkhSend,
    PathRefuse { reason: String },
    Success { txid: String },
    Fail { error: String },
    Reset,
}

pub struct CollectableSendMachine;

impl Statechart for CollectableSendMachine {
    type State = CollectableSendState;
    type Context = CollectableSendContext;
    type Event = CollectableSendEvent;
    type Input = ();

    const ID: &'static str = "collectableSend";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            CollectableSendState::Idle,
            CollectableSendContext::default(),
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

impl HandCashChart for CollectableSendMachine {
    const MANIFEST_ID: &'static str = "collectableSend";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "classifying",
        "p2pkhSend",
        "refusing",
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
                CollectableSendState::Idle,
                CollectableSendEvent::Start {
                    outpoint,
                    send_path,
                },
            ) => {
                ctx.outpoint = outpoint;
                ctx.send_path = Some(send_path);
                ctx.txid = None;
                ctx.error = None;
                match &ctx.send_path {
                    Some(SendPath::Refuse { reason }) => {
                        ctx.error = Some(reason.clone());
                        CollectableSendState::Failed
                    }
                    Some(SendPath::P2pkhSend) => CollectableSendState::P2pkhSend,
                    None => {
                        ctx.error = Some("Send path was not classified".to_string());
                        CollectableSendState::Failed
                    }
                }
            }
            (CollectableSendState::P2pkhSend, CollectableSendEvent::Success { txid }) => {
                ctx.txid = Some(txid);
                ctx.error = None;
                CollectableSendState::Done
            }
            (CollectableSendState::P2pkhSend, CollectableSendEvent::Fail { error }) => {
                ctx.error = Some(error);
                CollectableSendState::Failed
            }
            (
                CollectableSendState::Done | CollectableSendState::Failed,
                CollectableSendEvent::Reset,
            ) => {
                ctx = CollectableSendContext::default();
                CollectableSendState::Idle
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollectableSendVerdict {
    pub allowed: bool,
    pub error: Option<String>,
}

pub fn interpret_collectable_send_path(send_path: SendPath) -> CollectableSendVerdict {
    let mut actor = EffectActor::<CollectableSendMachine>::default();
    actor.send(CollectableSendEvent::Start {
        outpoint: "compose".to_string(),
        send_path,
    });
    if *actor.state() == CollectableSendState::P2pkhSend {
        CollectableSendVerdict {
            allowed: true,
            error: None,
        }
    } else {
        CollectableSendVerdict {
            allowed: false,
            error: actor.context().error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_p2pkh_send_and_succeeds() {
        let mut actor = EffectActor::<CollectableSendMachine>::default();
        actor.send(CollectableSendEvent::Start {
            outpoint: format!("{}.0", "a".repeat(64)),
            send_path: SendPath::P2pkhSend,
        });
        assert_eq!(*actor.state(), CollectableSendState::P2pkhSend);
        actor.send(CollectableSendEvent::Success {
            txid: "c".repeat(64),
        });
        assert_eq!(*actor.state(), CollectableSendState::Done);
        assert_eq!(actor.context().txid.as_deref(), Some("c".repeat(64).as_str()));
    }

    #[test]
    fn refuses_without_entering_p2pkh_send() {
        let mut actor = EffectActor::<CollectableSendMachine>::default();
        actor.send(CollectableSendEvent::Start {
            outpoint: format!("{}.0", "a".repeat(64)),
            send_path: SendPath::Refuse {
                reason: "This collectable is covenant-locked and can no longer be sent. Abandon it to remove it from inventory.".to_string(),
            },
        });
        assert_eq!(*actor.state(), CollectableSendState::Failed);
        assert!(actor
            .context()
            .error
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains("abandon"));
        assert_ne!(*actor.state(), CollectableSendState::P2pkhSend);
    }

    #[test]
    fn is_the_compose_panels_refuse_authority() {
        assert!(interpret_collectable_send_path(SendPath::P2pkhSend).allowed);
        assert!(!interpret_collectable_send_path(SendPath::Refuse {
            reason: "covenant".to_string(),
        })
        .allowed);
    }

    #[test]
    fn has_no_hardened_state() {
        assert!(!CollectableSendMachine::TOP_LEVEL_STATES.contains(&"hardened"));
    }
}
