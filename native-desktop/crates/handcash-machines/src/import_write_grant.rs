// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/importWriteGrantMachine.ts` (Packet F).

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportReviewDecision {
    Allow,
    Deny,
    Timeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportWriteRefusal {
    Denied,
    Timeout,
    Revoked,
    Unauthorized,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportWriteGrantState {
    PendingReview,
    Authorizing,
    Committing,
    Accepted,
    Refused,
}

impl ImportWriteGrantState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PendingReview => "pendingReview",
            Self::Authorizing => "authorizing",
            Self::Committing => "committing",
            Self::Accepted => "accepted",
            Self::Refused => "refused",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportWriteGrantInput {
    pub authorized: bool,
}

impl Default for ImportWriteGrantInput {
    fn default() -> Self {
        Self { authorized: true }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportWriteGrantContext {
    pub authorized: bool,
    pub refusal: Option<ImportWriteRefusal>,
    pub receipt: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportWriteGrantOutput {
    pub receipt: Option<String>,
    pub refusal: Option<ImportWriteRefusal>,
}

impl ImportWriteGrantContext {
    pub fn output(&self) -> ImportWriteGrantOutput {
        ImportWriteGrantOutput {
            receipt: self.receipt.clone(),
            refusal: self.refusal,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportWriteGrantEvent {
    ReviewDone {
        decision: ImportReviewDecision,
        /// Optional synchronous authorization check evaluated in `authorizing`;
        /// `None` falls back to `context.authorized`.
        authorized_now: Option<bool>,
    },
    ReviewError,
    Revoke,
    PersistDone {
        receipt: String,
    },
    PersistError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportWriteGrantEffect {
    Persist,
}

pub struct ImportWriteGrantMachine;

impl Statechart for ImportWriteGrantMachine {
    type State = ImportWriteGrantState;
    type Context = ImportWriteGrantContext;
    type Event = ImportWriteGrantEvent;
    type Input = ImportWriteGrantInput;

    const ID: &'static str = "importWriteGrant";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            ImportWriteGrantState::PendingReview,
            ImportWriteGrantContext {
                authorized: input.authorized,
                refusal: None,
                receipt: None,
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

impl HandCashChart for ImportWriteGrantMachine {
    const MANIFEST_ID: &'static str = "importWriteGrant";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "pendingReview",
        "authorizing",
        "committing",
        "accepted",
        "refused",
    ];
    type Effect = ImportWriteGrantEffect;

    fn is_done(state: &Self::State) -> bool {
        matches!(
            state,
            ImportWriteGrantState::Accepted | ImportWriteGrantState::Refused
        )
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (
                ImportWriteGrantState::PendingReview,
                ImportWriteGrantEvent::ReviewDone {
                    decision,
                    authorized_now,
                },
            ) => match decision {
                ImportReviewDecision::Allow => {
                    // Transient `authorizing` state evaluates `authorized` immediately.
                    let ok = authorized_now.unwrap_or(ctx.authorized);
                    if ok {
                        effects.push(ImportWriteGrantEffect::Persist);
                        ImportWriteGrantState::Committing
                    } else {
                        ctx.refusal = Some(ImportWriteRefusal::Unauthorized);
                        ImportWriteGrantState::Refused
                    }
                }
                ImportReviewDecision::Timeout => {
                    ctx.refusal = Some(ImportWriteRefusal::Timeout);
                    ImportWriteGrantState::Refused
                }
                ImportReviewDecision::Deny => {
                    ctx.refusal = Some(ImportWriteRefusal::Denied);
                    ImportWriteGrantState::Refused
                }
            },
            (ImportWriteGrantState::PendingReview, ImportWriteGrantEvent::ReviewError) => {
                ctx.refusal = Some(ImportWriteRefusal::Denied);
                ImportWriteGrantState::Refused
            }
            (ImportWriteGrantState::PendingReview, ImportWriteGrantEvent::Revoke) => {
                ctx.refusal = Some(ImportWriteRefusal::Revoked);
                ImportWriteGrantState::Refused
            }
            (ImportWriteGrantState::Committing, ImportWriteGrantEvent::PersistDone { receipt }) => {
                ctx.receipt = Some(receipt);
                ImportWriteGrantState::Accepted
            }
            (ImportWriteGrantState::Committing, ImportWriteGrantEvent::PersistError) => {
                ctx.refusal = Some(ImportWriteRefusal::Failed);
                ImportWriteGrantState::Refused
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
    fn writes_once_after_user_approves_and_scope_still_holds() {
        let mut actor = EffectActor::<ImportWriteGrantMachine>::new(ImportWriteGrantInput {
            authorized: true,
        });
        let effects = actor.send(ImportWriteGrantEvent::ReviewDone {
            decision: ImportReviewDecision::Allow,
            authorized_now: None,
        });
        assert_eq!(*actor.state(), ImportWriteGrantState::Committing);
        assert_eq!(effects, vec![ImportWriteGrantEffect::Persist]);
        actor.send(ImportWriteGrantEvent::PersistDone {
            receipt: "saved".to_string(),
        });
        assert_eq!(*actor.state(), ImportWriteGrantState::Accepted);
        assert!(actor.is_done());
        assert_eq!(
            actor.context().output(),
            ImportWriteGrantOutput {
                receipt: Some("saved".to_string()),
                refusal: None,
            }
        );
    }

    #[test]
    fn deny_timeout_and_review_error_write_nothing() {
        for (decision, refusal) in [
            (ImportReviewDecision::Deny, ImportWriteRefusal::Denied),
            (ImportReviewDecision::Timeout, ImportWriteRefusal::Timeout),
        ] {
            let mut actor = EffectActor::<ImportWriteGrantMachine>::default();
            let effects = actor.send(ImportWriteGrantEvent::ReviewDone {
                decision,
                authorized_now: None,
            });
            assert_eq!(*actor.state(), ImportWriteGrantState::Refused);
            assert!(actor.is_done());
            assert_eq!(actor.context().output().refusal, Some(refusal));
            assert!(effects.is_empty());
        }

        let mut actor = EffectActor::<ImportWriteGrantMachine>::default();
        let effects = actor.send(ImportWriteGrantEvent::ReviewError);
        assert_eq!(*actor.state(), ImportWriteGrantState::Refused);
        assert_eq!(
            actor.context().output().refusal,
            Some(ImportWriteRefusal::Denied)
        );
        assert!(effects.is_empty());
    }

    #[test]
    fn revoking_while_review_waits_refuses_even_if_approval_arrives_later() {
        let mut actor = EffectActor::<ImportWriteGrantMachine>::default();
        assert_eq!(*actor.state(), ImportWriteGrantState::PendingReview);
        actor.send(ImportWriteGrantEvent::Revoke);
        let effects = actor.send(ImportWriteGrantEvent::ReviewDone {
            decision: ImportReviewDecision::Allow,
            authorized_now: Some(true),
        });
        assert_eq!(*actor.state(), ImportWriteGrantState::Refused);
        assert_eq!(
            actor.context().output().refusal,
            Some(ImportWriteRefusal::Revoked)
        );
        assert!(effects.is_empty());
    }

    #[test]
    fn approval_whose_scope_lapsed_writes_nothing() {
        let mut actor = EffectActor::<ImportWriteGrantMachine>::new(ImportWriteGrantInput {
            authorized: false,
        });
        let effects = actor.send(ImportWriteGrantEvent::ReviewDone {
            decision: ImportReviewDecision::Allow,
            authorized_now: None,
        });
        assert_eq!(*actor.state(), ImportWriteGrantState::Refused);
        assert_eq!(
            actor.context().output().refusal,
            Some(ImportWriteRefusal::Unauthorized)
        );
        assert!(effects.is_empty());
    }

    #[test]
    fn failing_write_is_refused_not_accepted() {
        let mut actor = EffectActor::<ImportWriteGrantMachine>::default();
        actor.send(ImportWriteGrantEvent::ReviewDone {
            decision: ImportReviewDecision::Allow,
            authorized_now: Some(true),
        });
        actor.send(ImportWriteGrantEvent::PersistError);
        assert_eq!(*actor.state(), ImportWriteGrantState::Refused);
        assert!(actor.is_done());
        assert_eq!(
            actor.context().output(),
            ImportWriteGrantOutput {
                receipt: None,
                refusal: Some(ImportWriteRefusal::Failed),
            }
        );
    }
}
