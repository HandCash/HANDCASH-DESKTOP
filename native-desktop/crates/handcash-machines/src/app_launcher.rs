// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/appLauncherMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppLauncherState {
    Idle,
    Focused,
}

impl AppLauncherState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Focused => "focused",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppLauncherContext {
    pub focused: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppLauncherEvent {
    Tap { id: String },
    Dismiss,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppLauncherEffect {
    Launch { id: String },
}

pub struct AppLauncherMachine;

impl Statechart for AppLauncherMachine {
    type State = AppLauncherState;
    type Context = AppLauncherContext;
    type Event = AppLauncherEvent;
    type Input = ();

    const ID: &'static str = "appLauncher";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(AppLauncherState::Idle, AppLauncherContext::default())
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

impl HandCashChart for AppLauncherMachine {
    const MANIFEST_ID: &'static str = "appLauncher";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["idle", "focused"];
    type Effect = AppLauncherEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (AppLauncherState::Idle, AppLauncherEvent::Tap { id }) => {
                ctx.focused = Some(id);
                AppLauncherState::Focused
            }
            (AppLauncherState::Focused, AppLauncherEvent::Tap { id }) => {
                if ctx.focused.as_deref() == Some(id.as_str()) {
                    ctx.focused = None;
                    effects.push(AppLauncherEffect::Launch { id });
                    AppLauncherState::Idle
                } else {
                    ctx.focused = Some(id);
                    AppLauncherState::Focused
                }
            }
            (AppLauncherState::Focused, AppLauncherEvent::Dismiss) => {
                ctx.focused = None;
                AppLauncherState::Idle
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

    #[test]
    fn first_tap_shows_label_second_tap_on_same_tile_launches_it() {
        let mut actor = EffectActor::<AppLauncherMachine>::default();
        let e1 = actor.send(AppLauncherEvent::Tap {
            id: "native:notes".to_string(),
        });
        assert_eq!(*actor.state(), AppLauncherState::Focused);
        assert_eq!(actor.context().focused.as_deref(), Some("native:notes"));
        assert!(e1.is_empty());
        let e2 = actor.send(AppLauncherEvent::Tap {
            id: "native:notes".to_string(),
        });
        assert_eq!(
            e2,
            vec![AppLauncherEffect::Launch {
                id: "native:notes".to_string()
            }]
        );
        assert_eq!(*actor.state(), AppLauncherState::Idle);
        assert_eq!(actor.context().focused, None);
    }

    #[test]
    fn tapping_another_tile_moves_focus_without_launching_and_dismiss_clears() {
        let mut actor = EffectActor::<AppLauncherMachine>::default();
        actor.send(AppLauncherEvent::Tap {
            id: "a".to_string(),
        });
        actor.send(AppLauncherEvent::Tap {
            id: "b".to_string(),
        });
        assert_eq!(actor.context().focused.as_deref(), Some("b"));
        actor.send(AppLauncherEvent::Dismiss);
        assert_eq!(*actor.state(), AppLauncherState::Idle);
        assert!(actor.effects().is_empty());
    }
}
