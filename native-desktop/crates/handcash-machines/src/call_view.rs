// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/callViewMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CallCorner {
    #[default]
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
}

impl CallCorner {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BottomRight => "bottom-right",
            Self::BottomLeft => "bottom-left",
            Self::TopRight => "top-right",
            Self::TopLeft => "top-left",
        }
    }
}

pub fn nearest_corner(x: f64, y: f64, width: f64, height: f64) -> CallCorner {
    match (y < height / 2.0, x < width / 2.0) {
        (true, true) => CallCorner::TopLeft,
        (true, false) => CallCorner::TopRight,
        (false, true) => CallCorner::BottomLeft,
        (false, false) => CallCorner::BottomRight,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallViewState {
    Stage,
    Pip,
    Popped,
}

impl CallViewState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stage => "stage",
            Self::Pip => "pip",
            Self::Popped => "popped",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallViewContext {
    pub corner: CallCorner,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallViewEvent {
    Shrink,
    Navigated,
    Expand,
    Move { corner: CallCorner },
    EnteredSystemPip,
    LeftSystemPip,
    Reset,
}

pub struct CallViewMachine;

impl Statechart for CallViewMachine {
    type State = CallViewState;
    type Context = CallViewContext;
    type Event = CallViewEvent;
    type Input = ();

    const ID: &'static str = "callView";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(CallViewState::Stage, CallViewContext::default())
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

impl HandCashChart for CallViewMachine {
    const MANIFEST_ID: &'static str = "callView";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["stage", "pip", "popped"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context;
        let next = match (snapshot.value, event) {
            (_, CallViewEvent::Reset) => CallViewState::Stage,
            (_, CallViewEvent::Move { corner }) => {
                ctx.corner = corner;
                snapshot.value
            }
            (CallViewState::Stage, CallViewEvent::Shrink | CallViewEvent::Navigated) => {
                CallViewState::Pip
            }
            (CallViewState::Stage | CallViewState::Pip, CallViewEvent::EnteredSystemPip) => {
                CallViewState::Popped
            }
            (CallViewState::Pip, CallViewEvent::Expand) => CallViewState::Stage,
            (CallViewState::Popped, CallViewEvent::LeftSystemPip) => CallViewState::Stage,
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
    fn moving_around_wallet_shrinks_call_to_pip_and_click_expands() {
        let mut a = EffectActor::<CallViewMachine>::default();
        assert_eq!(*a.state(), CallViewState::Stage);
        a.send(CallViewEvent::Navigated);
        assert_eq!(*a.state(), CallViewState::Pip);
        a.send(CallViewEvent::Navigated);
        assert_eq!(*a.state(), CallViewState::Pip);
        a.send(CallViewEvent::Expand);
        assert_eq!(*a.state(), CallViewState::Stage);
    }

    #[test]
    fn tile_keeps_corner_it_was_dragged_to_across_calls() {
        let mut a = EffectActor::<CallViewMachine>::default();
        a.send(CallViewEvent::Shrink);
        a.send(CallViewEvent::Move {
            corner: CallCorner::TopLeft,
        });
        a.send(CallViewEvent::Reset);
        assert_eq!(*a.state(), CallViewState::Stage);
        assert_eq!(a.context().corner, CallCorner::TopLeft);
    }

    #[test]
    fn system_window_takes_over_from_either_view_and_hands_back_to_stage() {
        let mut a = EffectActor::<CallViewMachine>::default();
        a.send(CallViewEvent::Shrink);
        a.send(CallViewEvent::EnteredSystemPip);
        assert_eq!(*a.state(), CallViewState::Popped);
        a.send(CallViewEvent::Navigated);
        assert_eq!(*a.state(), CallViewState::Popped);
        a.send(CallViewEvent::LeftSystemPip);
        assert_eq!(*a.state(), CallViewState::Stage);
        a.send(CallViewEvent::EnteredSystemPip);
        a.send(CallViewEvent::Reset);
        assert_eq!(*a.state(), CallViewState::Stage);
    }

    #[test]
    fn snaps_to_nearest_corner() {
        assert_eq!(nearest_corner(10.0, 10.0, 1000.0, 800.0), CallCorner::TopLeft);
        assert_eq!(nearest_corner(900.0, 10.0, 1000.0, 800.0), CallCorner::TopRight);
        assert_eq!(nearest_corner(10.0, 700.0, 1000.0, 800.0), CallCorner::BottomLeft);
        assert_eq!(nearest_corner(900.0, 700.0, 1000.0, 800.0), CallCorner::BottomRight);
    }
}
