// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/walletJobMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WalletJobKind {
    #[default]
    ItemImport,
    WalletSweep,
    BalanceHeal,
}

impl WalletJobKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ItemImport => "item-import",
            Self::WalletSweep => "wallet-sweep",
            Self::BalanceHeal => "balance-heal",
        }
    }
}

pub const JOB_GROUP_PREFIX: &str = "job:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalletJobState {
    Running,
    Waiting,
    Done,
    Stopped,
    Failed,
}

impl WalletJobState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalletJobInput {
    pub id: String,
    pub kind: WalletJobKind,
    pub identity_key: String,
    pub total: Option<u64>,
    pub detail: Option<String>,
    pub started_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalletJobContext {
    pub id: String,
    pub kind: WalletJobKind,
    pub identity_key: String,
    pub current: u64,
    pub total: Option<u64>,
    pub detail: Option<String>,
    pub started_at: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalletJobEvent {
    Progress {
        current: u64,
        total: Option<u64>,
        detail: Option<Option<String>>,
    },
    Wait {
        detail: String,
    },
    Resume,
    Finish {
        detail: Option<Option<String>>,
    },
    Stop {
        detail: Option<Option<String>>,
    },
    Fail {
        reason: String,
    },
}

fn normalize_detail(detail: Option<String>) -> Option<String> {
    detail.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

pub struct WalletJobMachine;

impl Statechart for WalletJobMachine {
    type State = WalletJobState;
    type Context = WalletJobContext;
    type Event = WalletJobEvent;
    type Input = WalletJobInput;

    const ID: &'static str = "walletJob";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            WalletJobState::Running,
            WalletJobContext {
                id: input.id,
                kind: input.kind,
                identity_key: input.identity_key,
                current: 0,
                total: input.total,
                detail: normalize_detail(input.detail),
                started_at: input.started_at,
                error: None,
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

impl HandCashChart for WalletJobMachine {
    const MANIFEST_ID: &'static str = "walletJob";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["running", "waiting", "done", "stopped", "failed"];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(
            state,
            WalletJobState::Done | WalletJobState::Stopped | WalletJobState::Failed
        )
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        if Self::is_done(&snapshot.value) {
            return (snapshot.clone(), Vec::new());
        }
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (
                WalletJobState::Running,
                WalletJobEvent::Progress {
                    current,
                    total,
                    detail,
                },
            ) => {
                ctx.current = current;
                ctx.total = total;
                if let Some(d) = detail {
                    ctx.detail = normalize_detail(d);
                }
                WalletJobState::Running
            }
            (WalletJobState::Running, WalletJobEvent::Wait { detail }) => {
                ctx.detail = normalize_detail(Some(detail));
                WalletJobState::Waiting
            }
            (WalletJobState::Waiting, WalletJobEvent::Resume) => WalletJobState::Running,
            (
                WalletJobState::Waiting,
                WalletJobEvent::Progress {
                    current,
                    total,
                    detail,
                },
            ) => {
                ctx.current = current;
                ctx.total = total;
                if let Some(d) = detail {
                    ctx.detail = normalize_detail(d);
                }
                WalletJobState::Running
            }
            (WalletJobState::Running | WalletJobState::Waiting, WalletJobEvent::Finish { detail }) => {
                if let Some(d) = detail {
                    ctx.detail = normalize_detail(d);
                }
                WalletJobState::Done
            }
            (WalletJobState::Running | WalletJobState::Waiting, WalletJobEvent::Stop { detail }) => {
                if let Some(d) = detail {
                    ctx.detail = normalize_detail(d);
                }
                WalletJobState::Stopped
            }
            (WalletJobState::Running | WalletJobState::Waiting, WalletJobEvent::Fail { reason }) => {
                ctx.error = Some(reason);
                WalletJobState::Failed
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WalletJobProgressBar {
    pub value: u64,
    pub max: u64,
}

pub fn wallet_job_progress(
    snapshot: &Snapshot<WalletJobState, WalletJobContext>,
) -> Option<WalletJobProgressBar> {
    let known = snapshot.context.total.filter(|&t| t > 0);
    if snapshot.value == WalletJobState::Done {
        return Some(match known {
            Some(total) => WalletJobProgressBar { value: total, max: total },
            None => WalletJobProgressBar { value: 1, max: 1 },
        });
    }
    let total = known?;
    Some(WalletJobProgressBar {
        value: snapshot.context.current.min(total),
        max: total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn tracks_progress_waits_resumes_and_completes_as_final() {
        let mut actor = EffectActor::<WalletJobMachine>::new(WalletJobInput {
            id: "job:1".to_string(),
            kind: WalletJobKind::ItemImport,
            identity_key: "02aa".to_string(),
            total: Some(10),
            detail: Some("  starting  ".to_string()),
            started_at: 100,
        });
        assert_eq!(*actor.state(), WalletJobState::Running);
        assert_eq!(actor.context().detail.as_deref(), Some("starting"));
        assert_eq!(
            wallet_job_progress(actor.snapshot()),
            Some(WalletJobProgressBar { value: 0, max: 10 })
        );

        actor.send(WalletJobEvent::Wait {
            detail: "fee clearing".to_string(),
        });
        assert_eq!(*actor.state(), WalletJobState::Waiting);
        actor.send(WalletJobEvent::Progress {
            current: 4,
            total: Some(10),
            detail: None,
        });
        assert_eq!(*actor.state(), WalletJobState::Running);
        assert_eq!(
            wallet_job_progress(actor.snapshot()),
            Some(WalletJobProgressBar { value: 4, max: 10 })
        );

        actor.send(WalletJobEvent::Finish { detail: None });
        assert_eq!(*actor.state(), WalletJobState::Done);
        assert!(actor.is_done());
        assert_eq!(
            wallet_job_progress(actor.snapshot()),
            Some(WalletJobProgressBar { value: 10, max: 10 })
        );
        // Final states ignore further events.
        actor.send(WalletJobEvent::Progress {
            current: 1,
            total: Some(10),
            detail: None,
        });
        assert_eq!(actor.context().current, 4);
    }
}
