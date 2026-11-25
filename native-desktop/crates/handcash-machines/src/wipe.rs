// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/wipeMachine.ts` and `src/wallet/wipeHistoryGate.ts` pure helpers.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const WIPE_GATE_TTL_MS: u64 = 2 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WipeHistoryGateKind {
    BackupOff,
    NothingToLose,
    Synced,
    Overridden,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WipeHistoryGate {
    pub kind: WipeHistoryGateKind,
    pub checked_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WipeHistoryRefusal {
    Locked,
    CloudRicher { detail: String },
    UploadFailed { detail: String },
    Unconfirmed,
}

pub fn wipe_loss_warning(tokens: usize) -> String {
    let held = if tokens > 0 {
        let s = if tokens == 1 { "" } else { "s" };
        format!("{tokens} token{s} and any payments received peer to peer")
    } else {
        "Payments and tokens received peer to peer".to_string()
    };
    format!("{held} exist only on this device until history syncs. Your recovery phrase alone cannot bring them back.")
}

pub fn wipe_refusal_message(refusal: &WipeHistoryRefusal) -> String {
    match refusal {
        WipeHistoryRefusal::Locked => "Unlock the wallet to sync history first.".to_string(),
        WipeHistoryRefusal::CloudRicher { .. } => {
            "The cloud copy has history this device lacks. Restore from cloud in History backup, then wipe.".to_string()
        }
        WipeHistoryRefusal::UploadFailed { detail } => format!("History didn’t sync: {detail}"),
        WipeHistoryRefusal::Unconfirmed => {
            "The upload couldn’t be confirmed. Check the connection and try again.".to_string()
        }
    }
}

pub fn assert_wipe_gate_fresh(gate: Option<&WipeHistoryGate>, now: u64) -> Result<(), &'static str> {
    match gate {
        Some(g) if now.saturating_sub(g.checked_at) <= WIPE_GATE_TTL_MS => Ok(()),
        _ => Err("History backup must sync before this device is wiped"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WipeState {
    Idle,
    Syncing,
    Blocked,
    Wiping,
    Success,
    Failure,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WipeContext {
    pub password: String,
    pub unlocked: bool,
    pub confirm_text: String,
    pub error: Option<String>,
    pub gate: Option<WipeHistoryGate>,
    pub refusal: Option<WipeHistoryRefusal>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WipeEvent {
    ChangePassword { password: String },
    Verified { password: Option<String> },
    ChangeConfirm { confirm_text: String },
    Submit,
    Synced { gate: WipeHistoryGate },
    Blocked { reason: String, refusal: WipeHistoryRefusal },
    Override { gate: WipeHistoryGate },
    Back,
    Success,
    Fail { error: String },
    Retry,
}

pub struct WipeMachine;

impl Statechart for WipeMachine {
    type State = WipeState;
    type Context = WipeContext;
    type Event = WipeEvent;
    type Input = ();

    const ID: &'static str = "wipeWallet";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(WipeState::Idle, WipeContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            WipeState::Idle => StateValue::leaf("idle"),
            WipeState::Syncing => StateValue::leaf("syncing"),
            WipeState::Blocked => StateValue::leaf("blocked"),
            WipeState::Wiping => StateValue::leaf("wiping"),
            WipeState::Success => StateValue::leaf("success"),
            WipeState::Failure => StateValue::leaf("failure"),
        }
    }
}

impl HandCashChart for WipeMachine {
    const MANIFEST_ID: &'static str = "wipe";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "syncing",
        "blocked",
        "wiping",
        "success",
        "failure",
    ];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        *state == WipeState::Success
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next_state = match (snapshot.value, event) {
            (WipeState::Idle | WipeState::Failure, WipeEvent::ChangePassword { password }) => {
                ctx.password = password;
                ctx.unlocked = true;
                ctx.error = None;
                WipeState::Idle
            }
            (WipeState::Idle | WipeState::Failure, WipeEvent::Verified { password }) => {
                ctx.password = password.unwrap_or_default();
                ctx.unlocked = true;
                ctx.error = None;
                WipeState::Idle
            }
            (WipeState::Idle | WipeState::Failure, WipeEvent::ChangeConfirm { confirm_text }) => {
                ctx.confirm_text = confirm_text;
                ctx.error = None;
                WipeState::Idle
            }
            (WipeState::Idle, WipeEvent::Submit)
                if ctx.unlocked && ctx.confirm_text.trim().eq_ignore_ascii_case("DELETE") =>
            {
                ctx.gate = None;
                ctx.error = None;
                WipeState::Syncing
            }
            (WipeState::Syncing, WipeEvent::Synced { gate }) => {
                ctx.gate = Some(gate);
                WipeState::Wiping
            }
            (WipeState::Syncing, WipeEvent::Blocked { reason, refusal }) => {
                ctx.error = Some(reason);
                ctx.refusal = Some(refusal);
                WipeState::Blocked
            }
            (WipeState::Blocked, WipeEvent::Override { gate })
                if gate.kind == WipeHistoryGateKind::Overridden =>
            {
                ctx.gate = Some(gate);
                ctx.error = None;
                WipeState::Wiping
            }
            (WipeState::Blocked, WipeEvent::Retry) => {
                ctx.error = None;
                WipeState::Syncing
            }
            (WipeState::Blocked, WipeEvent::Back) => {
                ctx.error = None;
                WipeState::Idle
            }
            (WipeState::Wiping, WipeEvent::Success) => WipeState::Success,
            (WipeState::Wiping, WipeEvent::Fail { error }) => {
                ctx.error = Some(error);
                WipeState::Failure
            }
            (WipeState::Failure, WipeEvent::Retry) => {
                ctx.error = None;
                WipeState::Idle
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

    fn blocked() -> EffectActor<WipeMachine> {
        let mut actor = EffectActor::<WipeMachine>::default();
        actor.send(WipeEvent::Verified { password: None });
        actor.send(WipeEvent::ChangeConfirm {
            confirm_text: "delete".into(),
        });
        actor.send(WipeEvent::Submit);
        actor.send(WipeEvent::Blocked {
            reason: "History didn’t sync: Failed to fetch".into(),
            refusal: WipeHistoryRefusal::UploadFailed {
                detail: "Failed to fetch".into(),
            },
        });
        actor
    }

    #[test]
    fn keeps_the_refusal_when_the_history_gate_blocks() {
        let actor = blocked();
        assert_eq!(actor.state_attr(), "blocked");
        assert_eq!(
            actor.context().refusal,
            Some(WipeHistoryRefusal::UploadFailed {
                detail: "Failed to fetch".into()
            })
        );
    }

    #[test]
    fn wipes_from_blocked_only_with_an_overridden_gate() {
        let mut actor = blocked();
        actor.send(WipeEvent::Override {
            gate: WipeHistoryGate {
                kind: WipeHistoryGateKind::Synced,
                checked_at: 1000,
            },
        });
        assert_eq!(actor.state_attr(), "blocked");
        actor.send(WipeEvent::Override {
            gate: WipeHistoryGate {
                kind: WipeHistoryGateKind::Overridden,
                checked_at: 1000,
            },
        });
        assert_eq!(actor.state_attr(), "wiping");
        assert_eq!(
            actor.context().gate.map(|g| g.kind),
            Some(WipeHistoryGateKind::Overridden)
        );
    }

    #[test]
    fn ignores_override_outside_blocked() {
        let mut actor = EffectActor::<WipeMachine>::default();
        actor.send(WipeEvent::Override {
            gate: WipeHistoryGate {
                kind: WipeHistoryGateKind::Overridden,
                checked_at: 1000,
            },
        });
        assert_eq!(actor.state_attr(), "idle");
    }
}
