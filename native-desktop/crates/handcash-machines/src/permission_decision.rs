// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/permissionDecisionMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionDecisionState {
    Pending,
    Committing,
}

impl PermissionDecisionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Committing => "committing",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionDecisionEvent {
    Reset,
    Approve,
    Cancel,
}

pub struct PermissionDecisionMachine;

impl Statechart for PermissionDecisionMachine {
    type State = PermissionDecisionState;
    type Context = ();
    type Event = PermissionDecisionEvent;
    type Input = ();

    const ID: &'static str = "permissionDecision";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(PermissionDecisionState::Pending, ())
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

impl HandCashChart for PermissionDecisionMachine {
    const MANIFEST_ID: &'static str = "permissionDecision";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["pending", "committing"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let next = match (snapshot.value, event) {
            (
                PermissionDecisionState::Pending,
                PermissionDecisionEvent::Approve | PermissionDecisionEvent::Cancel,
            ) => PermissionDecisionState::Committing,
            (PermissionDecisionState::Committing, PermissionDecisionEvent::Reset) => {
                PermissionDecisionState::Pending
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ()), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn commits_only_one_decision_until_the_next_prompt_resets_it() {
        let mut actor = EffectActor::<PermissionDecisionMachine>::default();
        actor.send(PermissionDecisionEvent::Approve);
        assert_eq!(*actor.state(), PermissionDecisionState::Committing);
        actor.send(PermissionDecisionEvent::Approve);
        actor.send(PermissionDecisionEvent::Cancel);
        assert_eq!(*actor.state(), PermissionDecisionState::Committing);
        actor.send(PermissionDecisionEvent::Reset);
        assert_eq!(*actor.state(), PermissionDecisionState::Pending);
    }
}
