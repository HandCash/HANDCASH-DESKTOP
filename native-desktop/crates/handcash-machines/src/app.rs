// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/appMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chain {
    Main,
    Test,
}

impl Chain {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Test => "test",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletProfile {
    pub handle: String,
    pub identity_key: String,
    pub address: String,
    pub chain: Chain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BalanceFreshness {
    Cached,
    Read,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppState {
    Boot,
    Onboarding,
    Locked,
    Ready,
    Failure,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppContext {
    pub profile: Option<WalletProfile>,
    pub balance_sats: u64,
    /// True while the newly selected wallet's Toolbox balance is being read.
    pub balance_pending: bool,
    /// Cached paint is never a fresh local-state observation.
    pub balance_freshness: BalanceFreshness,
    pub error: Option<String>,
    pub bridge_online: bool,
    pub version: String,
    /// When true, onboarding only offers restore (toolbox orphans, no vault).
    pub recovery_only: bool,
}

impl Default for AppContext {
    fn default() -> Self {
        Self {
            profile: None,
            balance_sats: 0,
            balance_pending: false,
            balance_freshness: BalanceFreshness::Cached,
            error: None,
            bridge_online: false,
            version: "0.0.0".to_string(),
            recovery_only: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppEvent {
    Bootstrapped {
        has_vault: bool,
        version: String,
        orphaned_toolbox: bool,
    },
    Created {
        profile: WalletProfile,
        balance_sats: u64,
    },
    Unlocked {
        profile: WalletProfile,
        balance_sats: u64,
    },
    Lock,
    Refreshed {
        balance_sats: u64,
    },
    Bridge {
        online: bool,
    },
    Fail {
        error: String,
    },
    ClearError,
    Sent {
        balance_sats: u64,
    },
    AccountSwitchStarted {
        profile: WalletProfile,
    },
    AccountSwitched {
        profile: WalletProfile,
        balance_sats: u64,
    },
}

const RESTORE_ONLY_ERROR: &str = "This device has wallet data but missing unlock keys. Restore with a recovery phrase, BRC-140 shares, or emergency key — creating a new wallet is blocked.";

pub struct AppMachine;

impl Statechart for AppMachine {
    type State = AppState;
    type Context = AppContext;
    type Event = AppEvent;
    type Input = ();

    const ID: &'static str = "appSession";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(AppState::Boot, AppContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            AppState::Boot => StateValue::leaf("boot"),
            AppState::Onboarding => StateValue::leaf("onboarding"),
            AppState::Locked => StateValue::leaf("locked"),
            AppState::Ready => StateValue::leaf("ready"),
            AppState::Failure => StateValue::leaf("failure"),
        }
    }
}

impl HandCashChart for AppMachine {
    const MANIFEST_ID: &'static str = "app";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["boot", "onboarding", "locked", "ready", "failure"];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        if let AppEvent::Bridge { online } = event {
            if ctx.bridge_online != online {
                ctx.bridge_online = online;
                return (Snapshot::new(snapshot.value, ctx), Vec::new());
            }
            return (snapshot.clone(), Vec::new());
        }

        let next_state = match (snapshot.value, event) {
            (
                AppState::Boot | AppState::Failure,
                AppEvent::Bootstrapped {
                    has_vault,
                    version,
                    orphaned_toolbox,
                },
            ) => {
                ctx.version = version;
                if has_vault {
                    ctx.recovery_only = false;
                    ctx.error = None;
                    AppState::Locked
                } else if orphaned_toolbox {
                    ctx.recovery_only = true;
                    ctx.error = Some(RESTORE_ONLY_ERROR.to_string());
                    AppState::Onboarding
                } else {
                    ctx.recovery_only = false;
                    ctx.error = None;
                    AppState::Onboarding
                }
            }
            (AppState::Boot, AppEvent::Fail { error }) => {
                ctx.error = Some(error);
                AppState::Failure
            }
            (
                AppState::Onboarding,
                AppEvent::Created {
                    profile,
                    balance_sats,
                },
            ) => {
                ctx.profile = Some(profile);
                ctx.balance_sats = balance_sats;
                ctx.balance_pending = false;
                ctx.recovery_only = false;
                ctx.error = None;
                AppState::Ready
            }
            (AppState::Onboarding, AppEvent::Fail { error }) => {
                ctx.error = Some(error);
                AppState::Onboarding
            }
            (AppState::Onboarding, AppEvent::ClearError) => {
                ctx.error = None;
                AppState::Onboarding
            }
            (
                AppState::Locked,
                AppEvent::Unlocked {
                    profile,
                    balance_sats,
                },
            ) => {
                ctx.profile = Some(profile);
                ctx.balance_sats = balance_sats;
                ctx.balance_pending = false;
                ctx.error = None;
                AppState::Ready
            }
            (
                AppState::Locked,
                AppEvent::Created {
                    profile,
                    balance_sats,
                },
            ) => {
                ctx.profile = Some(profile);
                ctx.balance_sats = balance_sats;
                ctx.balance_pending = false;
                ctx.recovery_only = false;
                ctx.error = None;
                AppState::Ready
            }
            (AppState::Locked, AppEvent::Fail { error }) => {
                ctx.error = Some(error);
                AppState::Locked
            }
            (AppState::Locked, AppEvent::ClearError) => {
                ctx.error = None;
                AppState::Locked
            }
            (AppState::Ready, AppEvent::Lock) => {
                ctx.profile = None;
                ctx.balance_sats = 0;
                ctx.balance_pending = false;
                ctx.balance_freshness = BalanceFreshness::Cached;
                AppState::Locked
            }
            (AppState::Ready, AppEvent::Sent { balance_sats }) => {
                ctx.balance_sats = balance_sats;
                ctx.balance_pending = false;
                ctx.balance_freshness = BalanceFreshness::Read;
                ctx.error = None;
                AppState::Ready
            }
            (AppState::Ready, AppEvent::Refreshed { balance_sats }) => {
                ctx.balance_sats = balance_sats;
                ctx.balance_pending = false;
                ctx.balance_freshness = BalanceFreshness::Read;
                AppState::Ready
            }
            (AppState::Ready, AppEvent::AccountSwitchStarted { profile }) => {
                ctx.profile = Some(profile);
                ctx.balance_sats = 0;
                ctx.balance_pending = true;
                ctx.balance_freshness = BalanceFreshness::Cached;
                ctx.error = None;
                AppState::Ready
            }
            (
                AppState::Ready,
                AppEvent::AccountSwitched {
                    profile,
                    balance_sats,
                },
            ) => {
                ctx.profile = Some(profile);
                ctx.balance_sats = balance_sats;
                ctx.balance_pending = false;
                ctx.balance_freshness = BalanceFreshness::Cached;
                ctx.error = None;
                AppState::Ready
            }
            (AppState::Ready, AppEvent::Fail { error }) => {
                ctx.error = Some(error);
                AppState::Ready
            }
            (AppState::Ready, AppEvent::ClearError) => {
                ctx.error = None;
                AppState::Ready
            }
            (AppState::Failure, AppEvent::ClearError) => {
                ctx.error = None;
                AppState::Boot
            }
            _ => return (snapshot.clone(), Vec::new()),
        };

        (Snapshot::new(next_state, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn primary_profile() -> WalletProfile {
        WalletProfile {
            handle: "brandon".into(),
            identity_key: format!("02{}", "1".repeat(64)),
            address: "1Primary".into(),
            chain: Chain::Main,
        }
    }

    fn secondary_profile() -> WalletProfile {
        WalletProfile {
            handle: "brandon".into(),
            identity_key: format!("03{}", "2".repeat(64)),
            address: "1Secondary".into(),
            chain: Chain::Main,
        }
    }

    fn ready_actor(balance_sats: u64) -> EffectActor<AppMachine> {
        let mut actor = EffectActor::<AppMachine>::default();
        actor.send(AppEvent::Bootstrapped {
            has_vault: true,
            version: "test".into(),
            orphaned_toolbox: false,
        });
        actor.send(AppEvent::Unlocked {
            profile: primary_profile(),
            balance_sats,
        });
        actor
    }

    // --- appMachine.test.ts ---

    #[test]
    fn paints_a_selected_wallet_cache_without_treating_it_as_a_fresh_read() {
        let mut actor = ready_actor(12_345);
        let mut next = primary_profile();
        next.identity_key = "next-wallet".into();

        actor.send(AppEvent::AccountSwitchStarted {
            profile: next.clone(),
        });
        assert_eq!(actor.context().balance_sats, 0);
        assert!(actor.context().balance_pending);

        actor.send(AppEvent::AccountSwitched {
            profile: next.clone(),
            balance_sats: 700,
        });
        assert_eq!(*actor.state(), AppState::Ready);
        assert_eq!(actor.context().profile.as_ref(), Some(&next));
        assert_eq!(actor.context().balance_sats, 700);
        assert!(!actor.context().balance_pending);
        assert_eq!(actor.context().balance_freshness, BalanceFreshness::Cached);

        actor.send(AppEvent::Refreshed { balance_sats: 650 });
        assert_eq!(actor.context().balance_sats, 650);
        assert!(!actor.context().balance_pending);
        assert_eq!(actor.context().balance_freshness, BalanceFreshness::Read);
    }

    #[test]
    fn takes_the_balance_a_send_reports_while_ready() {
        let mut actor = ready_actor(12_345);
        actor.send(AppEvent::Fail {
            error: "earlier".into(),
        });
        actor.send(AppEvent::Sent {
            balance_sats: 9_000,
        });
        assert_eq!(*actor.state(), AppState::Ready);
        assert_eq!(actor.context().balance_sats, 9_000);
        assert!(!actor.context().balance_pending);
        assert_eq!(actor.context().error, None);
    }

    #[test]
    fn clears_a_pending_balance_when_a_send_reports_one() {
        let mut actor = ready_actor(12_345);
        actor.send(AppEvent::AccountSwitchStarted {
            profile: primary_profile(),
        });
        assert!(actor.context().balance_pending);
        actor.send(AppEvent::Sent { balance_sats: 500 });
        assert_eq!(actor.context().balance_sats, 500);
        assert!(!actor.context().balance_pending);
    }

    #[test]
    fn has_no_sending_state() {
        assert_eq!(
            AppMachine::TOP_LEVEL_STATES,
            &["boot", "onboarding", "locked", "ready", "failure"]
        );
    }

    #[test]
    fn leaving_failure_on_bootstrapped_mirrors_boot() {
        let failed = || {
            let mut actor = EffectActor::<AppMachine>::default();
            actor.send(AppEvent::Fail {
                error: "boot broke".into(),
            });
            assert_eq!(*actor.state(), AppState::Failure);
            actor
        };

        let mut a = failed();
        a.send(AppEvent::Bootstrapped {
            has_vault: true,
            version: "2.0.0".into(),
            orphaned_toolbox: false,
        });
        assert_eq!(*a.state(), AppState::Locked);
        assert_eq!(a.context().version, "2.0.0");
        assert_eq!(a.context().error, None);

        let mut b = failed();
        b.send(AppEvent::Bootstrapped {
            has_vault: false,
            version: "2.0.0".into(),
            orphaned_toolbox: true,
        });
        assert_eq!(*b.state(), AppState::Onboarding);
        assert!(b.context().recovery_only);
        assert!(b
            .context()
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("missing unlock keys"));

        let mut c = failed();
        c.send(AppEvent::Bootstrapped {
            has_vault: false,
            version: "2.0.0".into(),
            orphaned_toolbox: false,
        });
        assert_eq!(*c.state(), AppState::Onboarding);
        assert!(!c.context().recovery_only);
        assert_eq!(c.context().error, None);

        let mut d = failed();
        d.send(AppEvent::ClearError);
        assert_eq!(*d.state(), AppState::Boot);
        assert_eq!(d.context().error, None);
    }

    // --- appMachine.accountSwitch.test.ts ---

    #[test]
    fn hides_the_prior_balance_until_the_selected_runtime_answers() {
        let mut actor = ready_actor(12_345);
        let sec = secondary_profile();
        actor.send(AppEvent::AccountSwitchStarted {
            profile: sec.clone(),
        });
        assert_eq!(actor.context().profile.as_ref(), Some(&sec));
        assert_eq!(actor.context().balance_sats, 0);
        assert!(actor.context().balance_pending);

        actor.send(AppEvent::AccountSwitched {
            profile: sec.clone(),
            balance_sats: 678,
        });
        assert_eq!(actor.context().profile.as_ref(), Some(&sec));
        assert_eq!(actor.context().balance_sats, 678);
        assert!(!actor.context().balance_pending);
    }

    #[test]
    fn stays_ready_with_the_balance_pending_when_a_switch_follows_a_send() {
        let mut actor = ready_actor(12_345);
        actor.send(AppEvent::Sent {
            balance_sats: 10_000,
        });
        actor.send(AppEvent::AccountSwitchStarted {
            profile: secondary_profile(),
        });
        assert_eq!(*actor.state(), AppState::Ready);
        assert_eq!(actor.context().balance_sats, 0);
        assert!(actor.context().balance_pending);
    }
}
