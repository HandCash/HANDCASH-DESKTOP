// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop Connected Apps & App Details surfaces:
//! - `src/components/ConnectedAppsPanel.tsx`
//! - `src/components/AppDetailsPanel.tsx`

use crate::icons::AppsIcon;
use crate::machines::{CollectionView, NavChild, ToastNotice};
use crate::state::{
    format_relative_time, now_ms, open_external_url, AppServices, ConnectedAppRecord,
    WalletSnapshot,
};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use crate::ui::EmptyState;
use dioxus::prelude::*;
use std::sync::Arc;

fn app_title(app: &ConnectedAppRecord) -> String {
    if !app.name.trim().is_empty() {
        return app.name.trim().to_string();
    }
    app.origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

/// 1:1 port of `src/components/ConnectedAppsPanel.tsx`.
#[component]
pub fn ConnectedAppsPanel(
    snap: WalletSnapshot,
    view: Signal<CollectionView>,
    mut nav_child: Signal<Option<NavChild>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut query = use_signal(String::new);

    let apps = services.list_connected_apps();
    let q = query.read().trim().to_ascii_lowercase();
    let cur_view = *view.read();
    let filtered: Vec<ConnectedAppRecord> = apps
        .iter()
        .filter(|a| {
            q.is_empty()
                || a.name.to_ascii_lowercase().contains(&q)
                || a.origin.to_ascii_lowercase().contains(&q)
        })
        .cloned()
        .collect();

    rsx! {
        div {
            class: "nav-section-body nav-section-with-scroll",
            "data-aeon-scope": "connected-apps",
            "data-aeon-state": "list",
            "data-view": cur_view.as_str(),

            if !apps.is_empty() {
                div { class: "field", style: "margin-bottom: 10px;",
                    input {
                        placeholder: "Filter connected apps by name or origin…",
                        value: "{query}",
                        oninput: move |e| query.set(e.value()),
                    }
                }
            }

            if apps.is_empty() {
                EmptyState {
                    icon: Some(rsx! { AppsIcon { size: 28 } }),
                    title: "No apps connected",
                    body: Some(format!(
                        "BRC-100 bridge {} ({} / {}).",
                        if snap.bridge_online { "listening on" } else { "offline" },
                        snap.bridge_http_url,
                        snap.bridge_https_url,
                    )),
                }
            } else if filtered.is_empty() {
                EmptyState {
                    icon: Some(rsx! { AppsIcon { size: 28 } }),
                    title: "No matching apps",
                    body: Some("Try another name or origin.".into()),
                }
            } else {
                div { class: "nav-section-scroll-body",
                    if cur_view == CollectionView::Grid {
                        ul { class: "collection-grid",
                            for app in filtered.iter() {
                                {
                                    let orig = app.origin.clone();
                                    let title = app_title(app);
                                    rsx! {
                                        li { key: "{app.origin}", class: "collection-grid-card",
                                            button {
                                                r#type: "button",
                                                class: "collection-grid-main",
                                                onclick: move |_| nav_child.set(Some(NavChild::AppDetails(orig.clone()))),
                                                div { class: "collectable-media",
                                                    AppsIcon { size: 28 }
                                                }
                                                strong { class: "collection-grid-name", "{title}" }
                                                span { class: "collection-grid-host mono", "{app.origin}" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        ul { class: "connected-app-list",
                            for app in filtered.iter() {
                                {
                                    let orig = app.origin.clone();
                                    let title = app_title(app);
                                    let when = format_relative_time(app.connected_at, now_ms());
                                    rsx! {
                                        li { key: "{app.origin}", class: "connected-app-row",
                                            button {
                                                r#type: "button",
                                                class: "connected-app-main",
                                                onclick: move |_| nav_child.set(Some(NavChild::AppDetails(orig.clone()))),
                                                div { class: "collectable-media collectable-media-sm",
                                                    AppsIcon { size: 20 }
                                                }
                                                div { class: "connected-app-body",
                                                    strong { class: "connected-app-name", "{title}" }
                                                    span { class: "connected-app-host mono", "{app.origin}" }
                                                }
                                                span { class: "history-when", "{when}" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/AppDetailsPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn AppDetailsPanel(
    origin: String,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut confirming_disconnect = use_signal(|| false);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let app_opt = services
        .list_connected_apps()
        .into_iter()
        .find(|a| a.origin == origin);

    let Some(app) = app_opt else {
        if dock_spec.read().is_some() {
            dock_spec.set(None);
        }
        return rsx! {
            div { class: "nav-child-panel", "data-aeon-scope": "app-details",
                p { class: "connected-empty-line", "App not found" }
            }
        };
    };

    let is_confirming = *confirming_disconnect.read();
    let desired_dock = if is_confirming {
        DockSpec {
            aria_label: "Confirm disconnect app",
            secondary: Some(DockActionSpec::new(
                "cancel-disconnect",
                "Cancel",
                ActionTone::Secondary,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "confirm-disconnect",
                "Disconnect",
                ActionTone::Danger,
                ActionIcon::Close,
            ),
        }
    } else {
        DockSpec {
            aria_label: "App actions",
            secondary: Some(DockActionSpec::new(
                "ask-disconnect",
                "Disconnect",
                ActionTone::Danger,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "open-app",
                "Open",
                ActionTone::Primary,
                ActionIcon::Check,
            ),
        }
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let svc_act = Arc::clone(&services);
        let orig_act = app.origin.clone();
        let title_act = app_title(&app);
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "ask-disconnect" => confirming_disconnect.set(true),
                "cancel-disconnect" => confirming_disconnect.set(false),
                "confirm-disconnect" => match svc_act.revoke_connected_app(&orig_act) {
                    Ok(()) => {
                        toast.set(Some(ToastNotice {
                            title: "Disconnected".into(),
                            body: Some(title_act.clone()),
                            tone: "success",
                        }));
                        dock_spec.set(None);
                        nav_child.set(None);
                    }
                    Err(e) => toast.set(Some(ToastNotice {
                        title: "Disconnect failed".into(),
                        body: Some(e),
                        tone: "error",
                    })),
                },
                "open-app" => {
                    if let Err(e) = open_external_url(&orig_act) {
                        toast.set(Some(ToastNotice {
                            title: "Open app".into(),
                            body: Some(e),
                            tone: "error",
                        }));
                    }
                }
                _ => {}
            }
        });
    }

    let title = app_title(&app);
    let when = format_relative_time(app.connected_at, now_ms());

    rsx! {
        div { class: "nav-child-panel payment-details", "data-aeon-scope": "app-details",
            div { class: "payment-details-hero",
                div { class: "history-icon-wrap",
                    div { class: "history-icon",
                        AppsIcon { size: 18 }
                    }
                }
                div { class: "payment-details-copy",
                    strong { class: "payment-details-title", "{title}" }
                    p { class: "history-when mono", "{app.origin}" }
                }
            }

            dl { class: "payment-details-meta",
                dt { "Connected" }
                dd { "{when}" }

                dt { "Incoming BSV" }
                dd {
                    if app.accept_incoming_funds.unwrap_or(false) {
                        "Allowed"
                    } else {
                        "Ask"
                    }
                }

                dt { "Grant" }
                dd {
                    if app.expires_at.is_some() {
                        "Timed BRC-73 grant"
                    } else {
                        "Until you disconnect"
                    }
                }
            }

            if is_confirming {
                p { class: "error", role: "alert",
                    "Disconnect {title}? It will need to request permission again to access your wallet."
                }
            }
        }
    }
}
