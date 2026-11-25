// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/qrScannerMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QrScannerState {
    Loading,
    Ready,
    Paused,
    Error,
    Done,
}

impl QrScannerState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Paused => "paused",
            Self::Error => "error",
            Self::Done => "done",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QrScannerContext {
    pub error: Option<String>,
    pub session: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QrScannerEvent {
    CameraReady,
    Fail { error: String },
    Scanned,
    Pause,
    Resume,
}

pub struct QrScannerMachine;

impl Statechart for QrScannerMachine {
    type State = QrScannerState;
    type Context = QrScannerContext;
    type Event = QrScannerEvent;
    type Input = ();

    const ID: &'static str = "qrScanner";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(QrScannerState::Loading, QrScannerContext::default())
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

impl HandCashChart for QrScannerMachine {
    const MANIFEST_ID: &'static str = "qrScanner";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["loading", "ready", "paused", "error", "done"];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(state, QrScannerState::Done)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (QrScannerState::Loading, QrScannerEvent::CameraReady) => QrScannerState::Ready,
            (QrScannerState::Loading | QrScannerState::Ready, QrScannerEvent::Fail { error }) => {
                ctx.error = Some(error);
                QrScannerState::Error
            }
            (
                QrScannerState::Loading | QrScannerState::Ready | QrScannerState::Paused,
                QrScannerEvent::Scanned,
            ) => QrScannerState::Done,
            (QrScannerState::Loading | QrScannerState::Ready, QrScannerEvent::Pause) => {
                QrScannerState::Paused
            }
            (QrScannerState::Paused, QrScannerEvent::Resume) => {
                ctx.error = None;
                ctx.session += 1;
                QrScannerState::Loading
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
    fn shows_loading_until_the_camera_is_actually_playing() {
        let mut actor = EffectActor::<QrScannerMachine>::default();
        assert_eq!(*actor.state(), QrScannerState::Loading);
        actor.send(QrScannerEvent::CameraReady);
        assert_eq!(*actor.state(), QrScannerState::Ready);
    }

    #[test]
    fn projects_camera_failures_without_exposing_the_video() {
        let mut actor = EffectActor::<QrScannerMachine>::default();
        actor.send(QrScannerEvent::Fail {
            error: "Camera denied".to_string(),
        });
        assert_eq!(*actor.state(), QrScannerState::Error);
        assert_eq!(actor.context().error.as_deref(), Some("Camera denied"));
    }

    #[test]
    fn finishes_once_a_qr_is_handled() {
        let mut actor = EffectActor::<QrScannerMachine>::default();
        actor.send(QrScannerEvent::CameraReady);
        actor.send(QrScannerEvent::Scanned);
        assert!(actor.is_done());
    }

    #[test]
    fn restarts_camera_acquisition_after_app_resume() {
        let mut actor = EffectActor::<QrScannerMachine>::default();
        actor.send(QrScannerEvent::CameraReady);
        actor.send(QrScannerEvent::Pause);
        assert_eq!(*actor.state(), QrScannerState::Paused);
        actor.send(QrScannerEvent::Resume);
        assert_eq!(*actor.state(), QrScannerState::Loading);
        assert_eq!(actor.context().session, 1);
    }
}

