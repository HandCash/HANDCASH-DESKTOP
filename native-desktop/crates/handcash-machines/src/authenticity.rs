// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/wallet/authenticityMachine.ts` and verdict ladder policy from `provenCache.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticityTier {
    Brc150,
    Unproven,
}

impl AuthenticityTier {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Brc150 => "brc150",
            Self::Unproven => "unproven",
        }
    }
}

pub const fn is_proven_tier(tier: AuthenticityTier) -> bool {
    matches!(tier, AuthenticityTier::Brc150)
}

/// Proven tiers never move backwards to unproven / weaker proofs.
pub const fn can_accept_verdict(current: AuthenticityTier, next: AuthenticityTier) -> bool {
    if is_proven_tier(current) && !is_proven_tier(next) {
        return false;
    }
    true
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvenVerdict {
    pub tier: AuthenticityTier,
    pub origin: Option<String>,
    pub origin_script_hash: Option<String>,
    pub verified_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticityPhase {
    Unknown,
    Verifying,
    Proven,
    Unproven,
    BudgetExhausted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticityContext {
    pub outpoint: String,
    pub tier: AuthenticityTier,
    pub origin: Option<String>,
    pub origin_script_hash: Option<String>,
    pub reason: Option<String>,
    pub verified_at: u64,
}

impl Default for AuthenticityContext {
    fn default() -> Self {
        Self {
            outpoint: String::new(),
            tier: AuthenticityTier::Unproven,
            origin: None,
            origin_script_hash: None,
            reason: None,
            verified_at: 0,
        }
    }
}

pub fn authenticity_context_from_verdict(
    outpoint: impl Into<String>,
    verdict: Option<&ProvenVerdict>,
) -> AuthenticityContext {
    AuthenticityContext {
        outpoint: outpoint.into(),
        tier: verdict.map_or(AuthenticityTier::Unproven, |v| v.tier),
        origin: verdict.and_then(|v| v.origin.clone()),
        origin_script_hash: verdict.and_then(|v| v.origin_script_hash.clone()),
        reason: None,
        verified_at: verdict.map_or(0, |v| v.verified_at),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthenticityEvent {
    Hydrate {
        verdict: ProvenVerdict,
    },
    StartVerify,
    Proven {
        tier: AuthenticityTier,
        origin: Option<String>,
        origin_script_hash: Option<String>,
        verified_at: u64,
    },
    Unproven {
        reason: Option<String>,
        verified_at: u64,
    },
    Abort,
    BudgetExhausted,
    Retry,
}

pub struct AuthenticityMachine;

impl Statechart for AuthenticityMachine {
    type State = AuthenticityPhase;
    type Context = AuthenticityContext;
    type Event = AuthenticityEvent;
    type Input = ();

    const ID: &'static str = "authenticity";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(AuthenticityPhase::Unknown, AuthenticityContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            AuthenticityPhase::Unknown => StateValue::leaf("unknown"),
            AuthenticityPhase::Verifying => StateValue::leaf("verifying"),
            AuthenticityPhase::Proven => StateValue::leaf("proven"),
            AuthenticityPhase::Unproven => StateValue::leaf("unproven"),
            AuthenticityPhase::BudgetExhausted => StateValue::leaf("budgetExhausted"),
        }
    }
}

impl HandCashChart for AuthenticityMachine {
    const MANIFEST_ID: &'static str = "authenticity";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "unknown",
        "verifying",
        "proven",
        "unproven",
        "budgetExhausted",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next_state = match (snapshot.value, event) {
            (AuthenticityPhase::Unknown, AuthenticityEvent::Hydrate { verdict }) => {
                ctx.tier = verdict.tier;
                ctx.origin = verdict.origin;
                ctx.origin_script_hash = verdict.origin_script_hash;
                ctx.verified_at = verdict.verified_at;
                ctx.reason = None;
                if is_proven_tier(verdict.tier) {
                    AuthenticityPhase::Proven
                } else {
                    AuthenticityPhase::Unproven
                }
            }
            (AuthenticityPhase::Unknown, AuthenticityEvent::StartVerify) => {
                AuthenticityPhase::Verifying
            }
            (
                AuthenticityPhase::Unknown
                | AuthenticityPhase::Verifying
                | AuthenticityPhase::Unproven,
                AuthenticityEvent::Proven {
                    tier,
                    origin,
                    origin_script_hash,
                    verified_at,
                },
            ) if can_accept_verdict(ctx.tier, tier) => {
                ctx.tier = tier;
                ctx.origin = origin;
                ctx.origin_script_hash = origin_script_hash;
                ctx.verified_at = verified_at;
                ctx.reason = None;
                AuthenticityPhase::Proven
            }
            (
                AuthenticityPhase::Proven,
                AuthenticityEvent::Proven {
                    tier,
                    origin,
                    origin_script_hash,
                    verified_at,
                },
            ) if can_accept_verdict(ctx.tier, tier) => {
                ctx.tier = tier;
                ctx.origin = origin;
                ctx.origin_script_hash = origin_script_hash;
                ctx.verified_at = verified_at;
                ctx.reason = None;
                AuthenticityPhase::Proven
            }
            (
                AuthenticityPhase::Unknown
                | AuthenticityPhase::Verifying
                | AuthenticityPhase::Unproven,
                AuthenticityEvent::Unproven {
                    reason,
                    verified_at,
                },
            ) => {
                ctx.tier = AuthenticityTier::Unproven;
                ctx.reason = reason;
                ctx.verified_at = verified_at;
                AuthenticityPhase::Unproven
            }
            (AuthenticityPhase::Verifying, AuthenticityEvent::Abort) => AuthenticityPhase::Unknown,
            (AuthenticityPhase::Verifying, AuthenticityEvent::BudgetExhausted) => {
                AuthenticityPhase::BudgetExhausted
            }
            (
                AuthenticityPhase::Unproven | AuthenticityPhase::BudgetExhausted,
                AuthenticityEvent::Retry | AuthenticityEvent::StartVerify,
            ) => AuthenticityPhase::Verifying,
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next_state, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn hydrates_a_proven_verdict_into_proven() {
        let mut actor = EffectActor::<AuthenticityMachine>::default();
        actor.send(AuthenticityEvent::Hydrate {
            verdict: ProvenVerdict {
                tier: AuthenticityTier::Brc150,
                origin: Some("aa_0".into()),
                origin_script_hash: None,
                verified_at: 1,
            },
        });
        assert_eq!(*actor.state(), AuthenticityPhase::Proven);
        assert_eq!(actor.context().tier, AuthenticityTier::Brc150);
    }

    #[test]
    fn refuses_to_downgrade_proven_to_unproven() {
        let mut actor = EffectActor::<AuthenticityMachine>::default();
        actor.send(AuthenticityEvent::Proven {
            tier: AuthenticityTier::Brc150,
            origin: Some("aa_0".into()),
            origin_script_hash: None,
            verified_at: 10,
        });
        actor.send(AuthenticityEvent::Unproven {
            reason: Some("transient".into()),
            verified_at: 20,
        });
        assert_eq!(*actor.state(), AuthenticityPhase::Proven);
        assert_eq!(actor.context().tier, AuthenticityTier::Brc150);
    }

    #[test]
    fn allows_retry_from_unproven_into_verifying() {
        let mut actor = EffectActor::<AuthenticityMachine>::default();
        actor.send(AuthenticityEvent::Unproven {
            reason: Some("miss".into()),
            verified_at: 10,
        });
        assert_eq!(*actor.state(), AuthenticityPhase::Unproven);
        actor.send(AuthenticityEvent::Retry);
        assert_eq!(*actor.state(), AuthenticityPhase::Verifying);
    }

    #[test]
    fn can_accept_verdict_encodes_monotonic_policy() {
        assert!(is_proven_tier(AuthenticityTier::Brc150));
        assert!(!can_accept_verdict(
            AuthenticityTier::Brc150,
            AuthenticityTier::Unproven
        ));
        assert!(can_accept_verdict(
            AuthenticityTier::Brc150,
            AuthenticityTier::Brc150
        ));
        assert!(can_accept_verdict(
            AuthenticityTier::Unproven,
            AuthenticityTier::Brc150
        ));
    }
}
