// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/updateMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UpdateMode {
    #[default]
    Default,
    Manual,
    None,
}

impl UpdateMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Manual => "manual",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    Available,
    NotAvailable,
    Downloading,
    Ready,
    Error,
}

impl UpdatePhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Checking => "checking",
            Self::Available => "available",
            Self::NotAvailable => "not-available",
            Self::Downloading => "downloading",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }

    pub const fn to_state(self) -> UpdateState {
        match self {
            Self::Idle => UpdateState::Idle,
            Self::Checking => UpdateState::Checking,
            Self::Available => UpdateState::Available,
            Self::NotAvailable => UpdateState::NotAvailable,
            Self::Downloading => UpdateState::Downloading,
            Self::Ready => UpdateState::Ready,
            Self::Error => UpdateState::Error,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateState {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    NotAvailable,
    Error,
}

impl UpdateState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Checking => "checking",
            Self::Available => "available",
            Self::Downloading => "downloading",
            Self::Ready => "ready",
            Self::NotAvailable => "notAvailable",
            Self::Error => "error",
        }
    }

    pub const fn phase_str(self) -> &'static str {
        match self {
            Self::NotAvailable => "not-available",
            other => other.as_str(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub mode: UpdateMode,
    pub current_version: String,
    pub available_version: Option<String>,
    pub percent: Option<i32>,
    pub error: Option<String>,
    pub can_install: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateContext {
    pub phase: UpdatePhase,
    pub mode: UpdateMode,
    pub current_version: String,
    pub available_version: Option<String>,
    pub percent: Option<i32>,
    pub error: Option<String>,
    pub can_install: bool,
    pub prompt_dismissed_version: Option<String>,
}

impl Default for UpdateContext {
    fn default() -> Self {
        Self {
            phase: UpdatePhase::Idle,
            mode: UpdateMode::Default,
            current_version: "0.0.0".to_string(),
            available_version: None,
            percent: None,
            error: None,
            can_install: false,
            prompt_dismissed_version: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateEvent {
    Sync { status: UpdateStatus },
    Check,
    SetMode { mode: UpdateMode },
    Download,
    Install,
    DismissPrompt,
    OpenPrompt,
}

pub struct UpdateMachine;

impl Statechart for UpdateMachine {
    type State = UpdateState;
    type Context = UpdateContext;
    type Event = UpdateEvent;
    type Input = ();

    const ID: &'static str = "appUpdate";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(UpdateState::Idle, UpdateContext::default())
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

impl HandCashChart for UpdateMachine {
    const MANIFEST_ID: &'static str = "update";
    const TOP_LEVEL_STATES: &'static [&'static str] = &[
        "idle",
        "checking",
        "available",
        "downloading",
        "ready",
        "notAvailable",
        "error",
    ];
    type Effect = ();

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let next = match (snapshot.value, event) {
            (state, UpdateEvent::SetMode { mode }) => {
                ctx.mode = mode;
                state
            }
            (state, UpdateEvent::DismissPrompt) => {
                ctx.prompt_dismissed_version = ctx.available_version.clone();
                state
            }
            (state, UpdateEvent::OpenPrompt) => {
                ctx.prompt_dismissed_version = None;
                state
            }
            (_, UpdateEvent::Sync { status }) => {
                let next_state = status.phase.to_state();
                ctx.phase = status.phase;
                ctx.mode = status.mode;
                ctx.current_version = status.current_version;
                ctx.available_version = status.available_version;
                ctx.percent = status.percent;
                ctx.error = status.error;
                ctx.can_install = status.can_install;
                next_state
            }
            (
                UpdateState::Idle
                | UpdateState::Checking
                | UpdateState::Available
                | UpdateState::NotAvailable
                | UpdateState::Error,
                UpdateEvent::Check,
            ) => {
                ctx.phase = UpdatePhase::Checking;
                ctx.error = None;
                UpdateState::Checking
            }
            (UpdateState::Available, UpdateEvent::Download) => {
                ctx.phase = UpdatePhase::Downloading;
                ctx.percent = Some(ctx.percent.unwrap_or(0));
                ctx.error = None;
                UpdateState::Downloading
            }
            _ => return (snapshot.clone(), Vec::new()),
        };
        (Snapshot::new(next, ctx), Vec::new())
    }
}

pub fn update_state_attr(state: UpdateState, context: &UpdateContext) -> String {
    let mut parts = vec![
        state.phase_str().to_string(),
        format!("mode-{}", context.mode.as_str()),
    ];
    if context.can_install {
        parts.push("can-install".to_string());
    }
    if context.can_install
        && context.phase == UpdatePhase::Ready
        && context.prompt_dismissed_version != context.available_version
    {
        parts.push("prompt-open".to_string());
    }
    parts.join(" ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateViewAction {
    Download,
    Install,
    Check,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateViewEscape {
    Dismiss,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpdateView {
    pub label: String,
    pub title: Option<String>,
    pub action: Option<UpdateViewAction>,
    pub progress: Option<f64>,
    pub escapes: Vec<UpdateViewEscape>,
}

pub fn update_view(
    state: UpdateState,
    context: &UpdateContext,
    sideload_manual: bool,
) -> Option<UpdateView> {
    match state {
        UpdateState::Idle | UpdateState::NotAvailable | UpdateState::Checking => None,
        UpdateState::Available => {
            if context.available_version.is_some()
                && context.prompt_dismissed_version == context.available_version
            {
                return None;
            }
            Some(UpdateView {
                label: "Update available".to_string(),
                title: None,
                action: Some(UpdateViewAction::Download),
                progress: None,
                escapes: vec![UpdateViewEscape::Dismiss],
            })
        }
        UpdateState::Downloading => {
            if sideload_manual {
                return Some(UpdateView {
                    label: "Opening installer…".to_string(),
                    title: None,
                    action: None,
                    progress: None,
                    escapes: Vec::new(),
                });
            }
            let pct = context.percent.unwrap_or(0).clamp(0, 100);
            Some(UpdateView {
                label: format!("Downloading {pct}%"),
                title: None,
                action: None,
                progress: Some(pct as f64 / 100.0),
                escapes: Vec::new(),
            })
        }
        UpdateState::Ready => Some(UpdateView {
            label: "Restart to update".to_string(),
            title: None,
            action: Some(UpdateViewAction::Install),
            progress: None,
            escapes: Vec::new(),
        }),
        UpdateState::Error => Some(UpdateView {
            label: "Update failed".to_string(),
            title: context.error.clone(),
            action: Some(UpdateViewAction::Check),
            progress: None,
            escapes: Vec::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> UpdateContext {
        UpdateContext {
            current_version: "1.0.0".to_string(),
            ..UpdateContext::default()
        }
    }

    #[test]
    fn hides_idle_and_not_available() {
        assert!(update_view(UpdateState::Idle, &base(), false).is_none());
        assert!(update_view(UpdateState::NotAvailable, &base(), false).is_none());
    }

    #[test]
    fn maps_available_to_a_downloadable_pill_with_later_escape() {
        let ctx = UpdateContext {
            available_version: Some("1.2.0".to_string()),
            can_install: true,
            phase: UpdatePhase::Available,
            ..base()
        };
        let view = update_view(UpdateState::Available, &ctx, false).unwrap();
        assert_eq!(view.label, "Update available");
        assert_eq!(view.action, Some(UpdateViewAction::Download));
        assert_eq!(view.escapes, vec![UpdateViewEscape::Dismiss]);
    }

    #[test]
    fn hides_available_after_later_for_that_version() {
        let ctx = UpdateContext {
            available_version: Some("1.2.0".to_string()),
            can_install: true,
            phase: UpdatePhase::Available,
            prompt_dismissed_version: Some("1.2.0".to_string()),
            ..base()
        };
        assert!(update_view(UpdateState::Available, &ctx, false).is_none());
    }

    #[test]
    fn fills_download_progress_from_percent() {
        let ctx = UpdateContext {
            available_version: Some("1.2.0".to_string()),
            percent: Some(42),
            phase: UpdatePhase::Downloading,
            ..base()
        };
        let view = update_view(UpdateState::Downloading, &ctx, false).unwrap();
        assert_eq!(view.label, "Downloading 42%");
        assert!((view.progress.unwrap() - 0.42).abs() < 1e-6);
        assert!(view.action.is_none());
    }

    #[test]
    fn uses_sideload_copy_while_opening_the_mac_installer() {
        let ctx = UpdateContext {
            available_version: Some("1.2.0".to_string()),
            phase: UpdatePhase::Downloading,
            ..base()
        };
        let view = update_view(UpdateState::Downloading, &ctx, true).unwrap();
        assert_eq!(view.label, "Opening installer…");
    }

    #[test]
    fn maps_ready_to_restart_to_update() {
        let ctx = UpdateContext {
            available_version: Some("1.2.0".to_string()),
            can_install: true,
            phase: UpdatePhase::Ready,
            ..base()
        };
        let view = update_view(UpdateState::Ready, &ctx, false).unwrap();
        assert_eq!(view.label, "Restart to update");
        assert_eq!(view.action, Some(UpdateViewAction::Install));
    }

    #[test]
    fn maps_error_to_a_short_failed_label_with_retry() {
        let ctx = UpdateContext {
            phase: UpdatePhase::Error,
            error: Some("GitHub release check failed (403)".to_string()),
            ..base()
        };
        let view = update_view(UpdateState::Error, &ctx, false).unwrap();
        assert_eq!(view.label, "Update failed");
        assert!(view.title.as_deref().unwrap().contains("403"));
        assert_eq!(view.action, Some(UpdateViewAction::Check));
    }
}
