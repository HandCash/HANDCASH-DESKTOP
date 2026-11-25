// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/iptAcceptRequestMachine.ts` (BRC-253 §§5-6).

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IptAcceptRequest {
    pub sender: String,
    pub ef: Vec<u8>,
    pub recipients: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IptReservationResult {
    Signed {
        request_id: String,
        signed_ef: Vec<u8>,
    },
    Pending {
        request_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IptAcceptFailure {
    pub message: String,
    pub held: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IptAcceptRequestState {
    Idle,
    Accepting,
    Held,
    Replaying,
    Signed,
    Refused,
    Cancelled,
}

impl IptAcceptRequestState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Accepting => "accepting",
            Self::Held => "held",
            Self::Replaying => "replaying",
            Self::Signed => "signed",
            Self::Refused => "refused",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IptAcceptRequestContext {
    pub request: Option<IptAcceptRequest>,
    pub request_id: Option<String>,
    pub signed_ef: Option<Vec<u8>>,
    pub error: Option<IptAcceptFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IptAcceptRequestEvent {
    Submit { request: IptAcceptRequest },
    Cancel,
    Replay,
    AcceptDone { output: IptReservationResult },
    AcceptError { message: String, held: bool },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IptAcceptRequestEffect {
    Accept { request: IptAcceptRequest },
}

pub struct IptAcceptRequestMachine;

impl Statechart for IptAcceptRequestMachine {
    type State = IptAcceptRequestState;
    type Context = IptAcceptRequestContext;
    type Event = IptAcceptRequestEvent;
    type Input = ();

    const ID: &'static str = "iptAcceptRequest";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            IptAcceptRequestState::Idle,
            IptAcceptRequestContext::default(),
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

impl HandCashChart for IptAcceptRequestMachine {
    const MANIFEST_ID: &'static str = "iptAcceptRequest";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "accepting",
        "held",
        "replaying",
        "signed",
        "refused",
        "cancelled",
    ];
    type Effect = IptAcceptRequestEffect;

    fn is_done(state: &Self::State) -> bool {
        matches!(
            state,
            IptAcceptRequestState::Signed
                | IptAcceptRequestState::Refused
                | IptAcceptRequestState::Cancelled
        )
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (IptAcceptRequestState::Idle, IptAcceptRequestEvent::Submit { request }) => {
                ctx.request = Some(request.clone());
                effects.push(IptAcceptRequestEffect::Accept { request });
                IptAcceptRequestState::Accepting
            }
            (IptAcceptRequestState::Idle, IptAcceptRequestEvent::Cancel) => {
                IptAcceptRequestState::Cancelled
            }
            (IptAcceptRequestState::Accepting, IptAcceptRequestEvent::AcceptDone { output }) => {
                match output {
                    IptReservationResult::Signed {
                        request_id,
                        signed_ef,
                    } => {
                        ctx.request_id = Some(request_id);
                        ctx.signed_ef = Some(signed_ef);
                        ctx.error = None;
                        IptAcceptRequestState::Signed
                    }
                    IptReservationResult::Pending { request_id } => {
                        ctx.request_id = Some(request_id);
                        ctx.signed_ef = None;
                        ctx.error = None;
                        IptAcceptRequestState::Held
                    }
                }
            }
            (
                IptAcceptRequestState::Accepting,
                IptAcceptRequestEvent::AcceptError { message, held },
            ) => {
                ctx.error = Some(IptAcceptFailure { message, held });
                if held {
                    IptAcceptRequestState::Held
                } else {
                    IptAcceptRequestState::Refused
                }
            }
            (IptAcceptRequestState::Held, IptAcceptRequestEvent::Replay) => {
                if let Some(request) = ctx.request.clone() {
                    effects.push(IptAcceptRequestEffect::Accept { request });
                }
                IptAcceptRequestState::Replaying
            }
            (IptAcceptRequestState::Replaying, IptAcceptRequestEvent::AcceptDone { output }) => {
                match output {
                    IptReservationResult::Signed {
                        request_id,
                        signed_ef,
                    } => {
                        ctx.request_id = Some(request_id);
                        ctx.signed_ef = Some(signed_ef);
                        ctx.error = None;
                        IptAcceptRequestState::Signed
                    }
                    IptReservationResult::Pending { request_id } => {
                        ctx.request_id = Some(request_id);
                        ctx.signed_ef = None;
                        ctx.error = None;
                        IptAcceptRequestState::Held
                    }
                }
            }
            (
                IptAcceptRequestState::Replaying,
                IptAcceptRequestEvent::AcceptError { message, .. },
            ) => {
                // A failed replay cannot release inputs, whatever the error says.
                ctx.error = Some(IptAcceptFailure {
                    message,
                    held: true,
                });
                IptAcceptRequestState::Held
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

    fn sample_request() -> IptAcceptRequest {
        IptAcceptRequest {
            sender: "sender".to_string(),
            ef: vec![1, 2],
            recipients: Vec::new(),
        }
    }

    #[test]
    fn ends_signed_with_journaled_bytes_and_accepts_nothing_after() {
        let mut actor = EffectActor::<IptAcceptRequestMachine>::default();
        let effects = actor.send(IptAcceptRequestEvent::Submit {
            request: sample_request(),
        });
        assert_eq!(*actor.state(), IptAcceptRequestState::Accepting);
        assert_eq!(
            effects,
            vec![IptAcceptRequestEffect::Accept {
                request: sample_request()
            }]
        );
        actor.send(IptAcceptRequestEvent::AcceptDone {
            output: IptReservationResult::Signed {
                request_id: "r1".to_string(),
                signed_ef: vec![9],
            },
        });
        assert_eq!(*actor.state(), IptAcceptRequestState::Signed);
        assert_eq!(actor.context().request_id.as_deref(), Some("r1"));
        assert_eq!(actor.context().signed_ef.as_deref(), Some(&[9][..]));
        assert!(actor.is_done());
    }

    #[test]
    fn snapshots_the_request_so_later_mutation_cannot_change_what_is_validated() {
        let mut actor = EffectActor::<IptAcceptRequestMachine>::default();
        let mut mutable = sample_request();
        let effects = actor.send(IptAcceptRequestEvent::Submit {
            request: mutable.clone(),
        });
        mutable.ef.push(7);
        assert_eq!(
            effects,
            vec![IptAcceptRequestEffect::Accept {
                request: IptAcceptRequest {
                    sender: "sender".to_string(),
                    ef: vec![1, 2],
                    recipients: Vec::new(),
                }
            }]
        );
        assert_eq!(actor.context().request.as_ref().unwrap().ef, vec![1, 2]);
    }

    #[test]
    fn refuses_a_request_that_failed_before_any_reservation() {
        let mut actor = EffectActor::<IptAcceptRequestMachine>::default();
        actor.send(IptAcceptRequestEvent::Submit {
            request: sample_request(),
        });
        actor.send(IptAcceptRequestEvent::AcceptError {
            message: "IPT input already reserved".to_string(),
            held: false,
        });
        assert_eq!(*actor.state(), IptAcceptRequestState::Refused);
        assert_eq!(
            actor.context().error,
            Some(IptAcceptFailure {
                message: "IPT input already reserved".to_string(),
                held: false,
            })
        );
        assert!(actor.is_done());
    }

    #[test]
    fn holds_a_pending_or_write_failed_request_with_no_cancel_out_of_it() {
        let mut pending = EffectActor::<IptAcceptRequestMachine>::default();
        pending.send(IptAcceptRequestEvent::Submit {
            request: sample_request(),
        });
        pending.send(IptAcceptRequestEvent::AcceptDone {
            output: IptReservationResult::Pending {
                request_id: "r2".to_string(),
            },
        });
        pending.send(IptAcceptRequestEvent::Cancel);
        assert_eq!(*pending.state(), IptAcceptRequestState::Held);

        let mut disk_fail = EffectActor::<IptAcceptRequestMachine>::default();
        disk_fail.send(IptAcceptRequestEvent::Submit {
            request: sample_request(),
        });
        disk_fail.send(IptAcceptRequestEvent::AcceptError {
            message: "disk failure".to_string(),
            held: true,
        });
        disk_fail.send(IptAcceptRequestEvent::Cancel);
        assert_eq!(*disk_fail.state(), IptAcceptRequestState::Held);
    }

    #[test]
    fn replays_only_same_request_and_never_releases_held_on_failed_replay() {
        let req = sample_request();
        let mut pending = EffectActor::<IptAcceptRequestMachine>::default();
        pending.send(IptAcceptRequestEvent::Submit {
            request: req.clone(),
        });
        pending.send(IptAcceptRequestEvent::AcceptDone {
            output: IptReservationResult::Pending {
                request_id: "r3".to_string(),
            },
        });
        let replay_effects = pending.send(IptAcceptRequestEvent::Replay);
        assert_eq!(
            replay_effects,
            vec![IptAcceptRequestEffect::Accept {
                request: req.clone()
            }]
        );
        pending.send(IptAcceptRequestEvent::AcceptDone {
            output: IptReservationResult::Pending {
                request_id: "r3".to_string(),
            },
        });
        assert_eq!(*pending.state(), IptAcceptRequestState::Held);

        // Even an error claiming held=false cannot release inputs on replay.
        pending.send(IptAcceptRequestEvent::Replay);
        pending.send(IptAcceptRequestEvent::AcceptError {
            message: "offline".to_string(),
            held: false,
        });
        assert_eq!(*pending.state(), IptAcceptRequestState::Held);
        assert_eq!(
            pending.context().error,
            Some(IptAcceptFailure {
                message: "offline".to_string(),
                held: true,
            })
        );

        // A journaled signature finishes the replay.
        pending.send(IptAcceptRequestEvent::Replay);
        pending.send(IptAcceptRequestEvent::AcceptDone {
            output: IptReservationResult::Signed {
                request_id: "r3".to_string(),
                signed_ef: vec![5],
            },
        });
        assert_eq!(*pending.state(), IptAcceptRequestState::Signed);
        assert_eq!(pending.context().signed_ef.as_deref(), Some(&[5][..]));
    }

    #[test]
    fn can_be_cancelled_only_before_submission() {
        let mut actor = EffectActor::<IptAcceptRequestMachine>::default();
        actor.send(IptAcceptRequestEvent::Cancel);
        assert_eq!(*actor.state(), IptAcceptRequestState::Cancelled);
        assert!(actor.is_done());
    }
}
