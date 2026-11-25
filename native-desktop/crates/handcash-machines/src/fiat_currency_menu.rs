// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/fiatCurrencyMenuMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FiatCurrencyMenuState {
    Closed,
    Open,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FiatCurrencyMenuContext;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FiatCurrencyMenuEvent {
    Toggle,
    Close,
    Choose { code: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FiatCurrencyMenuEffect {
    ApplyChoice { code: String },
}

pub struct FiatCurrencyMenuMachine;

impl Statechart for FiatCurrencyMenuMachine {
    type State = FiatCurrencyMenuState;
    type Context = FiatCurrencyMenuContext;
    type Event = FiatCurrencyMenuEvent;
    type Input = ();

    const ID: &'static str = "fiatCurrencyMenu";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(FiatCurrencyMenuState::Closed, FiatCurrencyMenuContext)
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            FiatCurrencyMenuState::Closed => StateValue::leaf("closed"),
            FiatCurrencyMenuState::Open => StateValue::leaf("open"),
        }
    }
}

impl HandCashChart for FiatCurrencyMenuMachine {
    const MANIFEST_ID: &'static str = "fiatCurrencyMenu";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["closed", "open"];
    type Effect = FiatCurrencyMenuEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        match (snapshot.value, event) {
            (FiatCurrencyMenuState::Closed, FiatCurrencyMenuEvent::Toggle) => (
                Snapshot::new(FiatCurrencyMenuState::Open, FiatCurrencyMenuContext),
                Vec::new(),
            ),
            (
                FiatCurrencyMenuState::Open,
                FiatCurrencyMenuEvent::Toggle | FiatCurrencyMenuEvent::Close,
            ) => (
                Snapshot::new(FiatCurrencyMenuState::Closed, FiatCurrencyMenuContext),
                Vec::new(),
            ),
            (FiatCurrencyMenuState::Open, FiatCurrencyMenuEvent::Choose { code }) => (
                Snapshot::new(FiatCurrencyMenuState::Closed, FiatCurrencyMenuContext),
                vec![FiatCurrencyMenuEffect::ApplyChoice { code }],
            ),
            _ => (snapshot.clone(), Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn toggles_open_and_closed() {
        let mut actor = EffectActor::<FiatCurrencyMenuMachine>::default();
        assert_eq!(actor.state_attr(), "closed");
        actor.send(FiatCurrencyMenuEvent::Toggle);
        assert_eq!(actor.state_attr(), "open");
        actor.send(FiatCurrencyMenuEvent::Close);
        assert_eq!(actor.state_attr(), "closed");
    }

    #[test]
    fn choosing_a_currency_applies_it_and_closes() {
        let mut actor = EffectActor::<FiatCurrencyMenuMachine>::default();
        actor.send(FiatCurrencyMenuEvent::Toggle);
        let effects = actor.send(FiatCurrencyMenuEvent::Choose {
            code: "eur".to_string(),
        });
        assert_eq!(
            effects,
            vec![FiatCurrencyMenuEffect::ApplyChoice {
                code: "eur".to_string()
            }]
        );
        assert_eq!(actor.state_attr(), "closed");
    }
}
