// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/swapSettleMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleOutcome {
    Swapped,
    Refunded,
    Declined,
    Expired,
    Missed,
    Unsent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapSettleState {
    Negotiating,
    Presigning,
    Locking,
    Locked,
    Claiming,
    Refunding,
    Settled,
    Refunded,
    Ended,
    Missed,
}

impl SwapSettleState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Negotiating => "negotiating",
            Self::Presigning => "presigning",
            Self::Locking => "locking",
            Self::Locked => "locked",
            Self::Claiming => "claiming",
            Self::Refunding => "refunding",
            Self::Settled => "settled",
            Self::Refunded => "refunded",
            Self::Ended => "ended",
            Self::Missed => "missed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwapSettleEvent {
    Presign,
    Fund,
    Claim,
    Refund,
    RefundFee,
    Done { outcome: SettleOutcome },
    Ok,
    Fail { error: String },
}

pub struct SwapSettleMachine;

impl SwapSettleMachine {
    pub fn resolve_state(phase: SwapSettleState) -> Snapshot<SwapSettleState, ()> {
        Snapshot::new(phase, ())
    }
}

impl Statechart for SwapSettleMachine {
    type State = SwapSettleState;
    type Context = ();
    type Event = SwapSettleEvent;
    type Input = ();

    const ID: &'static str = "swapSettle";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(SwapSettleState::Negotiating, ())
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

fn next_phase(state: SwapSettleState, event: &SwapSettleEvent) -> Option<SwapSettleState> {
    use SettleOutcome as O;
    use SwapSettleEvent as E;
    use SwapSettleState as S;
    match (state, event) {
        (S::Negotiating | S::Presigning, E::Presign) => Some(S::Presigning),
        (S::Negotiating | S::Presigning | S::Locking, E::Fund) => Some(S::Locking),
        (S::Negotiating | S::Presigning | S::Locking, E::Done { outcome: O::Declined | O::Expired }) => {
            Some(S::Ended)
        }
        (S::Locking, E::Ok) => Some(S::Locked),
        (S::Locking, E::Fail { .. }) => Some(S::Locking),
        (S::Locked, E::Claim) => Some(S::Claiming),
        (S::Locked, E::Refund | E::RefundFee) => Some(S::Refunding),
        (S::Locked, E::Done { outcome: O::Swapped }) => Some(S::Settled),
        (S::Locked, E::Done { outcome: O::Refunded }) => Some(S::Refunded),
        (S::Locked, E::Done { outcome: O::Missed }) => Some(S::Missed),
        (S::Locked, E::Done { outcome: O::Unsent }) => Some(S::Ended),
        (S::Claiming | S::Refunding, E::Ok | E::Fail { .. }) => Some(S::Locked),
        _ => None,
    }
}

impl HandCashChart for SwapSettleMachine {
    const MANIFEST_ID: &'static str = "swapSettle";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "negotiating",
        "presigning",
        "locking",
        "locked",
        "claiming",
        "refunding",
        "settled",
        "refunded",
        "ended",
        "missed",
    ];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(
            state,
            SwapSettleState::Settled
                | SwapSettleState::Refunded
                | SwapSettleState::Ended
                | SwapSettleState::Missed
        )
    }

    fn can(snapshot: &Snapshot<Self::State, Self::Context>, event: &Self::Event) -> bool {
        next_phase(snapshot.value, event).is_some()
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        match next_phase(snapshot.value, &event) {
            Some(next) => (Snapshot::new(next, ()), Vec::new()),
            None => (snapshot.clone(), Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn can(phase: SwapSettleState, event: SwapSettleEvent) -> bool {
        SwapSettleMachine::can(&SwapSettleMachine::resolve_state(phase), &event)
    }

    #[test]
    fn locks_at_most_once() {
        assert!(can(SwapSettleState::Negotiating, SwapSettleEvent::Fund));
        assert!(can(SwapSettleState::Presigning, SwapSettleEvent::Fund));
        assert!(can(SwapSettleState::Locking, SwapSettleEvent::Fund));
        for phase in [
            SwapSettleState::Locked,
            SwapSettleState::Claiming,
            SwapSettleState::Refunding,
            SwapSettleState::Settled,
            SwapSettleState::Refunded,
            SwapSettleState::Ended,
            SwapSettleState::Missed,
        ] {
            assert!(!can(phase, SwapSettleEvent::Fund), "phase={phase:?}");
        }
    }

    #[test]
    fn claims_and_refunds_only_after_this_wallet_locked() {
        for event in [
            SwapSettleEvent::Claim,
            SwapSettleEvent::Refund,
            SwapSettleEvent::RefundFee,
        ] {
            assert!(!can(SwapSettleState::Negotiating, event.clone()));
            assert!(!can(SwapSettleState::Presigning, event.clone()));
            assert!(!can(SwapSettleState::Locking, event.clone()));
            assert!(can(SwapSettleState::Locked, event));
        }
    }

    #[test]
    fn ends_without_a_lock_only_when_declined_or_expired() {
        assert!(can(
            SwapSettleState::Negotiating,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Declined
            }
        ));
        assert!(can(
            SwapSettleState::Presigning,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Expired
            }
        ));
        assert!(!can(
            SwapSettleState::Negotiating,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Swapped
            }
        ));
        assert!(!can(
            SwapSettleState::Negotiating,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Refunded
            }
        ));
        assert!(can(
            SwapSettleState::Locking,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Declined
            }
        ));
        assert!(can(
            SwapSettleState::Locking,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Expired
            }
        ));
        assert!(!can(
            SwapSettleState::Locking,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Swapped
            }
        ));
        assert!(!can(
            SwapSettleState::Locked,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Declined
            }
        ));
        assert!(!can(
            SwapSettleState::Locked,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Expired
            }
        ));
    }

    #[test]
    fn names_each_locked_outcome_honestly() {
        let end = |outcome: SettleOutcome| {
            SwapSettleMachine::transition(
                &SwapSettleMachine::resolve_state(SwapSettleState::Locked),
                SwapSettleEvent::Done { outcome },
            )
        };
        assert_eq!(end(SettleOutcome::Swapped).value, SwapSettleState::Settled);
        assert_eq!(end(SettleOutcome::Refunded).value, SwapSettleState::Refunded);
        assert_eq!(end(SettleOutcome::Missed).value, SwapSettleState::Missed);
        assert_eq!(end(SettleOutcome::Unsent).value, SwapSettleState::Ended);
        assert!(!can(
            SwapSettleState::Negotiating,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Unsent
            }
        ));
        assert!(SwapSettleMachine::is_done(&end(SettleOutcome::Swapped).value));
    }

    #[test]
    fn runs_a_whole_swap_presign_fund_claim_settle() {
        let mut snap = SwapSettleMachine::resolve_state(SwapSettleState::Negotiating);
        for event in [
            SwapSettleEvent::Presign,
            SwapSettleEvent::Presign,
            SwapSettleEvent::Fund,
            SwapSettleEvent::Fail {
                error: "offline".to_string(),
            },
            SwapSettleEvent::Fund,
            SwapSettleEvent::Ok,
            SwapSettleEvent::Claim,
            SwapSettleEvent::Fail {
                error: "mempool".to_string(),
            },
            SwapSettleEvent::Claim,
            SwapSettleEvent::Ok,
        ] {
            assert!(SwapSettleMachine::can(&snap, &event), "event={event:?}");
            snap = SwapSettleMachine::transition(&snap, event);
        }
        assert_eq!(snap.value, SwapSettleState::Locked);
        snap = SwapSettleMachine::transition(
            &snap,
            SwapSettleEvent::Done {
                outcome: SettleOutcome::Swapped,
            },
        );
        assert_eq!(snap.value, SwapSettleState::Settled);
    }
}
