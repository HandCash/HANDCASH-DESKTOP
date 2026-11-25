// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/appBrowserPageMachine.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AppBrowserPageHistory {
    pub back: bool,
    pub forward: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppBrowserLocation {
    App,
    Insecure,
    Elsewhere,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppBrowserPageState {
    Loading,
    Ready,
    Failed,
}

impl AppBrowserPageState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppBrowserPageInput {
    pub origin: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppBrowserPageContext {
    pub origin: String,
    pub url: String,
    pub history: AppBrowserPageHistory,
    pub failure: Option<String>,
    pub progress: Option<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AppBrowserPageEvent {
    Loading,
    Progress {
        value: f64,
    },
    Loaded {
        history: AppBrowserPageHistory,
    },
    Navigated {
        url: String,
        history: AppBrowserPageHistory,
    },
    Failed {
        description: String,
    },
    Back,
    Forward,
    Reload,
    Stop,
    Retry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppBrowserPageEffect {
    GoBack,
    GoForward,
    Reload,
    Stop,
    RememberUrl { url: String },
    CapturePreview,
}

pub struct AppBrowserPageMachine;

impl Statechart for AppBrowserPageMachine {
    type State = AppBrowserPageState;
    type Context = AppBrowserPageContext;
    type Event = AppBrowserPageEvent;
    type Input = AppBrowserPageInput;

    const ID: &'static str = "appBrowserPage";

    fn initial(input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(
            AppBrowserPageState::Loading,
            AppBrowserPageContext {
                origin: input.origin,
                url: input.url,
                history: AppBrowserPageHistory::default(),
                failure: None,
                progress: None,
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

impl HandCashChart for AppBrowserPageMachine {
    const MANIFEST_ID: &'static str = "appBrowserPage";
    const TOP_LEVEL_STATES: &'static [&'static str] = &["loading", "ready", "failed"];
    type Effect = AppBrowserPageEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (_, AppBrowserPageEvent::Navigated { url, history }) => {
                ctx.url = url.clone();
                ctx.history = history;
                effects.push(AppBrowserPageEffect::RememberUrl { url });
                snapshot.value
            }
            (_, AppBrowserPageEvent::Failed { description }) => {
                ctx.failure = Some(description);
                AppBrowserPageState::Failed
            }
            (_, AppBrowserPageEvent::Loading) => {
                ctx.failure = None;
                ctx.progress = None;
                AppBrowserPageState::Loading
            }
            (_, AppBrowserPageEvent::Back) if ctx.history.back => {
                effects.push(AppBrowserPageEffect::GoBack);
                snapshot.value
            }
            (_, AppBrowserPageEvent::Forward) if ctx.history.forward => {
                effects.push(AppBrowserPageEffect::GoForward);
                snapshot.value
            }
            (AppBrowserPageState::Loading, AppBrowserPageEvent::Progress { value }) => {
                ctx.progress = Some(value.round().clamp(0.0, 100.0) as u8);
                AppBrowserPageState::Loading
            }
            (AppBrowserPageState::Loading, AppBrowserPageEvent::Loaded { history }) => {
                ctx.history = history;
                effects.push(AppBrowserPageEffect::CapturePreview);
                AppBrowserPageState::Ready
            }
            (AppBrowserPageState::Loading, AppBrowserPageEvent::Stop) => {
                effects.push(AppBrowserPageEffect::Stop);
                AppBrowserPageState::Ready
            }
            (AppBrowserPageState::Ready, AppBrowserPageEvent::Loaded { history }) => {
                ctx.history = history;
                AppBrowserPageState::Ready
            }
            (AppBrowserPageState::Ready, AppBrowserPageEvent::Reload) => {
                ctx.failure = None;
                ctx.progress = None;
                effects.push(AppBrowserPageEffect::Reload);
                AppBrowserPageState::Loading
            }
            (AppBrowserPageState::Failed, AppBrowserPageEvent::Retry)
            | (AppBrowserPageState::Failed, AppBrowserPageEvent::Reload) => {
                ctx.failure = None;
                ctx.progress = None;
                effects.push(AppBrowserPageEffect::Reload);
                AppBrowserPageState::Loading
            }
            (AppBrowserPageState::Failed, AppBrowserPageEvent::Loaded { .. }) => {
                AppBrowserPageState::Failed
            }
            _ => return (snapshot.clone(), effects),
        };
        (Snapshot::new(next, ctx), effects)
    }
}

fn host_of(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(stripped) = hostport.strip_prefix('[') {
        stripped.split(']').next()?
    } else {
        hostport.split(':').next()?
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

pub fn app_browser_location(origin: &str, url: &str) -> AppBrowserLocation {
    let normalized_origin = if origin.contains("://") {
        origin.to_string()
    } else {
        format!("https://{origin}")
    };
    let Some(app) = host_of(&normalized_origin) else {
        return AppBrowserLocation::Elsewhere;
    };
    let Some(page) = host_of(url) else {
        return AppBrowserLocation::Elsewhere;
    };
    if page != app && !page.ends_with(&format!(".{app}")) {
        return AppBrowserLocation::Elsewhere;
    }
    if url.to_ascii_lowercase().starts_with("http:") {
        AppBrowserLocation::Insecure
    } else {
        AppBrowserLocation::App
    }
}

pub fn app_browser_page_host(url: &str) -> String {
    host_of(url).unwrap_or_else(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EffectActor;

    fn start() -> EffectActor<AppBrowserPageMachine> {
        EffectActor::new(AppBrowserPageInput {
            origin: "https://app.example".to_string(),
            url: "https://app.example/".to_string(),
        })
    }

    #[test]
    fn loads_measures_progress_and_captures_preview_when_ready() {
        let mut actor = start();
        assert_eq!(*actor.state(), AppBrowserPageState::Loading);
        actor.send(AppBrowserPageEvent::Progress { value: 42.4 });
        assert_eq!(actor.context().progress, Some(42));
        let effects = actor.send(AppBrowserPageEvent::Loaded {
            history: AppBrowserPageHistory {
                back: true,
                forward: false,
            },
        });
        assert_eq!(*actor.state(), AppBrowserPageState::Ready);
        assert!(actor.context().history.back);
        assert_eq!(effects, vec![AppBrowserPageEffect::CapturePreview]);
    }

    #[test]
    fn stops_a_slow_load_from_the_toolbar() {
        let mut actor = start();
        let effects = actor.send(AppBrowserPageEvent::Stop);
        assert_eq!(effects, vec![AppBrowserPageEffect::Stop]);
        assert_eq!(*actor.state(), AppBrowserPageState::Ready);
    }

    #[test]
    fn keeps_failure_card_through_trailing_loaded_then_retries() {
        let mut actor = start();
        actor.send(AppBrowserPageEvent::Failed {
            description: "net::ERR_NAME_NOT_RESOLVED".to_string(),
        });
        actor.send(AppBrowserPageEvent::Loaded {
            history: AppBrowserPageHistory::default(),
        });
        assert_eq!(*actor.state(), AppBrowserPageState::Failed);
        assert_eq!(
            actor.context().failure.as_deref(),
            Some("net::ERR_NAME_NOT_RESOLVED")
        );
        let effects = actor.send(AppBrowserPageEvent::Retry);
        assert_eq!(effects, vec![AppBrowserPageEffect::Reload]);
        assert_eq!(*actor.state(), AppBrowserPageState::Loading);
        assert_eq!(actor.context().failure, None);
    }

    #[test]
    fn only_steps_through_history_the_guest_says_exists() {
        let mut actor = start();
        let effects = actor.send(AppBrowserPageEvent::Back);
        assert!(effects.is_empty());
        let nav_effects = actor.send(AppBrowserPageEvent::Navigated {
            url: "https://app.example/play".to_string(),
            history: AppBrowserPageHistory {
                back: true,
                forward: false,
            },
        });
        assert_eq!(
            nav_effects,
            vec![AppBrowserPageEffect::RememberUrl {
                url: "https://app.example/play".to_string()
            }]
        );
        let back_effects = actor.send(AppBrowserPageEvent::Back);
        assert_eq!(back_effects, vec![AppBrowserPageEffect::GoBack]);
        assert_eq!(actor.context().url, "https://app.example/play");
    }

    #[test]
    fn app_browser_location_classifies_app_subdomains_elsewhere_and_insecure() {
        assert_eq!(
            app_browser_location("https://example.com", "https://example.com/x"),
            AppBrowserLocation::App
        );
        assert_eq!(
            app_browser_location("https://example.com", "https://play.example.com/"),
            AppBrowserLocation::App
        );
        assert_eq!(
            app_browser_location("example.com", "https://example.com/"),
            AppBrowserLocation::App
        );
        assert_eq!(
            app_browser_location("https://example.com", "https://evil-example.com/"),
            AppBrowserLocation::Elsewhere
        );
        assert_eq!(
            app_browser_location("https://example.com", "https://example.com.evil.io/"),
            AppBrowserLocation::Elsewhere
        );
        assert_eq!(
            app_browser_location("http://localhost:5173", "http://localhost:5173/"),
            AppBrowserLocation::Insecure
        );
    }
}
