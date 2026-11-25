// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/emailRecoveryMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmailRecoveryEnrollingState {
    OpeningBrowser,
    WaitingForGoogle,
    MailingShare,
    ConfirmingMailbox,
    DepositingHostShare,
}

impl EmailRecoveryEnrollingState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpeningBrowser => "openingBrowser",
            Self::WaitingForGoogle => "waitingForGoogle",
            Self::MailingShare => "mailingShare",
            Self::ConfirmingMailbox => "confirmingMailbox",
            Self::DepositingHostShare => "depositingHostShare",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmailRecoveryLoginState {
    OpeningBrowser,
    WaitingForGoogle,
    WaitingForChallenge,
    Comparing,
    DelayedRecovery,
    AwaitingMailbox,
    Restoring,
}

impl EmailRecoveryLoginState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpeningBrowser => "openingBrowser",
            Self::WaitingForGoogle => "waitingForGoogle",
            Self::WaitingForChallenge => "waitingForChallenge",
            Self::Comparing => "comparing",
            Self::DelayedRecovery => "delayedRecovery",
            Self::AwaitingMailbox => "awaitingMailbox",
            Self::Restoring => "restoring",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmailRecoveryState {
    Idle,
    Enrolling(EmailRecoveryEnrollingState),
    Ready,
    Login(EmailRecoveryLoginState),
    Complete,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EmailRecoveryContext {
    pub email: Option<String>,
    pub comparison_code: Option<String>,
    pub release_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmailRecoveryEvent {
    Enroll,
    BrowserOpened,
    GoogleVerified { email: String },
    MailSent,
    ConfirmMailbox,
    MailConfirmed,
    Login,
    DeviceFound,
    DeviceChallenged { code: String },
    DeviceApproved,
    WaitForRecovery { release_at: u64 },
    RecoveryReleased,
    Restored,
    Cancel,
    Fail { message: String },
}

pub struct EmailRecoveryMachine;

impl Statechart for EmailRecoveryMachine {
    type State = EmailRecoveryState;
    type Context = EmailRecoveryContext;
    type Event = EmailRecoveryEvent;
    type Input = ();

    const ID: &'static str = "emailRecovery";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(EmailRecoveryState::Idle, EmailRecoveryContext::default())
    }

    fn transition(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> Snapshot<Self::State, Self::Context> {
        Self::step(snapshot, event).0
    }

    fn state_value(state: &Self::State) -> StateValue {
        match state {
            EmailRecoveryState::Idle => StateValue::leaf("idle"),
            EmailRecoveryState::Enrolling(sub) => {
                StateValue::compound("enrolling", StateValue::leaf(sub.as_str()))
            }
            EmailRecoveryState::Ready => StateValue::leaf("ready"),
            EmailRecoveryState::Login(sub) => {
                StateValue::compound("login", StateValue::leaf(sub.as_str()))
            }
            EmailRecoveryState::Complete => StateValue::leaf("complete"),
            EmailRecoveryState::Failed => StateValue::leaf("failed"),
        }
    }
}

fn clear_transient(ctx: &mut EmailRecoveryContext) {
    ctx.comparison_code = None;
    ctx.release_at = None;
    ctx.error = None;
}

impl HandCashChart for EmailRecoveryMachine {
    const MANIFEST_ID: &'static str = "emailRecovery";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["idle", "enrolling", "ready", "login", "complete", "failed"];
    type Effect = ();

    fn is_done(state: &Self::State) -> bool {
        matches!(state, EmailRecoveryState::Complete)
    }

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        if Self::is_done(&snapshot.value) {
            return (snapshot.clone(), Vec::new());
        }
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (_, EmailRecoveryEvent::Fail { message }) => {
                ctx.error = Some(message);
                EmailRecoveryState::Failed
            }
            (_, EmailRecoveryEvent::Cancel) => {
                clear_transient(&mut ctx);
                EmailRecoveryState::Idle
            }
            (EmailRecoveryState::Idle | EmailRecoveryState::Failed, EmailRecoveryEvent::Enroll) => {
                clear_transient(&mut ctx);
                EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::OpeningBrowser)
            }
            (
                EmailRecoveryState::Idle | EmailRecoveryState::Ready | EmailRecoveryState::Failed,
                EmailRecoveryEvent::Login,
            ) => {
                clear_transient(&mut ctx);
                EmailRecoveryState::Login(EmailRecoveryLoginState::OpeningBrowser)
            }
            (
                EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::OpeningBrowser),
                EmailRecoveryEvent::BrowserOpened,
            ) => EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::WaitingForGoogle),
            (
                EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::WaitingForGoogle),
                EmailRecoveryEvent::GoogleVerified { email },
            ) => {
                ctx.email = Some(email);
                ctx.error = None;
                EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::MailingShare)
            }
            (
                EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::MailingShare),
                EmailRecoveryEvent::MailSent,
            ) => EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::ConfirmingMailbox),
            (
                EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::ConfirmingMailbox),
                EmailRecoveryEvent::ConfirmMailbox,
            ) => EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::DepositingHostShare),
            (
                EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::DepositingHostShare),
                EmailRecoveryEvent::MailConfirmed,
            ) => EmailRecoveryState::Ready,
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::OpeningBrowser),
                EmailRecoveryEvent::BrowserOpened,
            ) => EmailRecoveryState::Login(EmailRecoveryLoginState::WaitingForGoogle),
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::WaitingForGoogle),
                EmailRecoveryEvent::DeviceFound,
            ) => EmailRecoveryState::Login(EmailRecoveryLoginState::WaitingForChallenge),
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::WaitingForGoogle),
                EmailRecoveryEvent::WaitForRecovery { release_at },
            ) => {
                ctx.release_at = Some(release_at);
                ctx.error = None;
                EmailRecoveryState::Login(EmailRecoveryLoginState::DelayedRecovery)
            }
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::WaitingForChallenge),
                EmailRecoveryEvent::DeviceChallenged { code },
            ) => {
                ctx.comparison_code = Some(code);
                ctx.error = None;
                EmailRecoveryState::Login(EmailRecoveryLoginState::Comparing)
            }
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::Comparing),
                EmailRecoveryEvent::DeviceApproved,
            ) => EmailRecoveryState::Login(EmailRecoveryLoginState::Restoring),
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::DelayedRecovery),
                EmailRecoveryEvent::RecoveryReleased,
            ) => EmailRecoveryState::Login(EmailRecoveryLoginState::AwaitingMailbox),
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::AwaitingMailbox),
                EmailRecoveryEvent::ConfirmMailbox,
            ) => EmailRecoveryState::Login(EmailRecoveryLoginState::Restoring),
            (
                EmailRecoveryState::Login(EmailRecoveryLoginState::Restoring),
                EmailRecoveryEvent::Restored,
            ) => EmailRecoveryState::Complete,
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    #[test]
    fn does_not_become_ready_before_google_and_mailbox_confirmation() {
        let mut actor = EffectActor::<EmailRecoveryMachine>::default();
        actor.send(EmailRecoveryEvent::Enroll);
        actor.send(EmailRecoveryEvent::BrowserOpened);
        actor.send(EmailRecoveryEvent::GoogleVerified {
            email: "person@example.com".to_string(),
        });
        assert_eq!(
            *actor.state(),
            EmailRecoveryState::Enrolling(EmailRecoveryEnrollingState::MailingShare)
        );
        actor.send(EmailRecoveryEvent::MailSent);
        actor.send(EmailRecoveryEvent::ConfirmMailbox);
        actor.send(EmailRecoveryEvent::MailConfirmed);
        assert_eq!(*actor.state(), EmailRecoveryState::Ready);
    }

    #[test]
    fn names_device_approval_and_delayed_recovery_as_separate_paths() {
        let mut approved = EffectActor::<EmailRecoveryMachine>::default();
        approved.send(EmailRecoveryEvent::Login);
        approved.send(EmailRecoveryEvent::BrowserOpened);
        approved.send(EmailRecoveryEvent::DeviceFound);
        assert_eq!(
            *approved.state(),
            EmailRecoveryState::Login(EmailRecoveryLoginState::WaitingForChallenge)
        );

        let mut delayed = EffectActor::<EmailRecoveryMachine>::default();
        delayed.send(EmailRecoveryEvent::Login);
        delayed.send(EmailRecoveryEvent::BrowserOpened);
        delayed.send(EmailRecoveryEvent::WaitForRecovery { release_at: 10_000 });
        assert_eq!(
            *delayed.state(),
            EmailRecoveryState::Login(EmailRecoveryLoginState::DelayedRecovery)
        );
    }
}
