// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Lossless port of `src/machines/appBrowserMachine.ts` and `src/wallet/appBrowserUrl.ts`.

use crate::{HandCashChart, Snapshot, StateValue, Statechart};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppBrowserRefusalReason {
    Empty,
    Unparsable,
    SchemeNotAllowed,
    InsecureHost,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppBrowserTarget {
    Open {
        url: String,
        host: String,
    },
    Refuse {
        reason: AppBrowserRefusalReason,
        message: String,
    },
}

fn is_loopback(hostname: &str) -> bool {
    matches!(hostname, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

fn has_scheme(trimmed: &str) -> bool {
    let Some(colon) = trimmed.find(':') else {
        return false;
    };
    let prefix = &trimmed[..colon];
    if prefix.is_empty() || !prefix.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    if !prefix
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return false;
    }
    // `host:port` is a bare host, not a scheme.
    let after = &trimmed[colon + 1..];
    if !prefix.contains('/') && !after.is_empty() {
        let digits_len = after.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits_len > 0 {
            let next = after.as_bytes().get(digits_len).copied();
            if matches!(next, None | Some(b'/') | Some(b'?') | Some(b'#')) {
                return false;
            }
        }
    }
    true
}

pub fn decide_app_browser_target(raw: &str) -> AppBrowserTarget {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return AppBrowserTarget::Refuse {
            reason: AppBrowserRefusalReason::Empty,
            message: "Enter a web address".to_string(),
        };
    }
    let candidate = if has_scheme(trimmed) {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let Some((scheme_raw, rest)) = candidate.split_once(':') else {
        return AppBrowserTarget::Refuse {
            reason: AppBrowserRefusalReason::Unparsable,
            message: "That is not a web address".to_string(),
        };
    };
    let protocol = format!("{}:", scheme_raw.to_ascii_lowercase());
    if protocol != "https:" && protocol != "http:" {
        return AppBrowserTarget::Refuse {
            reason: AppBrowserRefusalReason::SchemeNotAllowed,
            message: format!("The wallet browser only opens https pages, not {protocol}"),
        };
    }
    let Some(after_slashes) = rest.strip_prefix("//") else {
        return AppBrowserTarget::Refuse {
            reason: AppBrowserRefusalReason::Unparsable,
            message: "That is not a web address".to_string(),
        };
    };
    let split_idx = after_slashes
        .find(['/', '?', '#'])
        .unwrap_or(after_slashes.len());
    let authority = &after_slashes[..split_idx];
    let suffix = &after_slashes[split_idx..];
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let (hostname_raw, port_raw) = if let Some(rest_v6) = hostport.strip_prefix('[') {
        let Some(end) = rest_v6.find(']') else {
            return AppBrowserTarget::Refuse {
                reason: AppBrowserRefusalReason::Unparsable,
                message: "That is not a web address".to_string(),
            };
        };
        let h = &hostport[..=end + 1];
        let p = rest_v6[end + 1..].strip_prefix(':');
        (h, p)
    } else if let Some((h, p)) = hostport.split_once(':') {
        (h, Some(p))
    } else {
        (hostport, None)
    };
    if let Some(p) = port_raw {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return AppBrowserTarget::Refuse {
                reason: AppBrowserRefusalReason::Unparsable,
                message: "That is not a web address".to_string(),
            };
        }
    }
    let hostname = hostname_raw.to_ascii_lowercase();
    if hostname.is_empty()
        || trimmed.chars().any(char::is_whitespace)
        || (!hostname.contains('.') && !is_loopback(&hostname))
    {
        return AppBrowserTarget::Refuse {
            reason: AppBrowserRefusalReason::Unparsable,
            message: "Enter a URL, like example.com".to_string(),
        };
    }
    if protocol == "http:" && !is_loopback(&hostname) {
        return AppBrowserTarget::Refuse {
            reason: AppBrowserRefusalReason::InsecureHost,
            message: "Plaintext http is only allowed for a local development server".to_string(),
        };
    }
    let port = match (protocol.as_str(), port_raw) {
        ("https:", Some("443")) | ("http:", Some("80")) => None,
        (_, p) => p,
    };
    let host = match port {
        Some(p) => format!("{hostname}:{p}"),
        None => hostname,
    };
    let path_suffix = if suffix.is_empty() {
        "/".to_string()
    } else if suffix.starts_with('/') {
        suffix.to_string()
    } else {
        format!("/{suffix}")
    };
    let url = format!("{protocol}//{host}{path_suffix}");
    AppBrowserTarget::Open { url, host }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingAppBrowserTarget {
    pub url: String,
    pub host: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppBrowserState {
    Editing,
    Opening,
    HandedOff,
    Refused,
}

impl AppBrowserState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Editing => "editing",
            Self::Opening => "opening",
            Self::HandedOff => "handedOff",
            Self::Refused => "refused",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppBrowserContext {
    pub input: String,
    pub pending: Option<PendingAppBrowserTarget>,
    pub host: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppBrowserEvent {
    Type { value: String },
    Open,
    OpenDone { ok: bool, error: Option<String> },
    OpenError { error: Option<String> },
    Dismiss,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppBrowserEffect {
    OpenTarget { url: String },
}

pub struct AppBrowserMachine;

impl Statechart for AppBrowserMachine {
    type State = AppBrowserState;
    type Context = AppBrowserContext;
    type Event = AppBrowserEvent;
    type Input = ();

    const ID: &'static str = "appBrowser";

    fn initial(_input: Self::Input) -> Snapshot<Self::State, Self::Context> {
        Snapshot::new(AppBrowserState::Editing, AppBrowserContext::default())
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

impl HandCashChart for AppBrowserMachine {
    const MANIFEST_ID: &'static str = "appBrowser";
    const TOP_LEVEL_STATES: &'static [&'static str] =
        &["editing", "opening", "handedOff", "refused"];
    type Effect = AppBrowserEffect;

    fn step(
        snapshot: &Snapshot<Self::State, Self::Context>,
        event: Self::Event,
    ) -> (Snapshot<Self::State, Self::Context>, Vec<Self::Effect>) {
        let mut ctx = snapshot.context.clone();
        let mut effects = Vec::new();
        let next = match (snapshot.value, event) {
            (AppBrowserState::Editing, AppBrowserEvent::Type { value }) => {
                ctx.input = value;
                ctx.error = None;
                AppBrowserState::Editing
            }
            (AppBrowserState::Editing, AppBrowserEvent::Open) => {
                match decide_app_browser_target(&ctx.input) {
                    AppBrowserTarget::Open { url, host } => {
                        ctx.pending = Some(PendingAppBrowserTarget {
                            url: url.clone(),
                            host,
                        });
                        ctx.error = None;
                        effects.push(AppBrowserEffect::OpenTarget { url });
                        AppBrowserState::Opening
                    }
                    AppBrowserTarget::Refuse { message, .. } => {
                        ctx.error = Some(message);
                        AppBrowserState::Refused
                    }
                }
            }
            (AppBrowserState::Opening, AppBrowserEvent::OpenDone { ok, error }) => {
                if ok {
                    ctx.host = ctx.pending.take().map(|p| p.host);
                    ctx.error = None;
                    AppBrowserState::HandedOff
                } else {
                    let msg = error
                        .filter(|e| !e.is_empty())
                        .unwrap_or_else(|| "Could not open the browser".to_string());
                    ctx.error = Some(msg);
                    ctx.pending = None;
                    AppBrowserState::Refused
                }
            }
            (AppBrowserState::Opening, AppBrowserEvent::OpenError { error }) => {
                ctx.error = Some(
                    error.unwrap_or_else(|| "Could not open the browser".to_string()),
                );
                ctx.pending = None;
                AppBrowserState::Refused
            }
            (AppBrowserState::HandedOff, AppBrowserEvent::Type { value }) => {
                ctx.input = value;
                ctx.error = None;
                AppBrowserState::Editing
            }
            (AppBrowserState::HandedOff, AppBrowserEvent::Dismiss) => AppBrowserState::Editing,
            (AppBrowserState::Refused, AppBrowserEvent::Type { value }) => {
                ctx.input = value;
                ctx.error = None;
                AppBrowserState::Editing
            }
            (AppBrowserState::Refused, AppBrowserEvent::Dismiss) => {
                ctx.error = None;
                AppBrowserState::Editing
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
    fn hands_normalised_url_to_shell_and_reports_host() {
        let mut actor = EffectActor::<AppBrowserMachine>::default();
        actor.send(AppBrowserEvent::Type {
            value: "lilpoker.com/poker".to_string(),
        });
        let effects = actor.send(AppBrowserEvent::Open);
        assert_eq!(
            effects,
            vec![AppBrowserEffect::OpenTarget {
                url: "https://lilpoker.com/poker".to_string()
            }]
        );
        actor.send(AppBrowserEvent::OpenDone {
            ok: true,
            error: None,
        });
        assert_eq!(*actor.state(), AppBrowserState::HandedOff);
        assert_eq!(actor.context().host.as_deref(), Some("lilpoker.com"));
    }

    #[test]
    fn never_asks_shell_to_open_address_wallet_refuses() {
        let mut actor = EffectActor::<AppBrowserMachine>::default();
        actor.send(AppBrowserEvent::Type {
            value: "javascript:alert(1)".to_string(),
        });
        let effects = actor.send(AppBrowserEvent::Open);
        assert!(effects.is_empty());
        assert_eq!(*actor.state(), AppBrowserState::Refused);
        assert!(actor
            .context()
            .error
            .as_deref()
            .unwrap()
            .contains("only opens https"));
    }

    #[test]
    fn surfaces_shell_failure_and_thrown_error_as_refusal() {
        let mut actor = EffectActor::<AppBrowserMachine>::default();
        actor.send(AppBrowserEvent::Type {
            value: "https://lilpoker.com".to_string(),
        });
        actor.send(AppBrowserEvent::Open);
        actor.send(AppBrowserEvent::OpenDone {
            ok: false,
            error: Some("No in-app browser on this device".to_string()),
        });
        assert_eq!(*actor.state(), AppBrowserState::Refused);
        assert_eq!(
            actor.context().error.as_deref(),
            Some("No in-app browser on this device")
        );

        let mut thrown = EffectActor::<AppBrowserMachine>::default();
        thrown.send(AppBrowserEvent::Type {
            value: "https://lilpoker.com".to_string(),
        });
        thrown.send(AppBrowserEvent::Open);
        thrown.send(AppBrowserEvent::OpenError {
            error: Some("plugin missing".to_string()),
        });
        assert_eq!(*thrown.state(), AppBrowserState::Refused);
        assert_eq!(thrown.context().error.as_deref(), Some("plugin missing"));
    }

    #[test]
    fn clears_refusal_as_soon_as_address_is_edited() {
        let mut actor = EffectActor::<AppBrowserMachine>::default();
        actor.send(AppBrowserEvent::Type {
            value: "file:///etc/hosts".to_string(),
        });
        actor.send(AppBrowserEvent::Open);
        assert_eq!(*actor.state(), AppBrowserState::Refused);
        actor.send(AppBrowserEvent::Type {
            value: "https://lilpoker.com".to_string(),
        });
        assert_eq!(*actor.state(), AppBrowserState::Editing);
        assert_eq!(actor.context().error, None);
    }

    // Ported 1:1 from `src/wallet/appBrowserUrl.test.ts`
    #[test]
    fn decide_app_browser_target_port_from_ts() {
        assert_eq!(
            decide_app_browser_target("lilpoker.com/poker"),
            AppBrowserTarget::Open {
                url: "https://lilpoker.com/poker".to_string(),
                host: "lilpoker.com".to_string(),
            }
        );
        assert_eq!(
            decide_app_browser_target("https://lil.example:8443/table?seat=3"),
            AppBrowserTarget::Open {
                url: "https://lil.example:8443/table?seat=3".to_string(),
                host: "lil.example:8443".to_string(),
            }
        );
        assert!(matches!(
            decide_app_browser_target("http://127.0.0.1:3000"),
            AppBrowserTarget::Open { .. }
        ));
        assert!(matches!(
            decide_app_browser_target("http://localhost:3000"),
            AppBrowserTarget::Open { .. }
        ));
        assert!(matches!(
            decide_app_browser_target("http://lilpoker.com"),
            AppBrowserTarget::Refuse {
                reason: AppBrowserRefusalReason::InsecureHost,
                ..
            }
        ));
        for raw in [
            "javascript:alert(document.cookie)",
            "file:///data/data/io.handcash.mobile",
            "data:text/html,<script>1</script>",
            "content://media/external/images",
            "peerpay:02abc",
        ] {
            assert!(
                matches!(
                    decide_app_browser_target(raw),
                    AppBrowserTarget::Refuse {
                        reason: AppBrowserRefusalReason::SchemeNotAllowed,
                        ..
                    }
                ),
                "raw={raw}"
            );
        }
        for raw in ["", "  "] {
            assert!(matches!(
                decide_app_browser_target(raw),
                AppBrowserTarget::Refuse {
                    reason: AppBrowserRefusalReason::Empty,
                    ..
                }
            ));
        }
        for raw in ["https://", "poker", "lil poker", "https://poker", "play lilpoker.com"] {
            assert!(
                matches!(
                    decide_app_browser_target(raw),
                    AppBrowserTarget::Refuse {
                        reason: AppBrowserRefusalReason::Unparsable,
                        ..
                    }
                ),
                "raw={raw}"
            );
        }
        assert_eq!(
            decide_app_browser_target("localhost:5173"),
            AppBrowserTarget::Open {
                url: "https://localhost:5173/".to_string(),
                host: "localhost:5173".to_string(),
            }
        );
        assert_eq!(
            decide_app_browser_target("lil.example:8443/table"),
            AppBrowserTarget::Open {
                url: "https://lil.example:8443/table".to_string(),
                host: "lil.example:8443".to_string(),
            }
        );
    }
}
