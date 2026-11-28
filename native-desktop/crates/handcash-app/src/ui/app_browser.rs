// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Phase 7 App Browser & Launcher components.
//! 1:1 port of:
//! - `src/components/AppLaunchMenu.tsx`
//! - `src/components/AppLaunchPanel.tsx`
//! - `src/components/AppsSearchBar.tsx`
//! - `src/components/AppBrowserTabSwitcher.tsx`
//! - `src/components/AppBrowserPanel.tsx`

use crate::icons::{BackIcon, CloseIcon, LaunchIcon, LockIcon, RefreshIcon, SearchIcon};
use crate::ui::apps::AppAvatar;
use crate::ui::permissions::{WalletRequestActions, WalletRequestTemplate};
use crate::ui::primitives::{DeferredImage, SearchField, TopBarPopover};
use aeon_ui::{button, status_banner};
use dioxus::prelude::*;

/// Validate whether a URL is a safe http(s) target for app launch/browser.
pub fn decide_app_browser_target(raw: &str) -> Result<(String, String), &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a web address");
    }
    let candidate = if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        trimmed.to_string()
    } else if trimmed.contains('.') && !trimmed.contains(' ') {
        format!("https://{trimmed}")
    } else {
        return Err("Not a valid web address");
    };
    let rest = candidate
        .strip_prefix("https://")
        .or_else(|| candidate.strip_prefix("http://"))
        .unwrap_or("");
    let host = rest.split('/').next().unwrap_or("").to_string();
    if host.is_empty() || !host.contains('.') && !host.starts_with("localhost") {
        return Err("Not a valid web address");
    }
    Ok((candidate, host))
}

pub fn apps_search_address(query: &str, can_open: bool) -> Option<String> {
    if !can_open {
        return None;
    }
    decide_app_browser_target(query).ok().map(|(_, host)| host)
}

/// 1:1 port of `src/components/AppLaunchMenu.tsx`.
#[component]
pub fn AppLaunchMenu(
    url: String,
    origin: String,
    name: String,
    #[props(default)] compact: bool,
    #[props(default)] on_launch: Option<EventHandler<(String, String)>>,
) -> Element {
    let _ = compact;
    let Ok((safe_url, _)) = decide_app_browser_target(&url) else {
        return rsx! {};
    };
    let orig = origin.clone();
    rsx! {
        button::Root {
            variant: button::ButtonVariant::Solid,
            class: "btn btn-primary btn-icon connected-app-icon-action",
            aria_label: "Launch {name}",
            title: "Launch {name}",
            onclick: move |_| {
                if let Some(cb) = on_launch {
                    cb.call((orig.clone(), safe_url.clone()));
                }
            },
            LaunchIcon { size: 17 }
        }
    }
}

/// 1:1 port of `src/components/AppLaunchPanel.tsx`.
#[component]
pub fn AppLaunchPanel(
    origin: String,
    name: String,
    url: String,
    #[props(default)] in_app_available: bool,
    #[props(default)] on_open_external: Option<EventHandler<String>>,
    #[props(default)] on_cancel: Option<EventHandler<()>>,
) -> Element {
    let safe_url = decide_app_browser_target(&url).ok().map(|(u, _)| u);
    let can_open = safe_url.is_some();
    let url_open = safe_url.clone();
    let actions = WalletRequestActions {
        aria_label: format!("Launch {name}"),
        secondary_label: "Cancel".to_string(),
        secondary_disabled: false,
        primary_label: "Open in browser".to_string(),
        primary_disabled: !can_open,
    };
    let note = if in_app_available {
        "Opens in your system browser by default. Use in-app only when you want the session inside HandCash. Same wallet permissions either way."
    } else {
        "Opens in your system browser with the same connected wallet permissions."
    };
    rsx! {
        WalletRequestTemplate {
            scope: "app-launch".to_string(),
            state: Some(if in_app_available { "ready" } else { "external-only" }.to_string()),
            actions,
            placement: "inline".to_string(),
            class: Some("nav-child-panel app-launch-panel".to_string()),
            on_secondary: on_cancel,
            on_primary: Some(EventHandler::new(move |_| {
                if let (Some(cb), Some(u)) = (on_open_external, url_open.clone()) {
                    cb.call(u);
                }
            })),
            div { class: "connect-app-hero app-launch-hero",
                AppAvatar { origin: origin.clone(), name: name.clone(), size: "md" }
                div {
                    p { class: "permission-eyebrow", "Launch connected app" }
                    h2 { class: "permission-request-title", "{name}" }
                    p { class: "mono permission-origin", "{origin}" }
                }
            }
            p { class: "permission-note", "{note}" }
        }
    }
}

/// 1:1 port of `src/components/AppsSearchBar.tsx`.
#[component]
pub fn AppsSearchBar(
    query: String,
    on_query_change: EventHandler<String>,
    #[props(default)] can_open: bool,
    #[props(default)] on_open_address: Option<EventHandler<String>>,
) -> Element {
    let address = apps_search_address(&query, can_open);
    let active = !query.trim().is_empty();
    let aria = if can_open {
        "Search apps or open a web address"
    } else {
        "Search peer apps"
    };
    rsx! {
        TopBarPopover {
            aria_label: aria.to_string(),
            title: Some("Search".to_string()),
            class: Some("panel-search-popover".to_string()),
            trigger_class: Some("wallet-nav-chrome-btn".to_string()),
            content_class: Some("panel-search-popover-content".to_string()),
            active,
            trigger: rsx! {
                SearchIcon { size: 16 }
                if active {
                    span { class: "wallet-nav-chrome-dot", aria_hidden: "true" }
                }
            },
            div {
                class: "root-search friends-search apps-search",
                role: "search",
                "data-aeon-scope": "app-browser",
                "data-aeon-state": if active { "typing" } else { "idle" },
                SearchField {
                    id: "apps-search-input".to_string(),
                    label: aria.to_string(),
                    value: query.clone(),
                    placeholder: Some(if can_open { "App or web address" } else { "App name" }.to_string()),
                    on_value_change: on_query_change,
                }
                if let Some(host) = address {
                    ul { class: "settings-list apps-search-open",
                        li {
                            button {
                                r#type: "button",
                                class: "settings-row",
                                onclick: move |_| {
                                    if let Some(cb) = on_open_address {
                                        cb.call(host.clone());
                                    }
                                },
                                LaunchIcon { size: 20 }
                                div { class: "settings-row-copy",
                                    strong { "Open {host}" }
                                    span { class: "settings-row-desc", "In the wallet browser" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Open embedded browser tab entry for `AppBrowserTabSwitcher`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserTabEntry {
    pub origin: String,
    pub name: String,
    pub url: String,
    pub preview_data_url: Option<String>,
}

/// 1:1 port of `src/components/AppBrowserTabSwitcher.tsx`.
#[component]
pub fn AppBrowserTabSwitcher(
    tabs: Vec<BrowserTabEntry>,
    #[props(default)] active_origin: Option<String>,
    on_select: EventHandler<String>,
    on_close: EventHandler<String>,
    on_done: EventHandler<()>,
) -> Element {
    let count = tabs.len();
    let active_idx = active_origin
        .as_deref()
        .and_then(|o| tabs.iter().position(|t| t.origin == o))
        .unwrap_or(0);
    let prev_origin = if active_idx > 0 { tabs.get(active_idx - 1).map(|t| t.origin.clone()) } else { None };
    let next_origin = tabs.get(active_idx + 1).map(|t| t.origin.clone());
    rsx! {
        section {
            class: "app-browser-tab-switcher",
            "data-aeon-scope": "app-browser-tabs",
            "data-aeon-state": "open",
            aria_label: "Open app tabs",
            header { class: "app-browser-tab-switcher-head",
                div {
                    span { "Open web pages" }
                    strong { if count == 1 { "1 page" } else { "{count} pages" } }
                }
                div { class: "app-browser-tab-switcher-actions",
                    button {
                        r#type: "button",
                        aria_label: "Previous page",
                        disabled: prev_origin.is_none(),
                        onclick: move |_| {
                            if let Some(o) = prev_origin.clone() { on_select.call(o); }
                        },
                        BackIcon { size: 18 }
                    }
                    button {
                        r#type: "button",
                        aria_label: "Next page",
                        disabled: next_origin.is_none(),
                        onclick: move |_| {
                            if let Some(o) = next_origin.clone() { on_select.call(o); }
                        },
                        BackIcon { size: 18 }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| on_done.call(()),
                        button::Label { "Done" }
                    }
                }
            }
            div { class: "app-browser-tab-carousel",
                for tab in tabs {
                    {
                        let is_active = active_origin.as_deref() == Some(tab.origin.as_str());
                        let sel_origin = tab.origin.clone();
                        let close_origin = tab.origin.clone();
                        rsx! {
                            div {
                                key: "{tab.origin}",
                                class: "app-browser-tab-card",
                                "data-active": if is_active { Some("true") } else { None },
                                button {
                                    r#type: "button",
                                    class: "app-browser-tab-select",
                                    onclick: move |_| on_select.call(sel_origin.clone()),
                                    DeferredImage {
                                        src: tab.preview_data_url.clone(),
                                        alt: tab.name.clone(),
                                        fallback: Some(rsx! {
                                            span { class: "app-browser-tab-preview-fallback",
                                                AppAvatar { origin: tab.origin.clone(), name: tab.name.clone(), size: "md" }
                                                span { "{tab.name}" }
                                            }
                                        }),
                                    }
                                }
                                button {
                                    r#type: "button",
                                    class: "app-browser-tab-close",
                                    aria_label: "Close {tab.name}",
                                    onclick: move |_| on_close.call(close_origin.clone()),
                                    CloseIcon { size: 14 }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/AppBrowserPanel.tsx`.
/// Opens apps in a dedicated native webview host (`handcash-shell`) or the OS browser
/// connected to the local BRC-100 bridge.
#[component]
pub fn AppBrowserPanel(
    name: String,
    origin: String,
    url: String,
    #[props(default)] on_open_external: Option<EventHandler<String>>,
    #[props(default)] on_close: Option<EventHandler<String>>,
) -> Element {
    let target = decide_app_browser_target(&url);
    let close_orig = origin.clone();
    let Ok((safe_url, host)) = target else {
        return rsx! {
            div {
                class: "nav-child-panel app-browser-panel",
                "data-aeon-scope": "app-browser",
                "data-aeon-state": "error",
                div { "data-aeon-part": "notice", role: "alert",
                    strong { "{name} cannot open here" }
                    span { "Invalid web address." }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| {
                            if let Some(cb) = on_close { cb.call(close_orig.clone()); }
                        },
                        button::Label { "Close tab" }
                    }
                }
            }
        };
    };
    let ext_url = safe_url.clone();
    let reload_url = safe_url.clone();
    let launch_url = safe_url.clone();
    rsx! {
        div {
            class: "nav-child-panel app-browser-panel",
            "data-aeon-scope": "app-browser",
            "data-aeon-state": "ready",
            header { class: "app-browser-toolbar",
                div { class: "app-browser-navigation",
                    button { r#type: "button", aria_label: "Back", title: "Back", disabled: true, BackIcon { size: 16 } }
                    button { r#type: "button", class: "app-browser-forward", aria_label: "Forward", title: "Forward", disabled: true, BackIcon { size: 16 } }
                    button {
                        r#type: "button",
                        aria_label: "Reload",
                        title: "Reload in webview",
                        onclick: move |_| {
                            let _ = crate::native_services::launch_app_browser_window(&reload_url);
                        },
                        RefreshIcon { size: 16 }
                    }
                }
                div { class: "app-browser-location",
                    LockIcon { size: 13 }
                    span { class: "mono", "{host}" }
                }
                div { class: "app-browser-actions",
                    button {
                        r#type: "button",
                        aria_label: "Open in system browser",
                        title: "Open in system browser",
                        onclick: move |_| {
                            if let Some(cb) = on_open_external {
                                cb.call(ext_url.clone());
                            } else {
                                let _ = crate::native_services::launch_app_browser_window(&ext_url);
                            }
                        },
                        LaunchIcon { size: 16 }
                    }
                    button {
                        r#type: "button",
                        aria_label: "Close tab",
                        title: "Close tab",
                        onclick: move |_| {
                            if let Some(cb) = on_close { cb.call(close_orig.clone()); }
                        },
                        CloseIcon { size: 16 }
                    }
                }
            }
            div { class: "app-browser-notice", "data-aeon-part": "notice",
                status_banner::Root { tone: status_banner::StatusTone::Info, status: Some("ready".to_string()),
                    status_banner::Copy {
                        status_banner::Title { "{name} is ready on the local BRC-100 bridge" }
                        status_banner::Body { "Launch {safe_url} in a dedicated native webview window or your system browser." }
                    }
                }
                div { class: "actions",
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        onclick: move |_| {
                            let _ = crate::native_services::launch_app_browser_window(&launch_url);
                        },
                        button::Label { "Launch app window" }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_browser_target_and_search_address_match_ts() {
        assert_eq!(apps_search_address("market.handcash.io", false), None);
        assert_eq!(apps_search_address("market.handcash.io", true), Some("market.handcash.io".to_string()));
        assert_eq!(apps_search_address("hello world", true), None);
        let (u, h) = decide_app_browser_target("https://app.example.com/path").unwrap();
        assert_eq!(u, "https://app.example.com/path");
        assert_eq!(h, "app.example.com");
    }
}
