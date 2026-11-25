// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/accountMoveMachine.ts` (draft BRC-249).

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const MAX_RESTARTS: u32 = 2;
pub const ANSWER_WINDOW_MS: u64 = 10_000;
pub const RELEASE_WINDOW_MS: u64 = 120_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountMovePhase {
    Reading,
    Dialing,
    RequestingDirect,
    RequestingBox,
    AwaitingAccept,
    AwaitingRelease,
    Forcing,
    Taking,
}

impl AccountMovePhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Reading => "reading",
            Self::Dialing => "dialing",
            Self::RequestingDirect => "requestingDirect",
            Self::RequestingBox => "requestingBox",
            Self::AwaitingAccept => "awaitingAccept",
            Self::AwaitingRelease => "awaitingRelease",
            Self::Forcing => "forcing",
            Self::Taking => "taking",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountMoveState {
    Reading,
    Dialing,
    RequestingDirect,
    RequestingBox,
    AwaitingAccept,
    AwaitingRelease,
    Forcing,
    Taking,
    Taken,
    Failed,
}

impl AccountMoveState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Reading => "reading",
            Self::Dialing => "dialing",
            Self::RequestingDirect => "requestingDirect",
            Self::RequestingBox => "requestingBox",
            Self::AwaitingAccept => "awaitingAccept",
            Self::AwaitingRelease => "awaitingRelease",
            Self::Forcing => "forcing",
            Self::Taking => "taking",
            Self::Taken => "taken",
            Self::Failed => "failed",
        }
    }

    pub const fn phase(self) -> Option<AccountMovePhase> {
        match self {
            Self::Reading => Some(AccountMovePhase::Reading),
            Self::Dialing => Some(AccountMovePhase::Dialing),
            Self::RequestingDirect => Some(AccountMovePhase::RequestingDirect),
            Self::RequestingBox => Some(AccountMovePhase::RequestingBox),
            Self::AwaitingAccept => Some(AccountMovePhase::AwaitingAccept),
            Self::AwaitingRelease => Some(AccountMovePhase::AwaitingRelease),
            Self::Forcing => Some(AccountMovePhase::Forcing),
            Self::Taking => Some(AccountMovePhase::Taking),
            Self::Taken | Self::Failed => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordView {
    Released { seq: u64 },
    Ours { seq: u64 },
    Held { seq: u64, device_id: String },
    Absent,
    Unreachable { reason: String },
    Unsupported,
}

impl RecordView {
    pub fn is_movable(&self) -> bool {
        matches!(self, Self::Released { .. } | Self::Ours { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TakeResult {
    Taken,
    HeldElsewhere,
    Unavailable { reason: Option<String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveFailure {
    HostUnreachable,
    HostUnsupported,
    ChannelUnreachable,
    TakeUnavailable,
    KeptChanging,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MoveOutput {
    Moved {
        forced: bool,
    },
    Failed {
        failure: MoveFailure,
        detail: Option<String>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountMoveContext {
    pub seq: u64,
    pub device: Option<String>,
    pub nonce: Option<String>,
    pub forced: bool,
    pub restarts: u32,
    pub failure: Option<MoveFailure>,
    pub detail: Option<String>,
}

impl AccountMoveContext {
    pub fn output(&self) -> MoveOutput {
        if let Some(failure) = self.failure {
            MoveOutput::Failed {
                failure,
                detail: self.detail.clone(),
            }
        } else {
            MoveOutput::Moved {
                forced: self.forced,
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountMoveEvent {
    ReadRecordDone(RecordView),
    ReadRecordError(String),
    DialLinkDone(bool),
    DialLinkError,
    SendDirectDone { nonce: String },
    SendDirectError,
    SendBoxDone { nonce: String },
    SendBoxError(String),
    Accepted,
    Record(RecordView),
    AnswerWindowElapsed,
    ReleaseWindowElapsed,
    TakeDone(TakeResult),
    TakeError(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountMoveEffect {
    ReadRecord,
    DialLink { device: String },
    SendDirect { seq: u64, device: String },
    SendBox { seq: u64 },
    WatchAccept { nonce: String },
    WatchRecord,
    StartAnswerTimer { ms: u64 },
    StartReleaseTimer { ms: u64 },
    Take { force: bool },
}

pub struct AccountMoveMachine;

impl AccountMoveMachine {
    pub fn entry_effects(state: AccountMoveState, ctx: &AccountMoveContext) -> Vec<AccountMoveEffect> {
        match state {
            AccountMoveState::Reading => vec![AccountMoveEffect::ReadRecord],
            AccountMoveState::Dialing => vec![AccountMoveEffect::DialLink {
                device: ctx.device.clone().unwrap_or_default(),
            }],
            AccountMoveState::RequestingDirect => vec![AccountMoveEffect::SendDirect {
                seq: ctx.seq,
                device: ctx.device.clone().unwrap_or_default(),
            }],
            AccountMoveState::RequestingBox => vec![AccountMoveEffect::SendBox { seq: ctx.seq }],
            AccountMoveState::AwaitingAccept => vec![
                AccountMoveEffect::WatchAccept {
                    nonce: ctx.nonce.clone().unwrap_or_default(),
                },
                AccountMoveEffect::WatchRecord,
                AccountMoveEffect::StartAnswerTimer {
                    ms: ANSWER_WINDOW_MS,
                },
            ],
            AccountMoveState::AwaitingRelease => vec![
                AccountMoveEffect::WatchRecord,
                AccountMoveEffect::StartReleaseTimer {
                    ms: RELEASE_WINDOW_MS,
                },
            ],
            AccountMoveState::Forcing => vec![AccountMoveEffect::Take { force: true }],
            AccountMoveState::Taking => vec![AccountMoveEffect::Take { force: false }],
            AccountMoveState::Taken | AccountMoveState::Failed => Vec::new(),
        }
    }
}

impl Statechart for AccountMoveMachine {
    type State = AccountMoveState;
    type Context = AccountMoveContext;
    type Event = AccountMoveEvent;
    type Input = ();

    const ID: &'static str = "accountMove";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(AccountMoveState::Reading, AccountMoveContext::default())
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

impl HandCashChart for AccountMoveMachine {
    const MANIFEST_ID: &'static str = "accountMove";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "reading",
        "dialing",
        "requestingDirect",
        "requestingBox",
        "awaitingAccept",
        "awaitingRelease",
        "forcing",
        "taking",
        "taken",
        "failed",
    ];
    type Effect = AccountMoveEffect;

    fn is_done(state: &Self::State) -> bool {
        matches!(state, AccountMoveState::Taken | AccountMoveState::Failed)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next_state = match (snapshot.value, event) {
            (AccountMoveState::Reading, AccountMoveEvent::ReadRecordDone(view)) => match view {
                RecordView::Released { .. } | RecordView::Ours { .. } => AccountMoveState::Taking,
                RecordView::Held { seq, device_id } => {
                    ctx.seq = seq;
                    ctx.device = Some(device_id);
                    AccountMoveState::Dialing
                }
                RecordView::Absent => {
                    ctx.seq = 0;
                    ctx.device = None;
                    AccountMoveState::RequestingBox
                }
                RecordView::Unsupported => {
                    ctx.failure = Some(MoveFailure::HostUnsupported);
                    ctx.detail = None;
                    AccountMoveState::Failed
                }
                RecordView::Unreachable { reason } => {
                    ctx.failure = Some(MoveFailure::HostUnreachable);
                    ctx.detail = Some(reason);
                    AccountMoveState::Failed
                }
            },
            (AccountMoveState::Reading, AccountMoveEvent::ReadRecordError(err)) => {
                ctx.failure = Some(MoveFailure::HostUnreachable);
                ctx.detail = Some(err);
                AccountMoveState::Failed
            }
            (AccountMoveState::Dialing, AccountMoveEvent::DialLinkDone(true)) => {
                AccountMoveState::RequestingDirect
            }
            (
                AccountMoveState::Dialing,
                AccountMoveEvent::DialLinkDone(false) | AccountMoveEvent::DialLinkError,
            ) => AccountMoveState::RequestingBox,
            (AccountMoveState::RequestingDirect, AccountMoveEvent::SendDirectDone { nonce }) => {
                ctx.nonce = Some(nonce);
                AccountMoveState::AwaitingAccept
            }
            (AccountMoveState::RequestingDirect, AccountMoveEvent::SendDirectError) => {
                AccountMoveState::RequestingBox
            }
            (AccountMoveState::RequestingBox, AccountMoveEvent::SendBoxDone { nonce }) => {
                ctx.nonce = Some(nonce);
                AccountMoveState::AwaitingAccept
            }
            (AccountMoveState::RequestingBox, AccountMoveEvent::SendBoxError(err)) => {
                ctx.failure = Some(MoveFailure::ChannelUnreachable);
                ctx.detail = Some(err);
                AccountMoveState::Failed
            }
            (AccountMoveState::AwaitingAccept, AccountMoveEvent::Accepted) => {
                AccountMoveState::AwaitingRelease
            }
            (AccountMoveState::AwaitingAccept, AccountMoveEvent::AnswerWindowElapsed) => {
                AccountMoveState::Forcing
            }
            (AccountMoveState::AwaitingRelease, AccountMoveEvent::ReleaseWindowElapsed) => {
                AccountMoveState::Forcing
            }
            (
                AccountMoveState::AwaitingAccept | AccountMoveState::AwaitingRelease,
                AccountMoveEvent::Record(view),
            ) => {
                if view.is_movable() {
                    AccountMoveState::Taking
                } else if let RecordView::Held { seq, .. } = view {
                    if seq > ctx.seq {
                        if ctx.restarts < MAX_RESTARTS {
                            ctx.restarts += 1;
                            ctx.nonce = None;
                            AccountMoveState::Reading
                        } else {
                            ctx.failure = Some(MoveFailure::KeptChanging);
                            ctx.detail = None;
                            AccountMoveState::Failed
                        }
                    } else {
                        return (snapshot.clone(), Vec::new());
                    }
                } else {
                    return (snapshot.clone(), Vec::new());
                }
            }
            (AccountMoveState::Forcing, AccountMoveEvent::TakeDone(res)) => match res {
                TakeResult::Taken => {
                    ctx.forced = true;
                    AccountMoveState::Taken
                }
                TakeResult::Unavailable { reason } => {
                    ctx.failure = Some(MoveFailure::TakeUnavailable);
                    ctx.detail = reason;
                    AccountMoveState::Failed
                }
                TakeResult::HeldElsewhere => {
                    ctx.failure = Some(MoveFailure::TakeUnavailable);
                    ctx.detail = None;
                    AccountMoveState::Failed
                }
            },
            (AccountMoveState::Forcing, AccountMoveEvent::TakeError(err)) => {
                ctx.failure = Some(MoveFailure::TakeUnavailable);
                ctx.detail = Some(err);
                AccountMoveState::Failed
            }
            (AccountMoveState::Taking, AccountMoveEvent::TakeDone(res)) => match res {
                TakeResult::Taken => AccountMoveState::Taken,
                TakeResult::HeldElsewhere => {
                    if ctx.restarts < MAX_RESTARTS {
                        ctx.restarts += 1;
                        ctx.nonce = None;
                        AccountMoveState::Reading
                    } else {
                        ctx.failure = Some(MoveFailure::KeptChanging);
                        ctx.detail = None;
                        AccountMoveState::Failed
                    }
                }
                TakeResult::Unavailable { reason } => {
                    ctx.failure = Some(MoveFailure::TakeUnavailable);
                    ctx.detail = reason;
                    AccountMoveState::Failed
                }
            },
            (AccountMoveState::Taking, AccountMoveEvent::TakeError(err)) => {
                ctx.failure = Some(MoveFailure::TakeUnavailable);
                ctx.detail = Some(err);
                AccountMoveState::Failed
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        let effects = Self::entry_effects(next_state, &ctx);
        (Snapshot::new(next_state, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn released_or_ours_takes_directly_without_asking() {
        let mut actor = EffectActor::<AccountMoveMachine>::default();
        let effects = actor.send(AccountMoveEvent::ReadRecordDone(RecordView::Released {
            seq: 2,
        }));
        assert_eq!(actor.state_attr(), "taking");
        assert_eq!(effects, vec![AccountMoveEffect::Take { force: false }]);
        actor.send(AccountMoveEvent::TakeDone(TakeResult::Taken));
        assert_eq!(actor.state_attr(), "taken");
        assert!(actor.is_done());
        assert_eq!(actor.context().output(), MoveOutput::Moved { forced: false });
    }

    #[test]
    fn direct_link_fallback_to_box_and_clean_release_flow() {
        let mut actor = EffectActor::<AccountMoveMachine>::default();
        actor.send(AccountMoveEvent::ReadRecordDone(RecordView::Held {
            seq: 5,
            device_id: "dev-b".into(),
        }));
        assert_eq!(actor.state_attr(), "dialing");
        actor.send(AccountMoveEvent::DialLinkDone(true));
        assert_eq!(actor.state_attr(), "requestingDirect");
        actor.send(AccountMoveEvent::SendDirectError);
        assert_eq!(actor.state_attr(), "requestingBox");
        actor.send(AccountMoveEvent::SendBoxDone {
            nonce: "n-1".into(),
        });
        assert_eq!(actor.state_attr(), "awaitingAccept");
        actor.send(AccountMoveEvent::Accepted);
        assert_eq!(actor.state_attr(), "awaitingRelease");
        actor.send(AccountMoveEvent::Record(RecordView::Released { seq: 6 }));
        assert_eq!(actor.state_attr(), "taking");
        actor.send(AccountMoveEvent::TakeDone(TakeResult::Taken));
        assert_eq!(actor.context().output(), MoveOutput::Moved { forced: false });
    }

    #[test]
    fn answer_window_timeout_forces_take_while_unsendable_request_fails() {
        let mut failed = EffectActor::<AccountMoveMachine>::default();
        failed.send(AccountMoveEvent::ReadRecordDone(RecordView::Absent));
        assert_eq!(failed.state_attr(), "requestingBox");
        failed.send(AccountMoveEvent::SendBoxError("down".into()));
        assert_eq!(failed.state_attr(), "failed");
        assert_eq!(
            failed.context().output(),
            MoveOutput::Failed {
                failure: MoveFailure::ChannelUnreachable,
                detail: Some("down".into()),
            }
        );

        let mut forced = EffectActor::<AccountMoveMachine>::default();
        forced.send(AccountMoveEvent::ReadRecordDone(RecordView::Held {
            seq: 1,
            device_id: "dev-b".into(),
        }));
        forced.send(AccountMoveEvent::DialLinkDone(false));
        forced.send(AccountMoveEvent::SendBoxDone {
            nonce: "n-2".into(),
        });
        forced.send(AccountMoveEvent::AnswerWindowElapsed);
        assert_eq!(forced.state_attr(), "forcing");
        forced.send(AccountMoveEvent::TakeDone(TakeResult::Taken));
        assert_eq!(forced.context().output(), MoveOutput::Moved { forced: true });
    }

    #[test]
    fn overtaken_record_restarts_up_to_max_restarts_then_fails_kept_changing() {
        let mut actor = EffectActor::<AccountMoveMachine>::default();
        for i in 1..=3u64 {
            actor.send(AccountMoveEvent::ReadRecordDone(RecordView::Held {
                seq: i,
                device_id: "dev-b".into(),
            }));
            actor.send(AccountMoveEvent::DialLinkDone(false));
            actor.send(AccountMoveEvent::SendBoxDone {
                nonce: format!("n-{i}"),
            });
            actor.send(AccountMoveEvent::Record(RecordView::Held {
                seq: i + 1,
                device_id: "dev-c".into(),
            }));
            if i <= MAX_RESTARTS as u64 {
                assert_eq!(actor.state_attr(), "reading");
            } else {
                assert_eq!(actor.state_attr(), "failed");
                assert_eq!(actor.context().failure, Some(MoveFailure::KeptChanging));
            }
        }
    }
}
