// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/historyRecoveryMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryRestoreStage {
    Download,
    Validate,
    Merge,
    Reboot,
    Recompose,
    Balance,
}

pub const HISTORY_RESTORE_STAGES: [HistoryRestoreStage; 6] = [
    HistoryRestoreStage::Download,
    HistoryRestoreStage::Validate,
    HistoryRestoreStage::Merge,
    HistoryRestoreStage::Reboot,
    HistoryRestoreStage::Recompose,
    HistoryRestoreStage::Balance,
];

impl HistoryRestoreStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Validate => "validate",
            Self::Merge => "merge",
            Self::Reboot => "reboot",
            Self::Recompose => "recompose",
            Self::Balance => "balance",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Validate => "Checking your backup before recovery",
            Self::Reboot => "Reopening the wallet",
            Self::Download => "Downloading your encrypted history",
            Self::Merge => "Restoring history into a separate ledger",
            Self::Recompose => "Rebuilding balances from the merged ledger",
            Self::Balance => "Reading your balance",
        }
    }

    pub const fn index(self) -> usize {
        match self {
            Self::Download => 0,
            Self::Validate => 1,
            Self::Merge => 2,
            Self::Reboot => 3,
            Self::Recompose => 4,
            Self::Balance => 5,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryRecoveryState {
    Probing,
    Found,
    Missing,
    Unreachable,
    Restoring(HistoryRestoreStage),
    Legacy,
    Failure,
    Done,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoryRecoveryContext {
    pub bytes: Option<u64>,
    pub error: Option<String>,
    pub balance_sats: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryRecoveryEvent {
    Found { bytes: Option<u64> },
    Missing,
    Unreachable { message: String },
    Restore,
    Stage { stage: HistoryRestoreStage },
    LegacyNeeded { message: String },
    Fail { message: String },
    Succeed { balance_sats: u64 },
}

pub struct HistoryRecoveryMachine;

impl Statechart for HistoryRecoveryMachine {
    type State = HistoryRecoveryState;
    type Context = HistoryRecoveryContext;
    type Event = HistoryRecoveryEvent;
    type Input = ();

    const ID: &'static str = "historyRecovery";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            HistoryRecoveryState::Probing,
            HistoryRecoveryContext::default(),
        )
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            HistoryRecoveryState::Probing => StateValue::leaf("probing"),
            HistoryRecoveryState::Found => StateValue::leaf("found"),
            HistoryRecoveryState::Missing => StateValue::leaf("missing"),
            HistoryRecoveryState::Unreachable => StateValue::leaf("unreachable"),
            HistoryRecoveryState::Restoring(stage) => {
                StateValue::compound("restoring", StateValue::leaf(stage.as_str()))
            }
            HistoryRecoveryState::Legacy => StateValue::leaf("legacy"),
            HistoryRecoveryState::Failure => StateValue::leaf("failure"),
            HistoryRecoveryState::Done => StateValue::leaf("done"),
        }
    }
}

impl HandCashChart for HistoryRecoveryMachine {
    const MANIFEST_ID: &'static str = "historyRecovery";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "probing",
        "found",
        "missing",
        "unreachable",
        "restoring",
        "legacy",
        "failure",
        "done",
    ];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(state, HistoryRecoveryState::Missing | HistoryRecoveryState::Done)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (HistoryRecoveryState::Probing, HistoryRecoveryEvent::Found { bytes }) => {
                ctx.bytes = bytes;
                ctx.error = None;
                HistoryRecoveryState::Found
            }
            (HistoryRecoveryState::Probing, HistoryRecoveryEvent::Missing) => {
                HistoryRecoveryState::Missing
            }
            (HistoryRecoveryState::Probing, HistoryRecoveryEvent::Unreachable { message }) => {
                ctx.error = Some(message);
                HistoryRecoveryState::Unreachable
            }
            (
                HistoryRecoveryState::Found
                | HistoryRecoveryState::Unreachable
                | HistoryRecoveryState::Legacy
                | HistoryRecoveryState::Failure,
                HistoryRecoveryEvent::Restore,
            ) => {
                ctx.error = None;
                HistoryRecoveryState::Restoring(HistoryRestoreStage::Download)
            }
            (HistoryRecoveryState::Restoring(_), HistoryRecoveryEvent::Stage { stage }) => {
                HistoryRecoveryState::Restoring(stage)
            }
            (
                HistoryRecoveryState::Restoring(_),
                HistoryRecoveryEvent::LegacyNeeded { message },
            ) => {
                ctx.error = Some(message);
                HistoryRecoveryState::Legacy
            }
            (HistoryRecoveryState::Restoring(_), HistoryRecoveryEvent::Fail { message }) => {
                ctx.error = Some(message);
                HistoryRecoveryState::Failure
            }
            (
                HistoryRecoveryState::Restoring(_),
                HistoryRecoveryEvent::Succeed { balance_sats },
            ) => {
                ctx.error = None;
                ctx.balance_sats = Some(balance_sats);
                HistoryRecoveryState::Done
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

pub fn history_restore_stage_index(
    snapshot: &Snapshot<HistoryRecoveryState, HistoryRecoveryContext>,
) -> Option<usize> {
    match snapshot.value {
        HistoryRecoveryState::Done => Some(HISTORY_RESTORE_STAGES.len()),
        HistoryRecoveryState::Restoring(stage) => Some(stage.index()),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HistoryRestoreProgress {
    pub value: f64,
    pub max: usize,
}

pub fn history_restore_progress(
    snapshot: &Snapshot<HistoryRecoveryState, HistoryRecoveryContext>,
) -> Option<HistoryRestoreProgress> {
    let index = history_restore_stage_index(snapshot)?;
    let max = HISTORY_RESTORE_STAGES.len();
    let value = if snapshot.value == HistoryRecoveryState::Done {
        max as f64
    } else {
        index as f64 + 0.5
    };
    Some(HistoryRestoreProgress { value, max })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryRestoreStageFace {
    Done,
    Active,
    Pending,
}

pub fn history_restore_stage_face(
    snapshot: &Snapshot<HistoryRecoveryState, HistoryRecoveryContext>,
    stage: HistoryRestoreStage,
) -> HistoryRestoreStageFace {
    let Some(active) = history_restore_stage_index(snapshot) else {
        return HistoryRestoreStageFace::Pending;
    };
    let index = stage.index();
    if index < active {
        HistoryRestoreStageFace::Done
    } else if index == active {
        HistoryRestoreStageFace::Active
    } else {
        HistoryRestoreStageFace::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn found_actor() -> EffectActor<HistoryRecoveryMachine> {
        let mut actor = EffectActor::<HistoryRecoveryMachine>::default();
        actor.send(HistoryRecoveryEvent::Found { bytes: Some(4096) });
        actor
    }

    #[test]
    fn starts_probing_and_shows_no_bar_until_a_restore_is_underway() {
        let actor = EffectActor::<HistoryRecoveryMachine>::default();
        assert_eq!(*actor.state(), HistoryRecoveryState::Probing);
        assert!(history_restore_progress(actor.snapshot()).is_none());
        assert_eq!(
            history_restore_stage_face(actor.snapshot(), HistoryRestoreStage::Download),
            HistoryRestoreStageFace::Pending
        );
    }

    #[test]
    fn classifies_the_probe_found_missing_unreachable() {
        let found = found_actor();
        assert_eq!(*found.state(), HistoryRecoveryState::Found);
        assert_eq!(found.context().bytes, Some(4096));

        let mut missing = EffectActor::<HistoryRecoveryMachine>::default();
        missing.send(HistoryRecoveryEvent::Missing);
        assert_eq!(*missing.state(), HistoryRecoveryState::Missing);
        assert!(missing.is_done());

        let mut unreachable = EffectActor::<HistoryRecoveryMachine>::default();
        unreachable.send(HistoryRecoveryEvent::Unreachable {
            message: "offline".to_string(),
        });
        assert_eq!(*unreachable.state(), HistoryRecoveryState::Unreachable);
        assert_eq!(unreachable.context().error.as_deref(), Some("offline"));
    }

    #[test]
    fn walks_the_stages_in_domain_order_and_projects_a_bar_that_moves_from_the_first_stage() {
        let mut actor = found_actor();
        actor.send(HistoryRecoveryEvent::Restore);
        assert_eq!(
            *actor.state(),
            HistoryRecoveryState::Restoring(HistoryRestoreStage::Download)
        );
        assert_eq!(
            history_restore_progress(actor.snapshot()),
            Some(HistoryRestoreProgress {
                value: 0.5,
                max: HISTORY_RESTORE_STAGES.len(),
            })
        );

        for (index, stage) in HISTORY_RESTORE_STAGES.iter().copied().enumerate() {
            actor.send(HistoryRecoveryEvent::Stage { stage });
            assert_eq!(*actor.state(), HistoryRecoveryState::Restoring(stage));
            assert_eq!(history_restore_stage_index(actor.snapshot()), Some(index));
            assert_eq!(
                history_restore_stage_face(actor.snapshot(), stage),
                HistoryRestoreStageFace::Active
            );
            if index > 0 {
                assert_eq!(
                    history_restore_stage_face(actor.snapshot(), HISTORY_RESTORE_STAGES[index - 1]),
                    HistoryRestoreStageFace::Done
                );
            }
            if index + 1 < HISTORY_RESTORE_STAGES.len() {
                assert_eq!(
                    history_restore_stage_face(actor.snapshot(), HISTORY_RESTORE_STAGES[index + 1]),
                    HistoryRestoreStageFace::Pending
                );
            }
        }

        actor.send(HistoryRecoveryEvent::Succeed { balance_sats: 1234 });
        assert_eq!(*actor.state(), HistoryRecoveryState::Done);
        assert!(actor.is_done());
        assert_eq!(actor.context().balance_sats, Some(1234));
        assert_eq!(
            history_restore_progress(actor.snapshot()),
            Some(HistoryRestoreProgress {
                value: HISTORY_RESTORE_STAGES.len() as f64,
                max: HISTORY_RESTORE_STAGES.len(),
            })
        );
        assert!(HISTORY_RESTORE_STAGES
            .iter()
            .all(|&s| history_restore_stage_face(actor.snapshot(), s) == HistoryRestoreStageFace::Done));
    }

    #[test]
    fn projects_nested_restoring_faces_as_a_flat_css_token() {
        let mut actor = found_actor();
        actor.send(HistoryRecoveryEvent::Restore);
        actor.send(HistoryRecoveryEvent::Stage {
            stage: HistoryRestoreStage::Merge,
        });
        assert_eq!(actor.state_attr(), "restoring:merge");
    }

    #[test]
    fn routes_an_old_password_refusal_to_legacy_and_lets_one_retry_restart_the_stages() {
        let mut actor = found_actor();
        actor.send(HistoryRecoveryEvent::Restore);
        actor.send(HistoryRecoveryEvent::Stage {
            stage: HistoryRestoreStage::Merge,
        });
        actor.send(HistoryRecoveryEvent::LegacyNeeded {
            message: "older unlock password".to_string(),
        });
        assert_eq!(*actor.state(), HistoryRecoveryState::Legacy);
        assert_eq!(
            actor.context().error.as_deref(),
            Some("older unlock password")
        );
        assert!(history_restore_progress(actor.snapshot()).is_none());

        actor.send(HistoryRecoveryEvent::Restore);
        assert_eq!(
            *actor.state(),
            HistoryRecoveryState::Restoring(HistoryRestoreStage::Download)
        );
        assert!(actor.context().error.is_none());
    }

    #[test]
    fn keeps_any_other_refusal_in_failure_with_the_message_and_allows_retry() {
        let mut actor = found_actor();
        actor.send(HistoryRecoveryEvent::Restore);
        actor.send(HistoryRecoveryEvent::Fail {
            message: "network down".to_string(),
        });
        assert_eq!(*actor.state(), HistoryRecoveryState::Failure);
        assert_eq!(actor.context().error.as_deref(), Some("network down"));
        actor.send(HistoryRecoveryEvent::Restore);
        assert!(matches!(*actor.state(), HistoryRecoveryState::Restoring(_)));
    }

    #[test]
    fn ignores_stage_reports_outside_of_restoring_and_restore_while_probing() {
        let mut actor = EffectActor::<HistoryRecoveryMachine>::default();
        actor.send(HistoryRecoveryEvent::Stage {
            stage: HistoryRestoreStage::Merge,
        });
        actor.send(HistoryRecoveryEvent::Restore);
        assert_eq!(*actor.state(), HistoryRecoveryState::Probing);
    }

    #[test]
    fn labels_every_stage() {
        for stage in HISTORY_RESTORE_STAGES {
            assert!(!stage.label().is_empty());
        }
    }
}
