// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/recordingPlayerMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenedRecording {
    pub meta: Option<String>,
    pub bytes: Vec<u8>,
    pub complete: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordingPlayerState {
    Opening,
    Ready,
    Deleting,
    Gone,
    Failed,
    Deleted,
}

impl RecordingPlayerState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Ready => "ready",
            Self::Deleting => "deleting",
            Self::Gone => "gone",
            Self::Failed => "failed",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecordingPlayerInput {
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecordingPlayerContext {
    pub id: String,
    pub opened: Option<OpenedRecording>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordingPlayerEvent {
    OpenDone { opened: Option<OpenedRecording> },
    OpenError,
    Delete,
    RemoveDone,
    RemoveError,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordingPlayerEffect {
    Remove { id: String },
}

pub struct RecordingPlayerMachine;

impl Statechart for RecordingPlayerMachine {
    type State = RecordingPlayerState;
    type Context = RecordingPlayerContext;
    type Event = RecordingPlayerEvent;
    type Input = RecordingPlayerInput;

    const ID: &'static str = "recordingPlayer";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            RecordingPlayerState::Opening,
            RecordingPlayerContext {
                id: input.id,
                opened: None,
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

impl HandCashChart for RecordingPlayerMachine {
    const MANIFEST_ID: &'static str = "recordingPlayer";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "opening",
        "ready",
        "deleting",
        "gone",
        "failed",
        "deleted",
    ];
    type Effect = RecordingPlayerEffect;

    fn is_done(state: &Self::State) -> bool {
        *state == RecordingPlayerState::Deleted
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (RecordingPlayerState::Opening, RecordingPlayerEvent::OpenDone { opened }) => {
                if let Some(recording) = opened {
                    ctx.opened = Some(recording);
                    RecordingPlayerState::Ready
                } else {
                    RecordingPlayerState::Gone
                }
            }
            (RecordingPlayerState::Opening, RecordingPlayerEvent::OpenError) => {
                RecordingPlayerState::Failed
            }
            (RecordingPlayerState::Ready, RecordingPlayerEvent::Delete) => {
                effects.push(RecordingPlayerEffect::Remove { id: ctx.id.clone() });
                RecordingPlayerState::Deleting
            }
            (RecordingPlayerState::Deleting, RecordingPlayerEvent::RemoveDone) => {
                ctx.opened = None;
                RecordingPlayerState::Deleted
            }
            (RecordingPlayerState::Deleting, RecordingPlayerEvent::RemoveError) => {
                RecordingPlayerState::Failed
            }
            _ => return (snapshot.clone(), effects),
        };
        (Snapshot::new(next, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn id() -> String {
        "a".repeat(32)
    }

    fn opened() -> OpenedRecording {
        OpenedRecording {
            meta: None,
            bytes: vec![1],
            complete: false,
        }
    }

    #[test]
    fn opens_a_recording_then_deletes_it() {
        let mut actor = EffectActor::<RecordingPlayerMachine>::new(RecordingPlayerInput {
            id: id(),
        });
        assert_eq!(*actor.state(), RecordingPlayerState::Opening);
        actor.send(RecordingPlayerEvent::OpenDone {
            opened: Some(opened()),
        });
        assert_eq!(*actor.state(), RecordingPlayerState::Ready);
        assert_eq!(actor.context().opened, Some(opened()));
        let effects = actor.send(RecordingPlayerEvent::Delete);
        assert_eq!(effects, vec![RecordingPlayerEffect::Remove { id: id() }]);
        actor.send(RecordingPlayerEvent::RemoveDone);
        assert_eq!(*actor.state(), RecordingPlayerState::Deleted);
        assert!(actor.is_done());
        assert_eq!(actor.context().opened, None);
    }

    #[test]
    fn says_when_recording_is_gone_or_failed_to_open_or_delete() {
        let mut gone = EffectActor::<RecordingPlayerMachine>::new(RecordingPlayerInput {
            id: id(),
        });
        gone.send(RecordingPlayerEvent::OpenDone { opened: None });
        assert_eq!(*gone.state(), RecordingPlayerState::Gone);

        let mut open_fail = EffectActor::<RecordingPlayerMachine>::new(RecordingPlayerInput {
            id: id(),
        });
        open_fail.send(RecordingPlayerEvent::OpenError);
        assert_eq!(*open_fail.state(), RecordingPlayerState::Failed);

        let mut del_fail = EffectActor::<RecordingPlayerMachine>::new(RecordingPlayerInput {
            id: id(),
        });
        del_fail.send(RecordingPlayerEvent::OpenDone {
            opened: Some(opened()),
        });
        del_fail.send(RecordingPlayerEvent::Delete);
        del_fail.send(RecordingPlayerEvent::RemoveError);
        assert_eq!(*del_fail.state(), RecordingPlayerState::Failed);
    }
}
