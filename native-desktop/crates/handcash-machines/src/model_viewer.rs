// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/modelViewerMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelViewerState {
    Loading,
    Ready,
    Failed,
}

impl ModelViewerState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelViewerContext {
    pub attempt: u32,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelViewerEvent {
    Ready,
    Fail { error: String },
    Retry,
}

pub struct ModelViewerMachine;

impl Statechart for ModelViewerMachine {
    type State = ModelViewerState;
    type Context = ModelViewerContext;
    type Event = ModelViewerEvent;
    type Input = ();

    const ID: &'static str = "modelViewer";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(ModelViewerState::Loading, ModelViewerContext::default())
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

impl HandCashChart for ModelViewerMachine {
    const MANIFEST_ID: &'static str = "modelViewer";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["loading", "ready", "failed"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (ModelViewerState::Loading, ModelViewerEvent::Ready) => ModelViewerState::Ready,
            (ModelViewerState::Loading, ModelViewerEvent::Fail { error }) => {
                ctx.error = Some(error);
                ModelViewerState::Failed
            }
            (ModelViewerState::Failed, ModelViewerEvent::Retry) => {
                ctx.attempt += 1;
                ctx.error = None;
                ModelViewerState::Loading
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

    #[test]
    fn keeps_the_model_hidden_until_its_first_frame_is_ready() {
        let mut actor = EffectActor::<ModelViewerMachine>::default();
        assert_eq!(*actor.state(), ModelViewerState::Loading);
        actor.send(ModelViewerEvent::Ready);
        assert_eq!(*actor.state(), ModelViewerState::Ready);
    }

    #[test]
    fn names_a_failed_load_and_remounts_only_on_explicit_retry() {
        let mut actor = EffectActor::<ModelViewerMachine>::default();
        actor.send(ModelViewerEvent::Fail {
            error: "model fetch failed".to_string(),
        });
        assert_eq!(*actor.state(), ModelViewerState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("model fetch failed"));
        actor.send(ModelViewerEvent::Retry);
        assert_eq!(*actor.state(), ModelViewerState::Loading);
        assert_eq!(actor.context().attempt, 1);
        assert!(actor.context().error.is_none());
    }
}
