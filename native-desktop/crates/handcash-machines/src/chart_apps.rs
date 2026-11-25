// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/chartAppsMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartAppsState {
    Start,
    List,
    Reviewing,
    Running,
    Closed,
}

impl ChartAppsState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::List => "list",
            Self::Reviewing => "reviewing",
            Self::Running => "running",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChartAppsInput {
    pub app_id: Option<String>,
    pub verified: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChartAppsContext {
    pub app_id: Option<String>,
    pub verified: bool,
    pub pinned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChartAppsEvent {
    Open { app_id: String, verified: bool },
    Run,
    Back,
}

pub struct ChartAppsMachine;

impl Statechart for ChartAppsMachine {
    type State = ChartAppsState;
    type Context = ChartAppsContext;
    type Event = ChartAppsEvent;
    type Input = ChartAppsInput;

    const ID: &'static str = "chartApps";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        let pinned = input.app_id.as_deref().is_some_and(|s| !s.is_empty());
        if pinned {
            Snapshot::new(
                ChartAppsState::Reviewing,
                ChartAppsContext {
                    app_id: input.app_id,
                    verified: input.verified,
                    pinned: true,
                },
            )
        } else {
            Snapshot::new(
                ChartAppsState::List,
                ChartAppsContext {
                    app_id: None,
                    verified: false,
                    pinned: false,
                },
            )
        }
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

impl HandCashChart for ChartAppsMachine {
    const MANIFEST_ID: &'static str = "chartApps";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["start", "list", "reviewing", "running", "closed"];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        *state == ChartAppsState::Closed
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (ChartAppsState::List, ChartAppsEvent::Open { app_id, verified }) => {
                ctx.app_id = Some(app_id);
                ctx.verified = verified;
                ChartAppsState::Reviewing
            }
            (ChartAppsState::Reviewing, ChartAppsEvent::Run) if ctx.verified => {
                ChartAppsState::Running
            }
            (ChartAppsState::Reviewing | ChartAppsState::Running, ChartAppsEvent::Back) => {
                if ctx.pinned {
                    ChartAppsState::Closed
                } else {
                    ctx.app_id = None;
                    ctx.verified = false;
                    ChartAppsState::List
                }
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
    fn shows_what_an_app_can_do_before_it_runs_then_runs_it() {
        let mut actor = EffectActor::<ChartAppsMachine>::default();
        actor.send(ChartAppsEvent::Run);
        assert_eq!(*actor.state(), ChartAppsState::List);
        actor.send(ChartAppsEvent::Open {
            app_id: "tip-jar".to_string(),
            verified: true,
        });
        assert_eq!(*actor.state(), ChartAppsState::Reviewing);
        actor.send(ChartAppsEvent::Run);
        assert_eq!(*actor.state(), ChartAppsState::Running);
        actor.send(ChartAppsEvent::Back);
        assert_eq!(*actor.state(), ChartAppsState::List);
        assert_eq!(actor.context().app_id, None);
    }

    #[test]
    fn never_runs_an_app_that_failed_verification() {
        let mut actor = EffectActor::<ChartAppsMachine>::default();
        actor.send(ChartAppsEvent::Open {
            app_id: "tampered".to_string(),
            verified: false,
        });
        actor.send(ChartAppsEvent::Run);
        assert_eq!(*actor.state(), ChartAppsState::Reviewing);
    }

    #[test]
    fn pinned_app_opens_directly_in_reviewing_and_closes_on_back() {
        let mut actor = EffectActor::<ChartAppsMachine>::new(ChartAppsInput {
            app_id: Some("tip-jar".to_string()),
            verified: true,
        });
        assert_eq!(*actor.state(), ChartAppsState::Reviewing);
        actor.send(ChartAppsEvent::Run);
        assert_eq!(*actor.state(), ChartAppsState::Running);
        actor.send(ChartAppsEvent::Back);
        assert_eq!(*actor.state(), ChartAppsState::Closed);
        assert!(actor.is_done());
    }
}
