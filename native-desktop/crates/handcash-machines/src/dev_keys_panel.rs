// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/devKeysPanelMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DevKeysPanelState {
    List,
    Funding,
}

impl DevKeysPanelState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Funding => "funding",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DevKeysPanelContext {
    pub fund_key: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DevKeysPanelEvent {
    Fund { n: u32 },
    Cancel,
    Done,
}

pub struct DevKeysPanelMachine;

impl Statechart for DevKeysPanelMachine {
    type State = DevKeysPanelState;
    type Context = DevKeysPanelContext;
    type Event = DevKeysPanelEvent;
    type Input = ();

    const ID: &'static str = "devKeysPanel";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(DevKeysPanelState::List, DevKeysPanelContext::default())
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

impl HandCashChart for DevKeysPanelMachine {
    const MANIFEST_ID: &'static str = "devKeysPanel";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["list", "funding"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context;
        let next = match (snapshot.value, event) {
            (DevKeysPanelState::List, DevKeysPanelEvent::Fund { n }) => {
                ctx.fund_key = Some(n);
                DevKeysPanelState::Funding
            }
            (
                DevKeysPanelState::Funding,
                DevKeysPanelEvent::Cancel | DevKeysPanelEvent::Done,
            ) => {
                ctx.fund_key = None;
                DevKeysPanelState::List
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
    fn toggles_between_list_and_funding_for_one_key() {
        let mut actor = EffectActor::<DevKeysPanelMachine>::default();
        assert_eq!(*actor.state(), DevKeysPanelState::List);
        actor.send(DevKeysPanelEvent::Fund { n: 2 });
        assert_eq!(*actor.state(), DevKeysPanelState::Funding);
        assert_eq!(actor.context().fund_key, Some(2));
        actor.send(DevKeysPanelEvent::Cancel);
        assert_eq!(*actor.state(), DevKeysPanelState::List);
        assert!(actor.context().fund_key.is_none());
        actor.send(DevKeysPanelEvent::Fund { n: 3 });
        actor.send(DevKeysPanelEvent::Done);
        assert_eq!(*actor.state(), DevKeysPanelState::List);
        assert!(actor.context().fund_key.is_none());
    }
}
