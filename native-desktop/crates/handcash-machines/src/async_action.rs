// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/asyncActionMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AsyncActionConfirm {
    pub title: String,
    pub body: String,
    pub confirm_label: String,
    pub cancel_label: Option<String>,
    pub danger: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AsyncActionState {
    Idle,
    Confirming,
    Busy,
    Failure,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AsyncActionContext {
    pub action: Option<String>,
    pub confirm: Option<AsyncActionConfirm>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AsyncActionEvent {
    Request {
        action: String,
        confirm: AsyncActionConfirm,
    },
    Confirm,
    Cancel,
    Start {
        action: String,
    },
    Succeed,
    Fail {
        error: String,
    },
    Reset,
}

pub struct AsyncActionMachine;

impl Statechart for AsyncActionMachine {
    type State = AsyncActionState;
    type Context = AsyncActionContext;
    type Event = AsyncActionEvent;
    type Input = ();

    const ID: &'static str = "asyncAction";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(AsyncActionState::Idle, AsyncActionContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            AsyncActionState::Idle => StateValue::leaf("idle"),
            AsyncActionState::Confirming => StateValue::leaf("confirming"),
            AsyncActionState::Busy => StateValue::leaf("busy"),
            AsyncActionState::Failure => StateValue::leaf("failure"),
        }
    }
}

impl HandCashChart for AsyncActionMachine {
    const MANIFEST_ID: &'static str = "asyncAction";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["idle", "confirming", "busy", "failure"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let next = match (snapshot.value, event) {
            (
                AsyncActionState::Idle | AsyncActionState::Failure,
                AsyncActionEvent::Request { action, confirm },
            ) => Snapshot::new(
                AsyncActionState::Confirming,
                AsyncActionContext {
                    action: Some(action),
                    confirm: Some(confirm),
                    error: None,
                },
            ),
            (
                AsyncActionState::Idle | AsyncActionState::Failure,
                AsyncActionEvent::Start { action },
            ) => Snapshot::new(
                AsyncActionState::Busy,
                AsyncActionContext {
                    action: Some(action),
                    confirm: None,
                    error: None,
                },
            ),
            (AsyncActionState::Confirming, AsyncActionEvent::Confirm) => Snapshot::new(
                AsyncActionState::Busy,
                AsyncActionContext {
                    action: snapshot.context.action.clone(),
                    confirm: None,
                    error: None,
                },
            ),
            (
                AsyncActionState::Confirming,
                AsyncActionEvent::Cancel | AsyncActionEvent::Reset,
            )
            | (AsyncActionState::Busy, AsyncActionEvent::Succeed)
            | (AsyncActionState::Failure, AsyncActionEvent::Reset) => {
                Snapshot::new(AsyncActionState::Idle, AsyncActionContext::default())
            }
            (AsyncActionState::Busy, AsyncActionEvent::Fail { error }) => Snapshot::new(
                AsyncActionState::Failure,
                AsyncActionContext {
                    action: snapshot.context.action.clone(),
                    confirm: None,
                    error: Some(error),
                },
            ),
            _ => snapshot.clone(),
        };
        (next, Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn confirm_fixture() -> AsyncActionConfirm {
        AsyncActionConfirm {
            title: "Take these coins back?".into(),
            body: "Nothing was published, so the coins are yours to spend again.".into(),
            confirm_label: "Take back".into(),
            cancel_label: None,
            danger: true,
        }
    }

    #[test]
    fn runs_one_named_action_and_returns_to_idle_on_success() {
        let mut actor = EffectActor::<AsyncActionMachine>::default();
        actor.send(AsyncActionEvent::Start {
            action: "retry".into(),
        });
        assert_eq!(*actor.state(), AsyncActionState::Busy);
        assert_eq!(actor.context().action.as_deref(), Some("retry"));
        actor.send(AsyncActionEvent::Succeed);
        assert_eq!(*actor.state(), AsyncActionState::Idle);
        assert_eq!(actor.context().action, None);
    }

    #[test]
    fn refuses_a_competing_action_while_one_is_in_flight() {
        let mut actor = EffectActor::<AsyncActionMachine>::default();
        actor.send(AsyncActionEvent::Start {
            action: "rebroadcastAll".into(),
        });
        actor.send(AsyncActionEvent::Start {
            action: "clearAll".into(),
        });
        assert_eq!(*actor.state(), AsyncActionState::Busy);
        assert_eq!(actor.context().action.as_deref(), Some("rebroadcastAll"));
    }

    #[test]
    fn keeps_failed_action_and_reason_until_reset_or_retried() {
        let mut actor = EffectActor::<AsyncActionMachine>::default();
        actor.send(AsyncActionEvent::Start {
            action: "reclaim".into(),
        });
        actor.send(AsyncActionEvent::Fail {
            error: "inputs already spent".into(),
        });
        assert_eq!(*actor.state(), AsyncActionState::Failure);
        assert_eq!(
            *actor.context(),
            AsyncActionContext {
                action: Some("reclaim".into()),
                confirm: None,
                error: Some("inputs already spent".into()),
            }
        );
        actor.send(AsyncActionEvent::Start {
            action: "clear".into(),
        });
        assert_eq!(*actor.state(), AsyncActionState::Busy);
        assert_eq!(actor.context().error, None);
        actor.send(AsyncActionEvent::Succeed);
        actor.send(AsyncActionEvent::Reset);
        assert_eq!(*actor.state(), AsyncActionState::Idle);
    }

    #[test]
    fn ignores_stale_reset_while_a_mutation_is_running() {
        let mut actor = EffectActor::<AsyncActionMachine>::default();
        actor.send(AsyncActionEvent::Start {
            action: "clear".into(),
        });
        actor.send(AsyncActionEvent::Reset);
        assert_eq!(*actor.state(), AsyncActionState::Busy);
    }

    #[test]
    fn holds_confirm_copy_as_a_state_until_the_user_decides() {
        let mut actor = EffectActor::<AsyncActionMachine>::default();
        let confirm = confirm_fixture();
        actor.send(AsyncActionEvent::Request {
            action: "reclaim".into(),
            confirm: confirm.clone(),
        });
        assert_eq!(*actor.state(), AsyncActionState::Confirming);
        assert_eq!(
            *actor.context(),
            AsyncActionContext {
                action: Some("reclaim".into()),
                confirm: Some(confirm),
                error: None,
            }
        );
        actor.send(AsyncActionEvent::Confirm);
        assert_eq!(*actor.state(), AsyncActionState::Busy);
        assert_eq!(actor.context().action.as_deref(), Some("reclaim"));
        assert_eq!(actor.context().confirm, None);
    }

    #[test]
    fn cancelling_a_confirm_returns_to_idle_with_nothing_run() {
        let mut actor = EffectActor::<AsyncActionMachine>::default();
        actor.send(AsyncActionEvent::Request {
            action: "clearAll".into(),
            confirm: confirm_fixture(),
        });
        actor.send(AsyncActionEvent::Cancel);
        assert_eq!(*actor.state(), AsyncActionState::Idle);
        assert_eq!(actor.context().action, None);
    }

    #[test]
    fn refuses_a_new_request_while_confirming_or_busy() {
        let mut actor = EffectActor::<AsyncActionMachine>::default();
        let confirm = confirm_fixture();
        actor.send(AsyncActionEvent::Request {
            action: "clearAll".into(),
            confirm: confirm.clone(),
        });
        actor.send(AsyncActionEvent::Request {
            action: "rebroadcastAll".into(),
            confirm,
        });
        actor.send(AsyncActionEvent::Start {
            action: "publishPending".into(),
        });
        assert_eq!(*actor.state(), AsyncActionState::Confirming);
        assert_eq!(actor.context().action.as_deref(), Some("clearAll"));
    }
}
