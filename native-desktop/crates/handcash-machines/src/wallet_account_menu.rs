// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/walletAccountMenuMachine.ts`.

use crate::account_move::AccountMovePhase;
use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AfterSwitch {
    #[default]
    Stay,
    Profile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalletAccountMenuState {
    Closed,
    Open,
    Moving,
    Switching,
    Creating,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalletAccountMenuContext {
    pub target_account_index: Option<u32>,
    pub after_switch: AfterSwitch,
    pub move_phase: Option<AccountMovePhase>,
    pub error: Option<String>,
    pub displaced_while_busy: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalletAccountMenuEvent {
    Toggle,
    Close,
    Choose { account_index: u32 },
    EditProfile { account_index: u32, active: bool },
    Switched,
    Create,
    Created,
    Move { account_index: u32 },
    MovePhase { phase: AccountMovePhase },
    Moved,
    Displaced { next_account_index: Option<u32> },
    Fail { error: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalletAccountMenuEffect {
    OpenProfile,
    RecheckDisplacement,
}

pub struct WalletAccountMenuMachine;

impl WalletAccountMenuMachine {
    fn settle_displacement(
        ctx: &mut WalletAccountMenuContext,
        effects: &mut Vec<WalletAccountMenuEffect>,
    ) {
        if ctx.displaced_while_busy {
            ctx.displaced_while_busy = false;
            effects.push(WalletAccountMenuEffect::RecheckDisplacement);
        }
    }
}

impl Statechart for WalletAccountMenuMachine {
    type State = WalletAccountMenuState;
    type Context = WalletAccountMenuContext;
    type Event = WalletAccountMenuEvent;
    type Input = ();

    const ID: &'static str = "walletAccountMenu";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            WalletAccountMenuState::Closed,
            WalletAccountMenuContext::default(),
        )
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            WalletAccountMenuState::Closed => StateValue::leaf("closed"),
            WalletAccountMenuState::Open => StateValue::leaf("open"),
            WalletAccountMenuState::Moving => StateValue::leaf("moving"),
            WalletAccountMenuState::Switching => StateValue::leaf("switching"),
            WalletAccountMenuState::Creating => StateValue::leaf("creating"),
        }
    }
}

impl HandCashChart for WalletAccountMenuMachine {
    const MANIFEST_ID: &'static str = "walletAccountMenu";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["closed", "open", "moving", "switching", "creating"];
    type Effect = WalletAccountMenuEffect;

    fn can(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: &Self::Event,
    ) -> bool {
        matches!(
            (snapshot.value, event),
            (
                WalletAccountMenuState::Closed,
                WalletAccountMenuEvent::Toggle | WalletAccountMenuEvent::Displaced { .. }
            ) | (
                WalletAccountMenuState::Open,
                WalletAccountMenuEvent::Toggle
                    | WalletAccountMenuEvent::Close
                    | WalletAccountMenuEvent::Displaced { .. }
                    | WalletAccountMenuEvent::Choose { .. }
                    | WalletAccountMenuEvent::EditProfile { .. }
                    | WalletAccountMenuEvent::Create
                    | WalletAccountMenuEvent::Move { .. }
            ) | (
                WalletAccountMenuState::Moving,
                WalletAccountMenuEvent::Displaced { .. }
                    | WalletAccountMenuEvent::MovePhase { .. }
                    | WalletAccountMenuEvent::Moved
                    | WalletAccountMenuEvent::Fail { .. }
            ) | (
                WalletAccountMenuState::Switching,
                WalletAccountMenuEvent::Displaced { .. }
                    | WalletAccountMenuEvent::Switched
                    | WalletAccountMenuEvent::Fail { .. }
            ) | (
                WalletAccountMenuState::Creating,
                WalletAccountMenuEvent::Displaced { .. }
                    | WalletAccountMenuEvent::Created
                    | WalletAccountMenuEvent::Fail { .. }
            )
        )
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next_state = match (snapshot.value, event) {
            (WalletAccountMenuState::Closed, WalletAccountMenuEvent::Toggle) => {
                Self::settle_displacement(&mut ctx, &mut effects);
                WalletAccountMenuState::Open
            }
            (
                WalletAccountMenuState::Closed | WalletAccountMenuState::Open,
                WalletAccountMenuEvent::Displaced { .. },
            ) => {
                ctx.move_phase = None;
                ctx.error = None;
                ctx.displaced_while_busy = false;
                snapshot.value
            }
            (
                WalletAccountMenuState::Open,
                WalletAccountMenuEvent::Toggle | WalletAccountMenuEvent::Close,
            ) => {
                Self::settle_displacement(&mut ctx, &mut effects);
                WalletAccountMenuState::Closed
            }
            (WalletAccountMenuState::Open, WalletAccountMenuEvent::Choose { account_index }) => {
                ctx.target_account_index = Some(account_index);
                ctx.after_switch = AfterSwitch::Stay;
                ctx.error = None;
                WalletAccountMenuState::Switching
            }
            (
                WalletAccountMenuState::Open,
                WalletAccountMenuEvent::EditProfile {
                    account_index,
                    active,
                },
            ) => {
                if active {
                    ctx.error = None;
                    effects.push(WalletAccountMenuEffect::OpenProfile);
                    Self::settle_displacement(&mut ctx, &mut effects);
                    WalletAccountMenuState::Closed
                } else {
                    ctx.target_account_index = Some(account_index);
                    ctx.after_switch = AfterSwitch::Profile;
                    ctx.error = None;
                    WalletAccountMenuState::Switching
                }
            }
            (WalletAccountMenuState::Open, WalletAccountMenuEvent::Create) => {
                ctx.error = None;
                WalletAccountMenuState::Creating
            }
            (WalletAccountMenuState::Open, WalletAccountMenuEvent::Move { account_index }) => {
                ctx.target_account_index = Some(account_index);
                ctx.move_phase = Some(AccountMovePhase::Reading);
                ctx.error = None;
                WalletAccountMenuState::Moving
            }
            (WalletAccountMenuState::Moving, WalletAccountMenuEvent::Displaced { .. }) => {
                ctx.displaced_while_busy = true;
                WalletAccountMenuState::Moving
            }
            (WalletAccountMenuState::Moving, WalletAccountMenuEvent::MovePhase { phase }) => {
                ctx.move_phase = Some(phase);
                WalletAccountMenuState::Moving
            }
            (WalletAccountMenuState::Moving, WalletAccountMenuEvent::Moved) => {
                ctx.after_switch = AfterSwitch::Stay;
                ctx.move_phase = None;
                WalletAccountMenuState::Switching
            }
            (WalletAccountMenuState::Moving, WalletAccountMenuEvent::Fail { error }) => {
                ctx.target_account_index = None;
                ctx.move_phase = None;
                ctx.error = Some(error);
                Self::settle_displacement(&mut ctx, &mut effects);
                WalletAccountMenuState::Open
            }
            (WalletAccountMenuState::Switching, WalletAccountMenuEvent::Displaced { .. }) => {
                ctx.displaced_while_busy = true;
                WalletAccountMenuState::Switching
            }
            (WalletAccountMenuState::Switching, WalletAccountMenuEvent::Switched) => {
                let open_profile = ctx.after_switch == AfterSwitch::Profile;
                ctx.target_account_index = None;
                ctx.after_switch = AfterSwitch::Stay;
                ctx.error = None;
                if open_profile {
                    effects.push(WalletAccountMenuEffect::OpenProfile);
                }
                Self::settle_displacement(&mut ctx, &mut effects);
                WalletAccountMenuState::Closed
            }
            (WalletAccountMenuState::Switching, WalletAccountMenuEvent::Fail { error }) => {
                ctx.after_switch = AfterSwitch::Stay;
                ctx.error = Some(error);
                Self::settle_displacement(&mut ctx, &mut effects);
                WalletAccountMenuState::Open
            }
            (WalletAccountMenuState::Creating, WalletAccountMenuEvent::Displaced { .. }) => {
                ctx.displaced_while_busy = true;
                WalletAccountMenuState::Creating
            }
            (WalletAccountMenuState::Creating, WalletAccountMenuEvent::Created) => {
                ctx.error = None;
                Self::settle_displacement(&mut ctx, &mut effects);
                WalletAccountMenuState::Closed
            }
            (WalletAccountMenuState::Creating, WalletAccountMenuEvent::Fail { error }) => {
                ctx.error = Some(error);
                Self::settle_displacement(&mut ctx, &mut effects);
                WalletAccountMenuState::Open
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next_state, ctx), effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn start() -> EffectActor<WalletAccountMenuMachine> {
        let mut actor = EffectActor::<WalletAccountMenuMachine>::default();
        actor.send(WalletAccountMenuEvent::Toggle);
        actor
    }

    fn count(actor: &EffectActor<WalletAccountMenuMachine>, eff: WalletAccountMenuEffect) -> usize {
        actor.effects().iter().filter(|&&e| e == eff).count()
    }

    #[test]
    fn editing_active_account_profile_opens_publish_identity_at_once() {
        let mut actor = start();
        actor.send(WalletAccountMenuEvent::EditProfile {
            account_index: 0,
            active: true,
        });
        assert_eq!(actor.state_attr(), "closed");
        assert_eq!(count(&actor, WalletAccountMenuEffect::OpenProfile), 1);
    }

    #[test]
    fn editing_another_accounts_profile_switches_first_then_opens_publish_identity() {
        let mut actor = start();
        actor.send(WalletAccountMenuEvent::EditProfile {
            account_index: 2,
            active: false,
        });
        assert_eq!(actor.state_attr(), "switching");
        assert_eq!(actor.context().target_account_index, Some(2));
        assert_eq!(count(&actor, WalletAccountMenuEffect::OpenProfile), 0);
        actor.send(WalletAccountMenuEvent::Switched);
        assert_eq!(actor.state_attr(), "closed");
        assert_eq!(count(&actor, WalletAccountMenuEffect::OpenProfile), 1);
    }

    #[test]
    fn plain_switch_or_failed_one_never_opens_publish_identity() {
        let mut actor = start();
        actor.send(WalletAccountMenuEvent::EditProfile {
            account_index: 2,
            active: false,
        });
        actor.send(WalletAccountMenuEvent::Fail {
            error: "locked".into(),
        });
        assert_eq!(actor.state_attr(), "open");
        actor.send(WalletAccountMenuEvent::Choose { account_index: 1 });
        actor.send(WalletAccountMenuEvent::Switched);
        assert_eq!(actor.state_attr(), "closed");
        assert_eq!(count(&actor, WalletAccountMenuEffect::OpenProfile), 0);
    }

    #[test]
    fn moving_an_account_here_reports_each_phase_then_switches_to_it() {
        let mut actor = start();
        actor.send(WalletAccountMenuEvent::Move { account_index: 3 });
        assert_eq!(actor.state_attr(), "moving");
        assert_eq!(actor.context().target_account_index, Some(3));
        assert_eq!(actor.context().move_phase, Some(AccountMovePhase::Reading));
        actor.send(WalletAccountMenuEvent::MovePhase {
            phase: AccountMovePhase::AwaitingAccept,
        });
        assert_eq!(
            actor.context().move_phase,
            Some(AccountMovePhase::AwaitingAccept)
        );
        actor.send(WalletAccountMenuEvent::MovePhase {
            phase: AccountMovePhase::Forcing,
        });
        actor.send(WalletAccountMenuEvent::Moved);
        assert_eq!(actor.state_attr(), "switching");
        assert_eq!(actor.context().target_account_index, Some(3));
        assert_eq!(actor.context().move_phase, None);
        actor.send(WalletAccountMenuEvent::Switched);
        assert_eq!(actor.state_attr(), "closed");
    }

    #[test]
    fn failed_move_returns_to_open_menu_with_reason_and_no_target() {
        let mut actor = start();
        actor.send(WalletAccountMenuEvent::Move { account_index: 3 });
        actor.send(WalletAccountMenuEvent::Fail {
            error: "offline".into(),
        });
        assert_eq!(actor.state_attr(), "open");
        assert_eq!(actor.context().target_account_index, None);
        assert_eq!(actor.context().move_phase, None);
        assert_eq!(actor.context().error.as_deref(), Some("offline"));
    }

    #[test]
    fn keeps_a_displaced_wallet_visible_whether_another_local_wallet_exists_or_not() {
        for next_account_index in [Some(2), None] {
            let mut actor = start();
            actor.send(WalletAccountMenuEvent::Displaced { next_account_index });
            assert_eq!(actor.state_attr(), "open");
            assert_eq!(actor.context().target_account_index, None);
            actor.send(WalletAccountMenuEvent::Toggle);
            actor.send(WalletAccountMenuEvent::Displaced { next_account_index });
            assert_eq!(actor.state_attr(), "closed");
            assert_eq!(actor.context().target_account_index, None);
            assert_eq!(count(&actor, WalletAccountMenuEffect::RecheckDisplacement), 0);
        }
    }

    #[test]
    fn displacement_during_switching_is_checked_again_once_switch_lands_or_fails() {
        for (settle, expected) in [
            (WalletAccountMenuEvent::Switched, "closed"),
            (
                WalletAccountMenuEvent::Fail {
                    error: "locked".into(),
                },
                "open",
            ),
        ] {
            let mut actor = start();
            actor.send(WalletAccountMenuEvent::Choose { account_index: 1 });
            actor.send(WalletAccountMenuEvent::Displaced {
                next_account_index: Some(2),
            });
            assert_eq!(actor.state_attr(), "switching");
            assert_eq!(count(&actor, WalletAccountMenuEffect::RecheckDisplacement), 0);
            actor.send(settle);
            assert_eq!(actor.state_attr(), expected);
            assert!(!actor.context().displaced_while_busy);
            assert_eq!(count(&actor, WalletAccountMenuEffect::RecheckDisplacement), 1);
        }
    }

    #[test]
    fn displacement_during_move_survives_into_switch_and_is_checked_when_it_settles() {
        let mut actor = start();
        actor.send(WalletAccountMenuEvent::Move { account_index: 3 });
        actor.send(WalletAccountMenuEvent::Displaced {
            next_account_index: None,
        });
        assert_eq!(actor.state_attr(), "moving");
        actor.send(WalletAccountMenuEvent::Moved);
        assert_eq!(actor.state_attr(), "switching");
        assert!(actor.context().displaced_while_busy);
        assert_eq!(count(&actor, WalletAccountMenuEffect::RecheckDisplacement), 0);
        actor.send(WalletAccountMenuEvent::Switched);
        assert_eq!(count(&actor, WalletAccountMenuEffect::RecheckDisplacement), 1);

        let mut failed = start();
        failed.send(WalletAccountMenuEvent::Move { account_index: 3 });
        failed.send(WalletAccountMenuEvent::Displaced {
            next_account_index: Some(1),
        });
        failed.send(WalletAccountMenuEvent::Fail {
            error: "offline".into(),
        });
        assert_eq!(failed.state_attr(), "open");
        assert_eq!(count(&failed, WalletAccountMenuEffect::RecheckDisplacement), 1);
    }

    #[test]
    fn displacement_during_creating_is_checked_again_once_new_wallet_opens_or_fails() {
        for (settle, expected) in [
            (WalletAccountMenuEvent::Created, "closed"),
            (
                WalletAccountMenuEvent::Fail {
                    error: "offline".into(),
                },
                "open",
            ),
        ] {
            let mut actor = start();
            actor.send(WalletAccountMenuEvent::Create);
            actor.send(WalletAccountMenuEvent::Displaced {
                next_account_index: Some(2),
            });
            assert_eq!(actor.state_attr(), "creating");
            actor.send(settle);
            assert_eq!(actor.state_attr(), expected);
            assert_eq!(count(&actor, WalletAccountMenuEffect::RecheckDisplacement), 1);
        }
    }

    #[test]
    fn accepts_displacement_in_every_state_and_never_rechecks_without_one() {
        let mut actor = start();
        for step in [
            WalletAccountMenuEvent::Toggle,
            WalletAccountMenuEvent::Toggle,
            WalletAccountMenuEvent::Choose { account_index: 1 },
            WalletAccountMenuEvent::Switched,
            WalletAccountMenuEvent::Toggle,
            WalletAccountMenuEvent::Create,
            WalletAccountMenuEvent::Created,
        ] {
            assert!(actor.can(&WalletAccountMenuEvent::Displaced {
                next_account_index: Some(1)
            }));
            actor.send(step);
        }
        assert_eq!(count(&actor, WalletAccountMenuEffect::RecheckDisplacement), 0);
    }
}
