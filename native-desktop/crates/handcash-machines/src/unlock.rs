// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/unlockMachine.ts` and `src/wallet/passwordPolicy.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

/// New create / restore / change-password policy.
pub const PASSWORD_MIN_LENGTH: usize = 10;

/// Existing vaults may still unlock with the pre-policy floor.
pub const UNLOCK_PASSWORD_MIN_LENGTH: usize = 8;

pub fn validate_password(password: &str) -> Option<String> {
    if password.encode_utf16().count() < PASSWORD_MIN_LENGTH {
        return Some(format!(
            "Password must be at least {PASSWORD_MIN_LENGTH} characters"
        ));
    }
    if !password.chars().any(|c| c.is_ascii_alphabetic()) {
        return Some("Password must include a letter".to_string());
    }
    if !password.chars().any(|c| c.is_ascii_digit()) {
        return Some("Password must include a number".to_string());
    }
    None
}

pub fn is_password_strong_enough(password: &str) -> bool {
    validate_password(password).is_none()
}

/// How an attempt opens the vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnlockFactor {
    Password,
    Device,
    OpenSecret,
    Create,
    Restore,
    Approved,
}

impl UnlockFactor {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Device => "device",
            Self::OpenSecret => "open-secret",
            Self::Create => "create",
            Self::Restore => "restore",
            Self::Approved => "approved",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnlockSetupFactor {
    Create,
    Restore,
    Approved,
}

impl From<UnlockSetupFactor> for UnlockFactor {
    fn from(value: UnlockSetupFactor) -> Self {
        match value {
            UnlockSetupFactor::Create => Self::Create,
            UnlockSetupFactor::Restore => Self::Restore,
            UnlockSetupFactor::Approved => Self::Approved,
        }
    }
}

/// Why the last attempt ended without opening the wallet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnlockFailReason {
    DeviceCancelled,
    DeviceFailed,
    OpenSecretFailed,
    PasswordFailed,
    SetupFailed,
    /// The vault opened, but no wallet could be held here: see `HoldingBlockedError`.
    HoldingBlocked,
}

impl UnlockFailReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DeviceCancelled => "device-cancelled",
            Self::DeviceFailed => "device-failed",
            Self::OpenSecretFailed => "open-secret-failed",
            Self::PasswordFailed => "password-failed",
            Self::SetupFailed => "setup-failed",
            Self::HoldingBlocked => "holding-blocked",
        }
    }
}

/// What the auth screen shows while the vault opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnlockProgress {
    pub title: String,
    pub lede: String,
}

impl UnlockProgress {
    pub fn new(title: impl Into<String>, lede: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            lede: lede.into(),
        }
    }
}

pub fn device_progress() -> UnlockProgress {
    UnlockProgress::new("Unlocking", "Confirm with this device…")
}

pub fn password_progress() -> UnlockProgress {
    UnlockProgress::new("Unlocking", "Opening your wallet on this device.")
}

pub fn open_secret_progress() -> UnlockProgress {
    UnlockProgress::new("Opening", "Opening your wallet on this device.")
}

pub const fn fail_reason(factor: Option<UnlockFactor>, cancelled: bool) -> UnlockFailReason {
    match factor {
        Some(UnlockFactor::Device) => {
            if cancelled {
                UnlockFailReason::DeviceCancelled
            } else {
                UnlockFailReason::DeviceFailed
            }
        }
        Some(UnlockFactor::OpenSecret) => UnlockFailReason::OpenSecretFailed,
        Some(UnlockFactor::Password) => UnlockFailReason::PasswordFailed,
        _ => UnlockFailReason::SetupFailed,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnlockState {
    Idle,
    WaitingForVisible,
    AwaitingDevice,
    Opening,
    Success,
    Failed,
}

impl UnlockState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::WaitingForVisible => "waitingForVisible",
            Self::AwaitingDevice => "awaitingDevice",
            Self::Opening => "opening",
            Self::Success => "success",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UnlockContext {
    pub password: String,
    pub error: Option<String>,
    pub factor: Option<UnlockFactor>,
    pub reason: Option<UnlockFailReason>,
    pub progress: Option<UnlockProgress>,
    /// The lock screen prompts this device by itself at most once.
    pub device_tried: bool,
    /// The holder chose a new wallet here although the host cannot record its holder.
    pub allow_unrecorded: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnlockEvent {
    Change {
        password: String,
    },
    Submit,
    Start {
        factor: UnlockSetupFactor,
        progress: UnlockProgress,
    },
    OpenSecret,
    Device {
        auto: bool,
        visible: bool,
    },
    Visible,
    Unlocked,
    Progress {
        progress: UnlockProgress,
    },
    Success,
    Fail {
        error: String,
        cancelled: bool,
        blocked: bool,
    },
    Retry,
    UseNewWallet,
}

pub struct UnlockMachine;

impl UnlockMachine {
    fn password_long_enough(ctx: &UnlockContext) -> bool {
        ctx.password.encode_utf16().count() >= UNLOCK_PASSWORD_MIN_LENGTH
    }

    fn device_allowed(ctx: &UnlockContext, auto: bool) -> bool {
        !(auto && ctx.device_tried)
    }

    fn device_shown(ctx: &UnlockContext, auto: bool, visible: bool) -> bool {
        visible && !(auto && ctx.device_tried)
    }

    fn enter_awaiting_device(ctx: &mut UnlockContext) {
        ctx.progress = Some(device_progress());
        ctx.device_tried = true;
    }

    fn enter_opening(ctx: &mut UnlockContext) {
        ctx.error = None;
        ctx.reason = None;
    }

    fn enter_failed(ctx: &mut UnlockContext) {
        ctx.progress = None;
    }

    fn record_failure(ctx: &mut UnlockContext, error: String, cancelled: bool, blocked: bool) {
        ctx.error = Some(if cancelled { String::new() } else { error });
        ctx.reason = Some(if blocked {
            UnlockFailReason::HoldingBlocked
        } else {
            fail_reason(ctx.factor, cancelled)
        });
    }
}

impl Statechart for UnlockMachine {
    const ID: &'static str = "unlockForm";
    type State = UnlockState;
    type Context = UnlockContext;
    type Event = UnlockEvent;
    type Input = ();

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(UnlockState::Idle, UnlockContext::default())
    }

    fn state_value(state: &Self::State) -> StateValue {
        StateValue::leaf(state.as_str())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (UnlockState::Idle, UnlockEvent::Change { password }) => {
                ctx.password = password;
                ctx.error = None;
                ctx.reason = None;
                UnlockState::Idle
            }
            (UnlockState::Idle, UnlockEvent::Submit) if Self::password_long_enough(&ctx) => {
                ctx.factor = Some(UnlockFactor::Password);
                ctx.progress = Some(password_progress());
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::Idle, UnlockEvent::Start { factor, progress }) => {
                ctx.factor = Some(factor.into());
                ctx.progress = Some(progress);
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::Idle, UnlockEvent::OpenSecret) => {
                ctx.factor = Some(UnlockFactor::OpenSecret);
                ctx.progress = Some(open_secret_progress());
                ctx.device_tried = true;
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::Idle, UnlockEvent::Device { auto, visible })
                if Self::device_shown(&ctx, auto, visible) =>
            {
                ctx.factor = Some(UnlockFactor::Device);
                Self::enter_awaiting_device(&mut ctx);
                UnlockState::AwaitingDevice
            }
            (UnlockState::Idle, UnlockEvent::Device { auto, .. })
                if Self::device_allowed(&ctx, auto) =>
            {
                ctx.factor = Some(UnlockFactor::Device);
                UnlockState::WaitingForVisible
            }
            (UnlockState::WaitingForVisible, UnlockEvent::Visible) => {
                Self::enter_awaiting_device(&mut ctx);
                UnlockState::AwaitingDevice
            }
            (UnlockState::WaitingForVisible, UnlockEvent::Change { password }) => {
                ctx.password = password;
                ctx.error = None;
                ctx.reason = None;
                UnlockState::WaitingForVisible
            }
            (UnlockState::WaitingForVisible, UnlockEvent::Submit)
                if Self::password_long_enough(&ctx) =>
            {
                ctx.factor = Some(UnlockFactor::Password);
                ctx.progress = Some(password_progress());
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::WaitingForVisible, UnlockEvent::Start { factor, progress }) => {
                ctx.factor = Some(factor.into());
                ctx.progress = Some(progress);
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::WaitingForVisible, UnlockEvent::Device { auto: false, .. }) => {
                Self::enter_awaiting_device(&mut ctx);
                UnlockState::AwaitingDevice
            }
            (UnlockState::AwaitingDevice, UnlockEvent::Unlocked) => {
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (
                UnlockState::AwaitingDevice,
                UnlockEvent::Fail {
                    error,
                    cancelled,
                    blocked,
                },
            ) => {
                Self::record_failure(&mut ctx, error, cancelled, blocked);
                Self::enter_failed(&mut ctx);
                UnlockState::Failed
            }
            (UnlockState::Opening, UnlockEvent::Progress { progress }) => {
                ctx.progress = Some(progress);
                UnlockState::Opening
            }
            (UnlockState::Opening, UnlockEvent::Success) => {
                ctx.progress = None;
                UnlockState::Success
            }
            (
                UnlockState::Opening,
                UnlockEvent::Fail {
                    error,
                    cancelled,
                    blocked,
                },
            ) => {
                Self::record_failure(&mut ctx, error, cancelled, blocked);
                Self::enter_failed(&mut ctx);
                UnlockState::Failed
            }
            (UnlockState::Failed, UnlockEvent::Retry) => {
                ctx.error = None;
                ctx.reason = None;
                UnlockState::Idle
            }
            (UnlockState::Failed, UnlockEvent::UseNewWallet)
                if ctx.reason == Some(UnlockFailReason::HoldingBlocked) =>
            {
                ctx.allow_unrecorded = true;
                ctx.error = None;
                ctx.reason = None;
                UnlockState::Idle
            }
            (UnlockState::Failed, UnlockEvent::Change { password }) => {
                ctx.password = password;
                ctx.error = None;
                ctx.reason = None;
                UnlockState::Idle
            }
            (UnlockState::Failed, UnlockEvent::Submit) if Self::password_long_enough(&ctx) => {
                ctx.factor = Some(UnlockFactor::Password);
                ctx.progress = Some(password_progress());
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::Failed, UnlockEvent::Start { factor, progress }) => {
                ctx.factor = Some(factor.into());
                ctx.progress = Some(progress);
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::Failed, UnlockEvent::OpenSecret) => {
                ctx.factor = Some(UnlockFactor::OpenSecret);
                ctx.progress = Some(open_secret_progress());
                ctx.device_tried = true;
                Self::enter_opening(&mut ctx);
                UnlockState::Opening
            }
            (UnlockState::Failed, UnlockEvent::Device { auto, visible })
                if Self::device_shown(&ctx, auto, visible) =>
            {
                ctx.factor = Some(UnlockFactor::Device);
                Self::enter_awaiting_device(&mut ctx);
                UnlockState::AwaitingDevice
            }
            (UnlockState::Failed, UnlockEvent::Device { auto, .. })
                if Self::device_allowed(&ctx, auto) =>
            {
                ctx.factor = Some(UnlockFactor::Device);
                UnlockState::WaitingForVisible
            }
            _ => return snapshot.clone(),
        };
        Snapshot::new(next, ctx)
    }
}

impl HandCashChart for UnlockMachine {
    const MANIFEST_ID: &'static str = "unlock";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "waitingForVisible",
        "awaitingDevice",
        "opening",
        "success",
        "failed",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        (Self::transition(snapshot, event), Vec::new())
    }

    fn can(snapshot: &Snapshot<Self::State, Self::Context>, event: &Self::Event) -> bool {
        let ctx = &snapshot.context;
        match (snapshot.value, event) {
            (UnlockState::Idle, UnlockEvent::Change { .. }) => true,
            (UnlockState::Idle, UnlockEvent::Submit) => Self::password_long_enough(ctx),
            (UnlockState::Idle, UnlockEvent::Start { .. }) => true,
            (UnlockState::Idle, UnlockEvent::OpenSecret) => true,
            (UnlockState::Idle, UnlockEvent::Device { auto, .. }) => {
                Self::device_allowed(ctx, *auto)
            }
            (UnlockState::WaitingForVisible, UnlockEvent::Visible)
            | (UnlockState::WaitingForVisible, UnlockEvent::Change { .. })
            | (UnlockState::WaitingForVisible, UnlockEvent::Start { .. }) => true,
            (UnlockState::WaitingForVisible, UnlockEvent::Submit) => Self::password_long_enough(ctx),
            (UnlockState::WaitingForVisible, UnlockEvent::Device { auto, .. }) => !*auto,
            (UnlockState::AwaitingDevice, UnlockEvent::Unlocked)
            | (UnlockState::AwaitingDevice, UnlockEvent::Fail { .. }) => true,
            (UnlockState::Opening, UnlockEvent::Progress { .. })
            | (UnlockState::Opening, UnlockEvent::Success)
            | (UnlockState::Opening, UnlockEvent::Fail { .. }) => true,
            (UnlockState::Failed, UnlockEvent::Retry)
            | (UnlockState::Failed, UnlockEvent::Change { .. })
            | (UnlockState::Failed, UnlockEvent::Start { .. })
            | (UnlockState::Failed, UnlockEvent::OpenSecret) => true,
            (UnlockState::Failed, UnlockEvent::UseNewWallet) => {
                ctx.reason == Some(UnlockFailReason::HoldingBlocked)
            }
            (UnlockState::Failed, UnlockEvent::Submit) => Self::password_long_enough(ctx),
            (UnlockState::Failed, UnlockEvent::Device { auto, .. }) => {
                Self::device_allowed(ctx, *auto)
            }
            _ => false,
        }
    }

    fn is_done(state: &Self::State) -> bool {
        matches!(state, UnlockState::Success)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn start() -> EffectActor<UnlockMachine> {
        EffectActor::default()
    }

    fn almost_ready() -> UnlockProgress {
        UnlockProgress::new("Almost ready", "Opening your wallet on this device.")
    }

    #[test]
    fn password_shorter_than_unlock_floor_never_starts() {
        let mut actor = start();
        actor.send(UnlockEvent::Change {
            password: "short".into(),
        });
        actor.send(UnlockEvent::Submit);
        assert_eq!(*actor.state(), UnlockState::Idle);
    }

    #[test]
    fn password_unlock_opens_with_progress_and_ends_in_success() {
        let mut actor = start();
        actor.send(UnlockEvent::Change {
            password: "correct horse".into(),
        });
        actor.send(UnlockEvent::Submit);
        assert_eq!(*actor.state(), UnlockState::Opening);
        assert_eq!(actor.context().progress, Some(password_progress()));
        actor.send(UnlockEvent::Progress {
            progress: almost_ready(),
        });
        assert_eq!(actor.context().progress, Some(almost_ready()));
        actor.send(UnlockEvent::Success);
        assert_eq!(*actor.state(), UnlockState::Success);
        assert!(actor.is_done());
        assert_eq!(actor.context().progress, None);
    }

    #[test]
    fn wrong_password_fails_with_reason_and_can_be_tried_again_at_once() {
        let mut actor = start();
        actor.send(UnlockEvent::Change {
            password: "wrong password".into(),
        });
        actor.send(UnlockEvent::Submit);
        actor.send(UnlockEvent::Fail {
            error: "Wrong password".into(),
            cancelled: false,
            blocked: false,
        });
        assert_eq!(*actor.state(), UnlockState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some("Wrong password"));
        assert_eq!(actor.context().reason, Some(UnlockFailReason::PasswordFailed));
        assert_eq!(actor.context().progress, None);
        actor.send(UnlockEvent::Submit);
        assert_eq!(*actor.state(), UnlockState::Opening);
        assert_eq!(actor.context().error, None);
        assert_eq!(actor.context().reason, None);
    }

    #[test]
    fn typing_after_a_failure_clears_it() {
        let mut actor = start();
        actor.send(UnlockEvent::Change {
            password: "wrong password".into(),
        });
        actor.send(UnlockEvent::Submit);
        actor.send(UnlockEvent::Fail {
            error: "Wrong password".into(),
            cancelled: false,
            blocked: false,
        });
        actor.send(UnlockEvent::Change {
            password: "wrong password!".into(),
        });
        assert_eq!(*actor.state(), UnlockState::Idle);
        assert_eq!(actor.context().password, "wrong password!");
        assert_eq!(actor.context().error, None);
        assert_eq!(actor.context().reason, None);
    }

    #[test]
    fn touch_id_with_no_password_typed_is_chart_state_not_idle() {
        let mut actor = start();
        actor.send(UnlockEvent::Device {
            auto: true,
            visible: true,
        });
        assert_eq!(*actor.state(), UnlockState::AwaitingDevice);
        assert_eq!(actor.context().factor, Some(UnlockFactor::Device));
        assert_eq!(actor.context().progress, Some(device_progress()));
        assert!(actor.context().device_tried);
        actor.send(UnlockEvent::Unlocked);
        assert_eq!(*actor.state(), UnlockState::Opening);
        actor.send(UnlockEvent::Success);
        assert_eq!(*actor.state(), UnlockState::Success);
    }

    #[test]
    fn lock_screen_waits_for_window_visible_before_prompting() {
        let mut actor = start();
        actor.send(UnlockEvent::Device {
            auto: true,
            visible: false,
        });
        assert_eq!(*actor.state(), UnlockState::WaitingForVisible);
        assert_eq!(actor.context().progress, None);
        assert!(!actor.context().device_tried);
        actor.send(UnlockEvent::Visible);
        assert_eq!(*actor.state(), UnlockState::AwaitingDevice);
        assert!(actor.context().device_tried);
    }

    #[test]
    fn while_waiting_for_window_password_and_fingerprint_button_still_work() {
        let mut typed = start();
        typed.send(UnlockEvent::Device {
            auto: true,
            visible: false,
        });
        typed.send(UnlockEvent::Change {
            password: "correct horse".into(),
        });
        typed.send(UnlockEvent::Submit);
        assert_eq!(*typed.state(), UnlockState::Opening);
        assert_eq!(typed.context().factor, Some(UnlockFactor::Password));
        typed.send(UnlockEvent::Visible);
        assert_eq!(*typed.state(), UnlockState::Opening);

        let mut clicked = start();
        clicked.send(UnlockEvent::Device {
            auto: true,
            visible: false,
        });
        clicked.send(UnlockEvent::Device {
            auto: true,
            visible: true,
        });
        assert_eq!(*clicked.state(), UnlockState::WaitingForVisible);
        clicked.send(UnlockEvent::Device {
            auto: false,
            visible: true,
        });
        assert_eq!(*clicked.state(), UnlockState::AwaitingDevice);
    }

    #[test]
    fn cancelling_touch_id_fails_quietly_and_does_not_reprompt_auto() {
        let mut actor = start();
        actor.send(UnlockEvent::Device {
            auto: true,
            visible: true,
        });
        actor.send(UnlockEvent::Fail {
            error: "cancelled".into(),
            cancelled: true,
            blocked: false,
        });
        assert_eq!(*actor.state(), UnlockState::Failed);
        assert_eq!(actor.context().error.as_deref(), Some(""));
        assert_eq!(actor.context().reason, Some(UnlockFailReason::DeviceCancelled));
        assert!(!actor.can(&UnlockEvent::Device {
            auto: true,
            visible: true,
        }));
        actor.send(UnlockEvent::Device {
            auto: false,
            visible: true,
        });
        assert_eq!(*actor.state(), UnlockState::AwaitingDevice);
    }

    #[test]
    fn device_failure_keeps_message_and_reason() {
        let mut actor = start();
        actor.send(UnlockEvent::Device {
            auto: false,
            visible: true,
        });
        actor.send(UnlockEvent::Fail {
            error: "Touch ID is locked".into(),
            cancelled: false,
            blocked: false,
        });
        assert_eq!(actor.context().error.as_deref(), Some("Touch ID is locked"));
        assert_eq!(actor.context().reason, Some(UnlockFailReason::DeviceFailed));
    }

    #[test]
    fn failure_while_opening_after_touch_id_is_still_device_failure() {
        let mut actor = start();
        actor.send(UnlockEvent::Device {
            auto: true,
            visible: true,
        });
        actor.send(UnlockEvent::Unlocked);
        actor.send(UnlockEvent::Fail {
            error: "balance unavailable".into(),
            cancelled: false,
            blocked: false,
        });
        assert_eq!(actor.context().reason, Some(UnlockFailReason::DeviceFailed));
    }

    #[test]
    fn open_secret_opens_with_its_own_progress_and_fails_with_its_reason() {
        let mut actor = start();
        actor.send(UnlockEvent::OpenSecret);
        assert_eq!(*actor.state(), UnlockState::Opening);
        assert_eq!(actor.context().factor, Some(UnlockFactor::OpenSecret));
        assert_eq!(actor.context().progress, Some(open_secret_progress()));
        actor.send(UnlockEvent::Fail {
            error: "vault unreadable".into(),
            cancelled: false,
            blocked: false,
        });
        assert_eq!(
            actor.context().reason,
            Some(UnlockFailReason::OpenSecretFailed)
        );
        assert!(actor.can(&UnlockEvent::OpenSecret));
    }

    #[test]
    fn vault_that_cannot_hold_fails_with_choices_never_success() {
        let mut actor = start();
        actor.send(UnlockEvent::OpenSecret);
        actor.send(UnlockEvent::Progress {
            progress: almost_ready(),
        });
        actor.send(UnlockEvent::Fail {
            error: "Another device holds this vault".into(),
            cancelled: false,
            blocked: true,
        });
        assert_eq!(*actor.state(), UnlockState::Failed);
        assert_eq!(actor.context().reason, Some(UnlockFailReason::HoldingBlocked));
        assert_eq!(actor.context().factor, Some(UnlockFactor::OpenSecret));
        assert_eq!(actor.context().progress, None);
        assert!(!actor.context().allow_unrecorded);
        actor.send(UnlockEvent::Retry);
        assert_eq!(*actor.state(), UnlockState::Idle);
        assert_eq!(actor.context().reason, None);
    }

    #[test]
    fn choosing_new_wallet_allowed_only_after_blocked_holding() {
        let mut other = start();
        other.send(UnlockEvent::OpenSecret);
        other.send(UnlockEvent::Fail {
            error: "vault unreadable".into(),
            cancelled: false,
            blocked: false,
        });
        assert!(!other.can(&UnlockEvent::UseNewWallet));

        let mut actor = start();
        actor.send(UnlockEvent::OpenSecret);
        actor.send(UnlockEvent::Fail {
            error: "blocked".into(),
            cancelled: false,
            blocked: true,
        });
        assert!(actor.can(&UnlockEvent::UseNewWallet));
        actor.send(UnlockEvent::UseNewWallet);
        assert_eq!(*actor.state(), UnlockState::Idle);
        assert!(actor.context().allow_unrecorded);
        assert_eq!(actor.context().factor, Some(UnlockFactor::OpenSecret));
        assert_eq!(actor.context().error, None);
        assert_eq!(actor.context().reason, None);
        assert!(actor.can(&UnlockEvent::OpenSecret));
        actor.send(UnlockEvent::OpenSecret);
        actor.send(UnlockEvent::Success);
        assert_eq!(*actor.state(), UnlockState::Success);
    }

    #[test]
    fn only_one_attempt_runs_at_a_time() {
        let mut actor = start();
        actor.send(UnlockEvent::OpenSecret);
        assert!(!actor.can(&UnlockEvent::OpenSecret));
        assert!(!actor.can(&UnlockEvent::Device {
            auto: false,
            visible: true,
        }));
        assert!(!actor.can(&UnlockEvent::Submit));

        let mut device = start();
        device.send(UnlockEvent::Device {
            auto: true,
            visible: true,
        });
        assert!(!device.can(&UnlockEvent::Device {
            auto: false,
            visible: true,
        }));
        assert!(!device.can(&UnlockEvent::OpenSecret));
    }

    #[test]
    fn create_restore_and_approved_signin_open_with_progress() {
        let progress = UnlockProgress::new(
            "Signing in",
            "Installing the wallet your other device approved.",
        );
        let mut actor = start();
        actor.send(UnlockEvent::Start {
            factor: UnlockSetupFactor::Approved,
            progress: progress.clone(),
        });
        assert_eq!(*actor.state(), UnlockState::Opening);
        assert_eq!(actor.context().factor, Some(UnlockFactor::Approved));
        assert_eq!(actor.context().progress, Some(progress));
        actor.send(UnlockEvent::Fail {
            error: "transfer expired".into(),
            cancelled: false,
            blocked: false,
        });
        assert_eq!(actor.context().reason, Some(UnlockFailReason::SetupFailed));
        actor.send(UnlockEvent::Start {
            factor: UnlockSetupFactor::Restore,
            progress: UnlockProgress::new("Restoring wallet", "Verifying your backup."),
        });
        assert_eq!(*actor.state(), UnlockState::Opening);
        assert_eq!(actor.context().factor, Some(UnlockFactor::Restore));
    }
}
