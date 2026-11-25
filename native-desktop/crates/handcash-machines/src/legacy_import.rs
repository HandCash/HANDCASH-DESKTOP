// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/legacyImportMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AwaitingImportState {
    Waiting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyImportSourceState {
    Viewing,
    AwaitingHints,
    Scanning,
    Browsing,
    Reviewing,
    Sweeping,
    ConfirmingRemove,
    Removing,
}

impl LegacyImportSourceState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Viewing => "viewing",
            Self::AwaitingHints => "awaitingHints",
            Self::Scanning => "scanning",
            Self::Browsing => "browsing",
            Self::Reviewing => "reviewing",
            Self::Sweeping => "sweeping",
            Self::ConfirmingRemove => "confirmingRemove",
            Self::Removing => "removing",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyImportState {
    Loading,
    List,
    Picking,
    Entering,
    Saving,
    AwaitingImport(AwaitingImportState),
    Source(LegacyImportSourceState),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyImportContext {
    pub kind: Option<String>,
    pub source_id: Option<String>,
    pub error: Option<String>,
    pub progress: Option<String>,
    pub percent: Option<u8>,
    pub stop_requested: bool,
    pub address_walk_available: bool,
    pub wait_started_at: u64,
}

impl LegacyImportContext {
    fn begin_work(&mut self) {
        self.progress = None;
        self.percent = None;
        self.stop_requested = false;
        self.error = None;
        self.address_walk_available = false;
    }

    fn end_work(&mut self) {
        self.progress = None;
        self.percent = None;
        self.stop_requested = false;
    }

    fn leave_source(&mut self) {
        self.source_id = None;
        self.kind = None;
        self.error = None;
        self.address_walk_available = false;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyImportEvent {
    Loaded,
    Add,
    Pick {
        kind: String,
    },
    Submit,
    Saved {
        source_id: String,
    },
    SignIn {
        now_ms: u64,
    },
    WaitTick {
        now_ms: u64,
    },
    Imported {
        source_id: String,
    },
    Open {
        source_id: String,
    },
    Rescan,
    WalkAddresses,
    AskHints,
    Hints,
    Scanned,
    Browse,
    Review,
    Confirm,
    Swept,
    Remove,
    Removed,
    Progress {
        message: String,
        percent: Option<u8>,
    },
    Pause,
    Fail {
        error: String,
        address_walk_available: bool,
    },
    Back,
}

pub struct LegacyImportMachine;

impl Statechart for LegacyImportMachine {
    type State = LegacyImportState;
    type Context = LegacyImportContext;
    type Event = LegacyImportEvent;
    type Input = ();

    const ID: &'static str = "legacyImport";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(LegacyImportState::Loading, LegacyImportContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            LegacyImportState::Loading => StateValue::leaf("loading"),
            LegacyImportState::List => StateValue::leaf("list"),
            LegacyImportState::Picking => StateValue::leaf("picking"),
            LegacyImportState::Entering => StateValue::leaf("entering"),
            LegacyImportState::Saving => StateValue::leaf("saving"),
            LegacyImportState::AwaitingImport(AwaitingImportState::Waiting) => {
                StateValue::compound("awaitingImport", StateValue::leaf("waiting"))
            }
            LegacyImportState::Source(sub) => {
                StateValue::compound("source", StateValue::leaf(sub.as_str()))
            }
        }
    }
}

impl HandCashChart for LegacyImportMachine {
    const MANIFEST_ID: &'static str = "legacyImport";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "loading",
        "list",
        "picking",
        "entering",
        "saving",
        "awaitingImport",
        "source",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        use LegacyImportEvent as E;
        use LegacyImportSourceState as Sub;
        use LegacyImportState as S;

        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (S::Loading, E::Loaded) => {
                ctx.leave_source();
                S::List
            }
            (
                S::Loading,
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.leave_source();
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::List
            }
            (S::List, E::Add) => S::Picking,
            (S::List, E::Pick { kind }) | (S::Picking, E::Pick { kind }) => {
                ctx.kind = Some(kind);
                ctx.error = None;
                S::Entering
            }
            (S::List, E::SignIn { now_ms })
            | (S::Picking, E::SignIn { now_ms })
            | (S::Entering, E::SignIn { now_ms }) => {
                ctx.begin_work();
                ctx.wait_started_at = now_ms;
                S::AwaitingImport(AwaitingImportState::Waiting)
            }
            (S::List, E::Imported { source_id })
            | (S::Picking, E::Imported { source_id })
            | (S::Entering, E::Imported { source_id })
            | (S::Source(Sub::Viewing), E::Imported { source_id })
            | (S::Source(Sub::AwaitingHints), E::Imported { source_id }) => {
                ctx.source_id = Some(source_id);
                ctx.begin_work();
                S::Source(Sub::Scanning)
            }
            (S::List, E::Open { source_id }) => {
                ctx.source_id = Some(source_id);
                ctx.error = None;
                ctx.address_walk_available = false;
                S::Source(Sub::Viewing)
            }
            (
                S::List,
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::List
            }
            (S::Picking, E::Back) => {
                ctx.leave_source();
                S::List
            }
            (S::Entering, E::Submit) => {
                ctx.error = None;
                S::Saving
            }
            (S::Entering, E::Back) => {
                ctx.error = None;
                S::Picking
            }
            (
                S::Entering,
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::Entering
            }
            (S::Saving, E::Saved { source_id }) => {
                ctx.source_id = Some(source_id);
                ctx.begin_work();
                S::Source(Sub::Scanning)
            }
            (
                S::Saving,
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::Entering
            }
            (S::AwaitingImport(AwaitingImportState::Waiting), E::WaitTick { now_ms }) => {
                let secs = (now_ms.saturating_sub(ctx.wait_started_at) / 1000).max(1);
                ctx.progress = Some(format!("Waiting for your browser · {secs}s"));
                S::AwaitingImport(AwaitingImportState::Waiting)
            }
            (S::AwaitingImport(_), E::Imported { source_id }) => {
                ctx.end_work();
                ctx.source_id = Some(source_id);
                ctx.begin_work();
                S::Source(Sub::Scanning)
            }
            (S::AwaitingImport(_), E::Back) => {
                ctx.end_work();
                ctx.leave_source();
                S::List
            }
            (
                S::AwaitingImport(_),
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.end_work();
                ctx.leave_source();
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::List
            }
            (S::Source(Sub::Viewing), E::Rescan) => {
                ctx.begin_work();
                S::Source(Sub::Scanning)
            }
            (S::Source(Sub::Viewing), E::WalkAddresses) if ctx.address_walk_available => {
                ctx.begin_work();
                S::Source(Sub::Scanning)
            }
            (S::Source(Sub::Viewing), E::AskHints) => {
                ctx.error = None;
                S::Source(Sub::AwaitingHints)
            }
            (S::Source(Sub::Viewing), E::Browse) => {
                ctx.error = None;
                S::Source(Sub::Browsing)
            }
            (S::Source(Sub::Viewing), E::Review) => {
                ctx.error = None;
                S::Source(Sub::Reviewing)
            }
            (S::Source(Sub::Viewing), E::Remove) => {
                ctx.error = None;
                S::Source(Sub::ConfirmingRemove)
            }
            (S::Source(Sub::Viewing), E::Back) => {
                ctx.leave_source();
                S::List
            }
            (S::Source(Sub::AwaitingHints), E::Hints) => {
                ctx.begin_work();
                S::Source(Sub::Scanning)
            }
            (
                S::Source(Sub::AwaitingHints),
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::Source(Sub::Viewing)
            }
            (S::Source(Sub::AwaitingHints), E::Back) => S::Source(Sub::Viewing),
            (S::Source(Sub::Scanning), E::Progress { message, percent }) => {
                ctx.progress = Some(message);
                ctx.percent = percent;
                S::Source(Sub::Scanning)
            }
            (S::Source(Sub::Scanning), E::Pause) => {
                ctx.stop_requested = true;
                S::Source(Sub::Scanning)
            }
            (S::Source(Sub::Scanning), E::Scanned) => {
                ctx.end_work();
                S::Source(Sub::Viewing)
            }
            (
                S::Source(Sub::Scanning),
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.end_work();
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::Source(Sub::Viewing)
            }
            (S::Source(Sub::Browsing), E::Back) => S::Source(Sub::Viewing),
            (S::Source(Sub::Reviewing), E::Confirm) => {
                ctx.begin_work();
                S::Source(Sub::Sweeping)
            }
            (S::Source(Sub::Reviewing), E::Back) => S::Source(Sub::Viewing),
            (S::Source(Sub::Sweeping), E::Progress { message, percent }) => {
                ctx.progress = Some(message);
                ctx.percent = percent;
                S::Source(Sub::Sweeping)
            }
            (S::Source(Sub::Sweeping), E::Pause) => {
                ctx.stop_requested = true;
                S::Source(Sub::Sweeping)
            }
            (S::Source(Sub::Sweeping), E::Swept) => {
                ctx.end_work();
                S::Source(Sub::Viewing)
            }
            (
                S::Source(Sub::Sweeping),
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.end_work();
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::Source(Sub::Viewing)
            }
            (S::Source(Sub::ConfirmingRemove), E::Confirm) => S::Source(Sub::Removing),
            (S::Source(Sub::ConfirmingRemove), E::Back) => S::Source(Sub::Viewing),
            (S::Source(Sub::Removing), E::Removed) => {
                ctx.leave_source();
                S::List
            }
            (
                S::Source(Sub::Removing),
                E::Fail {
                    error,
                    address_walk_available,
                },
            ) => {
                ctx.error = Some(error);
                ctx.address_walk_available = address_walk_available;
                S::Source(Sub::Viewing)
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

    fn run(events: Vec<LegacyImportEvent>) -> Snapshot<LegacyImportState, LegacyImportContext> {
        let mut actor = EffectActor::<LegacyImportMachine>::default();
        for ev in events {
            actor.send(ev);
        }
        actor.snapshot().clone()
    }

    #[test]
    fn all_encrypted_entry_routes_save_then_scan_never_confirm_sweep() {
        let entries: Vec<Vec<LegacyImportEvent>> = vec![
            vec![],
            vec![LegacyImportEvent::SignIn { now_ms: 1000 }],
            vec![LegacyImportEvent::Pick {
                kind: "handcash".to_string(),
            }],
            vec![LegacyImportEvent::Open {
                source_id: "prior".to_string(),
            }],
        ];
        for entry in entries {
            let mut evs = vec![LegacyImportEvent::Loaded];
            evs.extend(entry);
            evs.push(LegacyImportEvent::Imported {
                source_id: "received".to_string(),
            });
            evs.push(LegacyImportEvent::Confirm);
            let snap = run(evs);
            assert_eq!(
                snap.value,
                LegacyImportState::Source(LegacyImportSourceState::Scanning)
            );
            assert_eq!(snap.context.source_id.as_deref(), Some("received"));
        }
    }

    #[test]
    fn sign_in_can_be_cancelled_and_incoming_import_does_not_interrupt_sweep() {
        let cancelled = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::SignIn { now_ms: 1000 },
            LegacyImportEvent::Back,
        ]);
        assert_eq!(cancelled.value, LegacyImportState::List);

        let snap = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::Open {
                source_id: "current".to_string(),
            },
            LegacyImportEvent::Review,
            LegacyImportEvent::Confirm,
            LegacyImportEvent::Imported {
                source_id: "incoming".to_string(),
            },
        ]);
        assert_eq!(
            snap.value,
            LegacyImportState::Source(LegacyImportSourceState::Sweeping)
        );
        assert_eq!(snap.context.source_id.as_deref(), Some("current"));
    }

    #[test]
    fn saves_then_scans_new_source_and_never_sweeps_on_its_own() {
        let snap = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::Add,
            LegacyImportEvent::Pick {
                kind: "handcash".to_string(),
            },
            LegacyImportEvent::Submit,
            LegacyImportEvent::Saved {
                source_id: "s1".to_string(),
            },
        ]);
        assert_eq!(
            snap.value,
            LegacyImportState::Source(LegacyImportSourceState::Scanning)
        );
        assert_eq!(snap.context.kind.as_deref(), Some("handcash"));
        assert_eq!(snap.context.source_id.as_deref(), Some("s1"));

        let after = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::Add,
            LegacyImportEvent::Pick {
                kind: "handcash".to_string(),
            },
            LegacyImportEvent::Submit,
            LegacyImportEvent::Saved {
                source_id: "s1".to_string(),
            },
            LegacyImportEvent::Scanned,
        ]);
        assert_eq!(
            after.value,
            LegacyImportState::Source(LegacyImportSourceState::Viewing)
        );
    }

    #[test]
    fn opens_handcash_form_straight_from_list_for_key_recovery() {
        let snap = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::Pick {
                kind: "handcash".to_string(),
            },
        ]);
        assert_eq!(snap.value, LegacyImportState::Entering);
        assert_eq!(snap.context.kind.as_deref(), Some("handcash"));
        let back = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::Pick {
                kind: "handcash".to_string(),
            },
            LegacyImportEvent::Back,
        ]);
        assert_eq!(back.value, LegacyImportState::Picking);
    }

    #[test]
    fn waits_for_handcash_history_from_source_then_scans() {
        let opened = || {
            vec![
                LegacyImportEvent::Loaded,
                LegacyImportEvent::Open {
                    source_id: "s1".to_string(),
                },
            ]
        };
        let mut evs = opened();
        evs.push(LegacyImportEvent::AskHints);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::AwaitingHints)
        );

        let mut evs = opened();
        evs.extend([LegacyImportEvent::AskHints, LegacyImportEvent::Hints]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Scanning)
        );

        let mut evs = opened();
        evs.extend([LegacyImportEvent::AskHints, LegacyImportEvent::Back]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Viewing)
        );

        let mut evs = opened();
        evs.extend([
            LegacyImportEvent::AskHints,
            LegacyImportEvent::Fail {
                error: "other handle".to_string(),
                address_walk_available: false,
            },
        ]);
        let refused = run(evs);
        assert_eq!(
            refused.value,
            LegacyImportState::Source(LegacyImportSourceState::Viewing)
        );
        assert_eq!(refused.context.error.as_deref(), Some("other handle"));

        let mut evs = opened();
        evs.extend([LegacyImportEvent::AskHints, LegacyImportEvent::Confirm]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::AwaitingHints)
        );

        let mut evs = opened();
        evs.push(LegacyImportEvent::Hints);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Viewing)
        );
    }

    #[test]
    fn reaches_sweeping_only_through_review_and_confirm() {
        let opened = || {
            vec![
                LegacyImportEvent::Loaded,
                LegacyImportEvent::Open {
                    source_id: "s1".to_string(),
                },
            ]
        };
        let mut evs = opened();
        evs.push(LegacyImportEvent::Confirm);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Viewing)
        );

        let mut evs = opened();
        evs.extend([LegacyImportEvent::Rescan, LegacyImportEvent::Confirm]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Scanning)
        );

        let mut evs = opened();
        evs.extend([LegacyImportEvent::Review, LegacyImportEvent::Confirm]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Sweeping)
        );
    }

    #[test]
    fn browses_items_from_view_and_comes_back_never_reaching_sweeping() {
        let opened = || {
            vec![
                LegacyImportEvent::Loaded,
                LegacyImportEvent::Open {
                    source_id: "s1".to_string(),
                },
            ]
        };
        let mut evs = opened();
        evs.push(LegacyImportEvent::Browse);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Browsing)
        );
        let mut evs = opened();
        evs.extend([LegacyImportEvent::Browse, LegacyImportEvent::Confirm]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Browsing)
        );
        let mut evs = opened();
        evs.extend([LegacyImportEvent::Browse, LegacyImportEvent::Back]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Viewing)
        );
        let mut evs = opened();
        evs.extend([LegacyImportEvent::Rescan, LegacyImportEvent::Browse]);
        assert_eq!(
            run(evs).value,
            LegacyImportState::Source(LegacyImportSourceState::Scanning)
        );
    }

    #[test]
    fn pauses_long_work_cooperatively_and_clears_request_on_exit() {
        let sweeping = || {
            vec![
                LegacyImportEvent::Loaded,
                LegacyImportEvent::Open {
                    source_id: "s1".to_string(),
                },
                LegacyImportEvent::Review,
                LegacyImportEvent::Confirm,
                LegacyImportEvent::Progress {
                    message: "Moving…".to_string(),
                    percent: Some(40),
                },
                LegacyImportEvent::Pause,
            ]
        };
        let paused = run(sweeping());
        assert!(paused.context.stop_requested);
        assert_eq!(paused.context.progress.as_deref(), Some("Moving…"));
        assert_eq!(paused.context.percent, Some(40));

        let mut evs = sweeping();
        evs.push(LegacyImportEvent::Swept);
        let done = run(evs);
        assert_eq!(
            done.value,
            LegacyImportState::Source(LegacyImportSourceState::Viewing)
        );
        assert!(!done.context.stop_requested);
        assert_eq!(done.context.progress, None);
    }

    #[test]
    fn removes_only_after_its_own_confirm_and_keeps_save_failure_on_form() {
        let removed = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::Open {
                source_id: "s1".to_string(),
            },
            LegacyImportEvent::Remove,
            LegacyImportEvent::Confirm,
            LegacyImportEvent::Removed,
        ]);
        assert_eq!(removed.value, LegacyImportState::List);
        assert_eq!(removed.context.source_id, None);

        let failed = run(vec![
            LegacyImportEvent::Loaded,
            LegacyImportEvent::Add,
            LegacyImportEvent::Pick {
                kind: "phrase".to_string(),
            },
            LegacyImportEvent::Submit,
            LegacyImportEvent::Fail {
                error: "bad phrase".to_string(),
                address_walk_available: false,
            },
        ]);
        assert_eq!(failed.value, LegacyImportState::Entering);
        assert_eq!(failed.context.error.as_deref(), Some("bad phrase"));
    }
}
