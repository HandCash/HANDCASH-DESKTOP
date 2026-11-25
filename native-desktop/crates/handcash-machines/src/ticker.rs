// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/tickerMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickerState {
    Market,
    Choosing,
}

impl TickerState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Market => "market",
            Self::Choosing => "choosing",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TickerInput {
    pub compact_shell: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TickerContext {
    pub compact_shell: bool,
    pub coin: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TickerEvent {
    Choose,
    Pick { coin: String },
    Close,
    SetCompactShell { compact: bool },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TickerEffect {
    OpenInMain,
    SetTickerCoin { coin: String },
}

pub struct TickerMachine;

impl Statechart for TickerMachine {
    type State = TickerState;
    type Context = TickerContext;
    type Event = TickerEvent;
    type Input = TickerInput;

    const ID: &'static str = "ticker";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            TickerState::Market,
            TickerContext {
                compact_shell: input.compact_shell,
                coin: None,
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

impl HandCashChart for TickerMachine {
    const MANIFEST_ID: &'static str = "ticker";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["market", "choosing"];
    type Effect = TickerEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (_, TickerEvent::SetCompactShell { compact }) => {
                ctx.compact_shell = compact;
                snapshot.value
            }
            (TickerState::Market, TickerEvent::Choose) => {
                if !ctx.compact_shell {
                    TickerState::Choosing
                } else {
                    effects.push(TickerEffect::OpenInMain);
                    TickerState::Market
                }
            }
            (TickerState::Choosing, TickerEvent::Pick { coin }) => {
                ctx.coin = Some(coin.clone());
                effects.push(TickerEffect::SetTickerCoin { coin });
                TickerState::Market
            }
            (TickerState::Choosing, TickerEvent::Close) => TickerState::Market,
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
    fn chooses_in_the_side_column_and_sets_the_picked_coin() {
        let mut actor = EffectActor::<TickerMachine>::new(TickerInput {
            compact_shell: false,
        });
        actor.send(TickerEvent::Choose);
        assert_eq!(*actor.state(), TickerState::Choosing);
        let effects = actor.send(TickerEvent::Pick {
            coin: "ltc".to_string(),
        });
        assert_eq!(*actor.state(), TickerState::Market);
        assert_eq!(actor.context().coin.as_deref(), Some("ltc"));
        assert_eq!(
            effects,
            vec![TickerEffect::SetTickerCoin {
                coin: "ltc".to_string()
            }]
        );
    }

    #[test]
    fn opens_the_selector_in_the_main_section_on_a_compact_shell() {
        let mut actor = EffectActor::<TickerMachine>::new(TickerInput {
            compact_shell: true,
        });
        let effects = actor.send(TickerEvent::Choose);
        assert_eq!(*actor.state(), TickerState::Market);
        assert_eq!(effects, vec![TickerEffect::OpenInMain]);
    }
}
