// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/entryMeshMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const ENTRY_MESH_LAYER_COUNT: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryMeshState {
    Booting,
    Static,
    Playing,
    Paused,
}

impl EntryMeshState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Booting => "booting",
            Self::Static => "static",
            Self::Playing => "playing",
            Self::Paused => "paused",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryMeshContext {
    pub layer_count: u32,
}

impl Default for EntryMeshContext {
    fn default() -> Self {
        Self {
            layer_count: ENTRY_MESH_LAYER_COUNT,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryMeshEvent {
    BootStatic,
    BootPlay,
    Hide,
    Show,
    Reduce,
}

pub struct EntryMeshMachine;

impl Statechart for EntryMeshMachine {
    type State = EntryMeshState;
    type Context = EntryMeshContext;
    type Event = EntryMeshEvent;
    type Input = ();

    const ID: &'static str = "entryMesh";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(EntryMeshState::Booting, EntryMeshContext::default())
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

impl HandCashChart for EntryMeshMachine {
    const MANIFEST_ID: &'static str = "entryMesh";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["booting", "static", "playing", "paused"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let next = match (snapshot.value, event) {
            (EntryMeshState::Booting, EntryMeshEvent::BootStatic) => EntryMeshState::Static,
            (EntryMeshState::Booting, EntryMeshEvent::BootPlay) => EntryMeshState::Playing,
            (EntryMeshState::Playing, EntryMeshEvent::Hide) => EntryMeshState::Paused,
            (EntryMeshState::Playing, EntryMeshEvent::Reduce) => EntryMeshState::Static,
            (EntryMeshState::Paused, EntryMeshEvent::Show) => EntryMeshState::Playing,
            (EntryMeshState::Paused, EntryMeshEvent::Reduce) => EntryMeshState::Static,
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, snapshot.context.clone()), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn owns_a_single_mesh_plane_in_one_chart_context() {
        let actor = EffectActor::<EntryMeshMachine>::default();
        assert_eq!(actor.context().layer_count, ENTRY_MESH_LAYER_COUNT);
        assert_eq!(ENTRY_MESH_LAYER_COUNT, 1);
    }

    #[test]
    fn boots_into_static_when_reduced_motion_wins() {
        let mut actor = EffectActor::<EntryMeshMachine>::default();
        assert_eq!(*actor.state(), EntryMeshState::Booting);
        actor.send(EntryMeshEvent::BootStatic);
        assert_eq!(*actor.state(), EntryMeshState::Static);
        actor.send(EntryMeshEvent::Show);
        assert_eq!(*actor.state(), EntryMeshState::Static);
    }

    #[test]
    fn plays_pauses_off_screen_and_resumes() {
        let mut actor = EffectActor::<EntryMeshMachine>::default();
        actor.send(EntryMeshEvent::BootPlay);
        assert_eq!(*actor.state(), EntryMeshState::Playing);
        actor.send(EntryMeshEvent::Hide);
        assert_eq!(*actor.state(), EntryMeshState::Paused);
        actor.send(EntryMeshEvent::Show);
        assert_eq!(*actor.state(), EntryMeshState::Playing);
        actor.send(EntryMeshEvent::Reduce);
        assert_eq!(*actor.state(), EntryMeshState::Static);
    }
}
