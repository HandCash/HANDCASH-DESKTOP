// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/qrRevealMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QrPayload {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QrRevealState {
    Closed,
    Open,
}

impl QrRevealState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QrRevealContext {
    pub payload: Option<QrPayload>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QrRevealEvent {
    Show { payload: QrPayload },
    Hide,
}

pub struct QrRevealMachine;

impl Statechart for QrRevealMachine {
    type State = QrRevealState;
    type Context = QrRevealContext;
    type Event = QrRevealEvent;
    type Input = ();

    const ID: &'static str = "qrReveal";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(QrRevealState::Closed, QrRevealContext::default())
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

impl HandCashChart for QrRevealMachine {
    const MANIFEST_ID: &'static str = "qrReveal";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["closed", "open"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (QrRevealState::Closed | QrRevealState::Open, QrRevealEvent::Show { payload }) => {
                ctx.payload = Some(payload);
                QrRevealState::Open
            }
            (QrRevealState::Open, QrRevealEvent::Hide) => {
                ctx.payload = None;
                QrRevealState::Closed
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
    fn opens_updates_payload_and_hides() {
        let mut actor = EffectActor::<QrRevealMachine>::default();
        assert_eq!(*actor.state(), QrRevealState::Closed);
        actor.send(QrRevealEvent::Show {
            payload: QrPayload {
                label: "BSV".to_string(),
                value: "1abc".to_string(),
            },
        });
        assert_eq!(*actor.state(), QrRevealState::Open);
        assert_eq!(actor.context().payload.as_ref().unwrap().value, "1abc");
        actor.send(QrRevealEvent::Show {
            payload: QrPayload {
                label: "Identity".to_string(),
                value: "02ff".to_string(),
            },
        });
        assert_eq!(*actor.state(), QrRevealState::Open);
        assert_eq!(actor.context().payload.as_ref().unwrap().value, "02ff");
        actor.send(QrRevealEvent::Hide);
        assert_eq!(*actor.state(), QrRevealState::Closed);
        assert!(actor.context().payload.is_none());
    }
}
