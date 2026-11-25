// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/callMachine.ts`.

use std::collections::BTreeMap;

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const CALL_RING_MS: u64 = 45_000;
pub const CALL_CONNECT_MS: u64 = 20_000;
pub const CALL_REACH_MS: u64 = 40_000;
pub const CALL_ENDED_LINGER_MS: u64 = 2_500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallOutcome {
    Finished,
    Missed,
    Declined,
    NoAnswer,
    Busy,
    Unreachable,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CallDirection {
    #[default]
    Out,
    In,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallMediaState {
    pub muted: bool,
    pub camera: bool,
    pub sharing: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallOutgoingState {
    Reaching,
    Ringing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallState {
    Idle,
    Outgoing(CallOutgoingState),
    Incoming,
    Connecting,
    Active,
    Ended,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallContext {
    pub call_id: Option<String>,
    pub peer: Option<String>,
    pub members: Vec<String>,
    pub joined: Vec<String>,
    pub remote: BTreeMap<String, CallMediaState>,
    pub direction: CallDirection,
    pub video: bool,
    pub muted: bool,
    pub remote_muted: bool,
    pub camera: bool,
    pub remote_camera: bool,
    pub sharing: bool,
    pub remote_sharing: bool,
    pub started_at: u64,
    pub connected_at: Option<u64>,
    pub ended_at: Option<u64>,
    pub outcome: Option<CallOutcome>,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallEvent {
    Dial {
        call_id: String,
        peer: String,
        video: bool,
        at: u64,
    },
    Incoming {
        call_id: String,
        peer: String,
        video: bool,
        at: u64,
        members: Option<Vec<String>>,
    },
    Members {
        members: Vec<String>,
    },
    Joined {
        peer: String,
    },
    Left {
        peer: String,
    },
    Reached,
    Unreachable {
        at: u64,
    },
    Accept {
        video: bool,
    },
    RemoteAccepted,
    Decline {
        at: u64,
    },
    RemoteDeclined {
        busy: bool,
        at: u64,
    },
    MediaConnected {
        at: u64,
    },
    Fail {
        reason: String,
        at: u64,
    },
    HangUp {
        at: u64,
    },
    RemoteHungUp {
        at: u64,
    },
    ToggleMute,
    Camera {
        on: bool,
    },
    Share {
        on: bool,
    },
    RemoteState {
        peer: String,
        muted: bool,
        camera: bool,
        sharing: bool,
    },
    Dismiss,
    ReachTimeout {
        at: u64,
    },
    RingTimeout {
        at: u64,
    },
    ConnectTimeout {
        at: u64,
    },
    LingerTimeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallEffect {
    ScheduleReach { delay_ms: u64 },
    ScheduleRing { delay_ms: u64 },
    ScheduleConnect { delay_ms: u64 },
    ScheduleLinger { delay_ms: u64 },
}

pub struct CallMachine;

impl Statechart for CallMachine {
    type State = CallState;
    type Context = CallContext;
    type Event = CallEvent;
    type Input = ();

    const ID: &'static str = "call";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(CallState::Idle, CallContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            CallState::Idle => StateValue::leaf("idle"),
            CallState::Outgoing(CallOutgoingState::Reaching) => {
                StateValue::compound("outgoing", StateValue::leaf("reaching"))
            }
            CallState::Outgoing(CallOutgoingState::Ringing) => {
                StateValue::compound("outgoing", StateValue::leaf("ringing"))
            }
            CallState::Incoming => StateValue::leaf("incoming"),
            CallState::Connecting => StateValue::leaf("connecting"),
            CallState::Active => StateValue::leaf("active"),
            CallState::Ended => StateValue::leaf("ended"),
        }
    }
}

fn end_call(
    ctx: &mut CallContext,
    outcome: CallOutcome,
    at: u64,
    failure: Option<String>,
    effects: &mut Vec<CallEffect>,
) -> CallState {
    ctx.outcome = Some(outcome);
    ctx.ended_at = Some(at);
    ctx.failure = failure;
    effects.push(CallEffect::ScheduleLinger {
        delay_ms: CALL_ENDED_LINGER_MS,
    });
    CallState::Ended
}

fn apply_remote_state(ctx: &mut CallContext, peer: String, muted: bool, camera: bool, sharing: bool) {
    let st = CallMediaState {
        muted,
        camera,
        sharing,
    };
    ctx.remote.insert(peer.clone(), st);
    if ctx.peer.as_deref() == Some(peer.as_str()) {
        ctx.remote_muted = muted;
        ctx.remote_camera = camera;
        ctx.remote_sharing = sharing;
    }
}

impl HandCashChart for CallMachine {
    const MANIFEST_ID: &'static str = "call";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "outgoing",
        "incoming",
        "connecting",
        "active",
        "ended",
    ];
    type Effect = CallEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        use CallEvent as E;
        use CallOutgoingState as Out;
        use CallState as S;

        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (
                S::Idle | S::Ended,
                E::Dial {
                    call_id,
                    peer,
                    video,
                    at,
                },
            ) => {
                ctx = CallContext {
                    call_id: Some(call_id),
                    peer: Some(peer.clone()),
                    members: vec![peer],
                    direction: CallDirection::Out,
                    video,
                    camera: video,
                    started_at: at,
                    ..CallContext::default()
                };
                effects.push(CallEffect::ScheduleReach {
                    delay_ms: CALL_REACH_MS,
                });
                S::Outgoing(Out::Reaching)
            }
            (
                S::Idle | S::Ended,
                E::Incoming {
                    call_id,
                    peer,
                    video,
                    at,
                    members,
                },
            ) => {
                let member_list = members
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| vec![peer.clone()]);
                ctx = CallContext {
                    call_id: Some(call_id),
                    peer: Some(peer),
                    members: member_list,
                    direction: CallDirection::In,
                    video,
                    remote_camera: video,
                    started_at: at,
                    ..CallContext::default()
                };
                effects.push(CallEffect::ScheduleRing {
                    delay_ms: CALL_RING_MS,
                });
                S::Incoming
            }
            (S::Outgoing(_), E::HangUp { at }) => {
                end_call(&mut ctx, CallOutcome::Cancelled, at, None, &mut effects)
            }
            (S::Outgoing(_), E::Fail { reason, at }) => {
                end_call(&mut ctx, CallOutcome::Failed, at, Some(reason), &mut effects)
            }
            (S::Outgoing(_), E::ToggleMute) => {
                ctx.muted = !ctx.muted;
                snapshot.value
            }
            (S::Outgoing(_), E::Camera { on }) => {
                ctx.camera = on;
                snapshot.value
            }
            (S::Outgoing(_), E::Members { members }) => {
                ctx.members = members;
                snapshot.value
            }
            (S::Outgoing(Out::Reaching), E::Reached) => {
                effects.push(CallEffect::ScheduleRing {
                    delay_ms: CALL_RING_MS,
                });
                S::Outgoing(Out::Ringing)
            }
            (S::Outgoing(Out::Reaching), E::RemoteAccepted) => {
                effects.push(CallEffect::ScheduleConnect {
                    delay_ms: CALL_CONNECT_MS,
                });
                S::Connecting
            }
            (S::Outgoing(Out::Reaching), E::Unreachable { at } | E::ReachTimeout { at }) => {
                end_call(&mut ctx, CallOutcome::Unreachable, at, None, &mut effects)
            }
            (S::Outgoing(Out::Ringing), E::RemoteAccepted) => {
                effects.push(CallEffect::ScheduleConnect {
                    delay_ms: CALL_CONNECT_MS,
                });
                S::Connecting
            }
            (S::Outgoing(Out::Ringing), E::RemoteDeclined { busy, at }) => {
                let outcome = if busy {
                    CallOutcome::Busy
                } else {
                    CallOutcome::Declined
                };
                end_call(&mut ctx, outcome, at, None, &mut effects)
            }
            (S::Outgoing(Out::Ringing), E::RingTimeout { at }) => {
                end_call(&mut ctx, CallOutcome::NoAnswer, at, None, &mut effects)
            }
            (S::Incoming, E::Accept { video }) => {
                ctx.camera = video;
                effects.push(CallEffect::ScheduleConnect {
                    delay_ms: CALL_CONNECT_MS,
                });
                S::Connecting
            }
            (S::Incoming, E::Members { members }) => {
                ctx.members = members;
                S::Incoming
            }
            (S::Incoming, E::Decline { at }) => {
                end_call(&mut ctx, CallOutcome::Declined, at, None, &mut effects)
            }
            (S::Incoming, E::RemoteHungUp { at } | E::RingTimeout { at }) => {
                end_call(&mut ctx, CallOutcome::Missed, at, None, &mut effects)
            }
            (S::Connecting, E::MediaConnected { at }) => {
                ctx.connected_at = Some(at);
                S::Active
            }
            (S::Connecting, E::Fail { reason, at }) => {
                end_call(&mut ctx, CallOutcome::Failed, at, Some(reason), &mut effects)
            }
            (S::Connecting, E::ConnectTimeout { at }) => {
                end_call(&mut ctx, CallOutcome::Failed, at, None, &mut effects)
            }
            (S::Connecting, E::HangUp { at } | E::RemoteHungUp { at }) => {
                end_call(&mut ctx, CallOutcome::Cancelled, at, None, &mut effects)
            }
            (S::Connecting, E::ToggleMute) => {
                ctx.muted = !ctx.muted;
                S::Connecting
            }
            (S::Connecting, E::Camera { on }) => {
                ctx.camera = on;
                S::Connecting
            }
            (S::Connecting, E::Share { on }) => {
                ctx.sharing = on;
                S::Connecting
            }
            (
                S::Connecting,
                E::RemoteState {
                    peer,
                    muted,
                    camera,
                    sharing,
                },
            ) => {
                apply_remote_state(&mut ctx, peer, muted, camera, sharing);
                S::Connecting
            }
            (S::Connecting, E::Members { members }) => {
                ctx.members = members;
                S::Connecting
            }
            (S::Connecting, E::Joined { peer }) => {
                if !ctx.joined.contains(&peer) {
                    ctx.joined.push(peer);
                }
                S::Connecting
            }
            (S::Connecting, E::Left { peer }) => {
                ctx.joined.retain(|k| k != &peer);
                ctx.remote.remove(&peer);
                S::Connecting
            }
            (S::Active, E::HangUp { at } | E::RemoteHungUp { at }) => {
                end_call(&mut ctx, CallOutcome::Finished, at, None, &mut effects)
            }
            (S::Active, E::Fail { reason, at }) => {
                end_call(&mut ctx, CallOutcome::Failed, at, Some(reason), &mut effects)
            }
            (S::Active, E::ToggleMute) => {
                ctx.muted = !ctx.muted;
                S::Active
            }
            (S::Active, E::Camera { on }) => {
                ctx.camera = on;
                S::Active
            }
            (S::Active, E::Share { on }) => {
                ctx.sharing = on;
                S::Active
            }
            (
                S::Active,
                E::RemoteState {
                    peer,
                    muted,
                    camera,
                    sharing,
                },
            ) => {
                apply_remote_state(&mut ctx, peer, muted, camera, sharing);
                S::Active
            }
            (S::Active, E::Members { members }) => {
                ctx.members = members;
                S::Active
            }
            (S::Active, E::Joined { peer }) => {
                if !ctx.joined.contains(&peer) {
                    ctx.joined.push(peer);
                }
                S::Active
            }
            (S::Active, E::Left { peer }) => {
                ctx.joined.retain(|k| k != &peer);
                ctx.remote.remove(&peer);
                S::Active
            }
            (S::Ended, E::Dismiss | E::LingerTimeout) => {
                ctx = CallContext::default();
                S::Idle
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
    fn dials_rings_connects_tracks_media_and_ends_cleanly() {
        let mut actor = EffectActor::<CallMachine>::default();
        actor.send(CallEvent::Dial {
            call_id: "c1".to_string(),
            peer: "peer-a".to_string(),
            video: true,
            at: 100,
        });
        assert_eq!(*actor.state(), CallState::Outgoing(CallOutgoingState::Reaching));
        assert_eq!(actor.state_attr(), "outgoing:reaching");
        assert!(actor.context().camera);
        actor.send(CallEvent::Reached);
        assert_eq!(*actor.state(), CallState::Outgoing(CallOutgoingState::Ringing));
        actor.send(CallEvent::RemoteAccepted);
        assert_eq!(*actor.state(), CallState::Connecting);
        actor.send(CallEvent::MediaConnected { at: 200 });
        assert_eq!(*actor.state(), CallState::Active);
        assert_eq!(actor.context().connected_at, Some(200));
        actor.send(CallEvent::ToggleMute);
        assert!(actor.context().muted);
        actor.send(CallEvent::RemoteState {
            peer: "peer-a".to_string(),
            muted: true,
            camera: false,
            sharing: true,
        });
        assert!(actor.context().remote_muted);
        assert!(actor.context().remote_sharing);
        actor.send(CallEvent::HangUp { at: 500 });
        assert_eq!(*actor.state(), CallState::Ended);
        assert_eq!(actor.context().outcome, Some(CallOutcome::Finished));
        assert_eq!(actor.context().ended_at, Some(500));
        actor.send(CallEvent::LingerTimeout);
        assert_eq!(*actor.state(), CallState::Idle);
        assert_eq!(actor.context().call_id, None);
    }

    #[test]
    fn incoming_call_accept_decline_and_timeouts_record_exact_outcomes() {
        let mut actor = EffectActor::<CallMachine>::default();
        actor.send(CallEvent::Incoming {
            call_id: "c2".to_string(),
            peer: "peer-b".to_string(),
            video: false,
            at: 10,
            members: Some(vec!["peer-b".to_string(), "peer-c".to_string()]),
        });
        assert_eq!(*actor.state(), CallState::Incoming);
        assert_eq!(actor.context().members.len(), 2);
        actor.send(CallEvent::RingTimeout { at: 45_010 });
        assert_eq!(*actor.state(), CallState::Ended);
        assert_eq!(actor.context().outcome, Some(CallOutcome::Missed));

        actor.send(CallEvent::Dial {
            call_id: "c3".to_string(),
            peer: "peer-b".to_string(),
            video: false,
            at: 50_000,
        });
        actor.send(CallEvent::Reached);
        actor.send(CallEvent::RemoteDeclined {
            busy: true,
            at: 51_000,
        });
        assert_eq!(actor.context().outcome, Some(CallOutcome::Busy));
    }
}
