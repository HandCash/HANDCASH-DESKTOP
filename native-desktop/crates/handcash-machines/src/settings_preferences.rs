// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/settingsPreferencesMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppearancePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsPreferences {
    pub appearance: AppearancePreference,
    pub sound: bool,
}

impl Default for SettingsPreferences {
    fn default() -> Self {
        Self {
            appearance: AppearancePreference::System,
            sound: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsPreferencePath {
    Appearance(AppearancePreference),
    Sound(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsPreferencesState {
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettingsPreferencesEvent {
    Choose(SettingsPreferencePath),
    Sync(SettingsPreferences),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsPreferencesEffect {
    PersistChoice(SettingsPreferencePath),
}

pub struct SettingsPreferencesMachine;

impl Statechart for SettingsPreferencesMachine {
    type State = SettingsPreferencesState;
    type Context = SettingsPreferences;
    type Event = SettingsPreferencesEvent;
    type Input = SettingsPreferences;

    const ID: &'static str = "settingsPreferences";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(SettingsPreferencesState::Ready, input)
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            SettingsPreferencesState::Ready => StateValue::leaf("ready"),
        }
    }
}

impl HandCashChart for SettingsPreferencesMachine {
    const MANIFEST_ID: &'static str = "settingsPreferences";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["ready"];
    type Effect = SettingsPreferencesEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut next = snapshot.context;
        match event {
            SettingsPreferencesEvent::Choose(path) => {
                match path {
                    SettingsPreferencePath::Appearance(value) => next.appearance = value,
                    SettingsPreferencePath::Sound(value) => next.sound = value,
                }
                (
                    Snapshot::new(SettingsPreferencesState::Ready, next),
                    vec![SettingsPreferencesEffect::PersistChoice(path)],
                )
            }
            SettingsPreferencesEvent::Sync(preferences) => (
                Snapshot::new(SettingsPreferencesState::Ready, preferences),
                Vec::new(),
            ),
        }
    }

    fn can(_snapshot: &Snapshot<Self::State, Self::Context>, _event: &Self::Event) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn persists_tagged_choices_and_projects_both_preferences_without_resetting_siblings() {
        let mut actor = EffectActor::<SettingsPreferencesMachine>::default();
        let e1 = actor.send(SettingsPreferencesEvent::Choose(
            SettingsPreferencePath::Appearance(AppearancePreference::Dark),
        ));
        assert_eq!(
            e1,
            vec![SettingsPreferencesEffect::PersistChoice(
                SettingsPreferencePath::Appearance(AppearancePreference::Dark)
            )]
        );
        let e2 = actor.send(SettingsPreferencesEvent::Choose(
            SettingsPreferencePath::Sound(false),
        ));
        assert_eq!(
            e2,
            vec![SettingsPreferencesEffect::PersistChoice(
                SettingsPreferencePath::Sound(false)
            )]
        );
        assert_eq!(
            *actor.context(),
            SettingsPreferences {
                appearance: AppearancePreference::Dark,
                sound: false,
            }
        );
        assert_eq!(actor.state_attr(), "ready");
    }

    #[test]
    fn reconciles_external_changes_without_writing_them_back() {
        let mut actor = EffectActor::<SettingsPreferencesMachine>::default();
        let effects = actor.send(SettingsPreferencesEvent::Sync(SettingsPreferences {
            appearance: AppearancePreference::Light,
            sound: false,
        }));
        assert_eq!(actor.context().appearance, AppearancePreference::Light);
        assert!(!actor.context().sound);
        assert!(effects.is_empty());
        assert!(actor.effects().is_empty());
    }
}
