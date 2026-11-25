// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/grantExpiryMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

pub const GRANT_EXPIRING_SOON_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantExpiryState {
    Check,
    Active,
    Expiring,
    Expired,
    Revoked,
}

impl GrantExpiryState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Active => "active",
            Self::Expiring => "expiring",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GrantExpiryInput {
    pub expires_at: Option<i64>,
    pub now: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GrantExpiryContext {
    pub expires_at: Option<i64>,
    pub now: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantExpiryEvent {
    Tick { now: i64 },
    SetExpiry { expires_at: Option<i64>, now: i64 },
    Revoke,
}

fn evaluate(ctx: &GrantExpiryContext) -> GrantExpiryState {
    let Some(exp) = ctx.expires_at else {
        return GrantExpiryState::Active;
    };
    if ctx.now >= exp {
        GrantExpiryState::Expired
    } else if exp - ctx.now <= GRANT_EXPIRING_SOON_MS {
        GrantExpiryState::Expiring
    } else {
        GrantExpiryState::Active
    }
}

pub struct GrantExpiryMachine;

impl Statechart for GrantExpiryMachine {
    type State = GrantExpiryState;
    type Context = GrantExpiryContext;
    type Event = GrantExpiryEvent;
    type Input = GrantExpiryInput;

    const ID: &'static str = "grantExpiry";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        let ctx = GrantExpiryContext {
            expires_at: input.expires_at,
            now: input.now,
        };
        Snapshot::new(evaluate(&ctx), ctx)
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

impl HandCashChart for GrantExpiryMachine {
    const MANIFEST_ID: &'static str = "grantExpiry";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["check", "active", "expiring", "expired", "revoked"];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(state, GrantExpiryState::Expired | GrantExpiryState::Revoked)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        if Self::is_done(&snapshot.value) {
            return (snapshot.clone(), Vec::new());
        }
        let mut ctx = snapshot.context;
        let next = match (snapshot.value, event) {
            (_, GrantExpiryEvent::Revoke) => GrantExpiryState::Revoked,
            (GrantExpiryState::Active | GrantExpiryState::Expiring, GrantExpiryEvent::Tick { now }) => {
                ctx.now = now;
                evaluate(&ctx)
            }
            (
                GrantExpiryState::Active | GrantExpiryState::Expiring,
                GrantExpiryEvent::SetExpiry { expires_at, now },
            ) => {
                ctx.expires_at = expires_at;
                ctx.now = now;
                evaluate(&ctx)
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

    fn start(expires_at: Option<i64>, now: i64) -> EffectActor<GrantExpiryMachine> {
        EffectActor::new(GrantExpiryInput { expires_at, now })
    }

    #[test]
    fn never_lapses_without_an_expiry() {
        let mut a = start(None, 1000);
        a.send(GrantExpiryEvent::Tick {
            now: 9_000_000_000_000_000,
        });
        assert_eq!(*a.state(), GrantExpiryState::Active);
    }

    #[test]
    fn goes_active_expiring_expired_as_time_passes() {
        let exp = 1000 + 3 * GRANT_EXPIRING_SOON_MS;
        let mut a = start(Some(exp), 1000);
        assert_eq!(*a.state(), GrantExpiryState::Active);
        a.send(GrantExpiryEvent::Tick { now: exp - 1000 });
        assert_eq!(*a.state(), GrantExpiryState::Expiring);
        a.send(GrantExpiryEvent::Tick { now: exp });
        assert_eq!(*a.state(), GrantExpiryState::Expired);
        assert!(a.is_done());
    }

    #[test]
    fn extending_an_expiring_grant_returns_it_to_active() {
        let mut a = start(Some(2000), 1000);
        assert_eq!(*a.state(), GrantExpiryState::Expiring);
        a.send(GrantExpiryEvent::SetExpiry {
            expires_at: Some(1000 + 5 * GRANT_EXPIRING_SOON_MS),
            now: 1000,
        });
        assert_eq!(*a.state(), GrantExpiryState::Active);
    }

    #[test]
    fn revoke_ends_it_from_any_state_and_expired_cannot_be_extended() {
        let mut r = start(Some(2000), 1000);
        r.send(GrantExpiryEvent::Revoke);
        assert_eq!(*r.state(), GrantExpiryState::Revoked);
        assert!(r.is_done());

        let mut e = start(Some(500), 1000);
        assert_eq!(*e.state(), GrantExpiryState::Expired);
        e.send(GrantExpiryEvent::SetExpiry {
            expires_at: Some(9_000_000_000_000),
            now: 1000,
        });
        assert_eq!(*e.state(), GrantExpiryState::Expired);
    }
}
