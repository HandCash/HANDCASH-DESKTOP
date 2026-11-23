// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 Pure-Rust Dioxus + Aeon UI port of HandCash Desktop (`src/App.tsx`,
//! `src/components/*`, `src/styles/handcash.css`, `src/styles/layout-compact.css`).

pub mod activity;
pub mod apps;
pub mod auth;
pub mod chrome;
pub mod collectables;
pub mod dashboard;
pub mod friends;
pub mod panels;
pub mod send;
pub mod side;

use crate::css_scope::{PLATFORM, ROOT_CLASSES, SCOPED_SHEETS};
use crate::icons::{HandCashBrandMark, LockIcon, ScanQrIcon};
use crate::machines::{
    resolve_wallet_status, AppSessionEvent, AppSessionMachine, AppSessionState, AuthFormMode,
    DisplayCurrency, NavChild, NavSection, ToastNotice,
};
use crate::state::AppServices;
use crate::theme::{build_theme_override_css, read_resolved_theme};
use aeon_ui::{button, AeonTheme, AeonThemeProvider};
use dioxus::prelude::*;
use std::sync::Arc;

#[component]
pub fn HandCashApp() -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut os_theme = use_signal(read_resolved_theme);
    let appearance = use_signal(|| services.load_appearance());
    let existing_vault = use_signal(|| services.load_vault_record());

    // Auto-unlock passwordless vaults (mirrors `src/App.tsx` + `src/wallet/deviceLockPrefs.ts`).
    let initial_session = use_hook(|| {
        if let Some(s) = services.current_session_summary() {
            Some(s)
        } else if let Some(Ok(s)) = services.try_auto_unlock() {
            Some(s)
        } else {
            None
        }
    });

    let mut snapshot = use_signal(|| services.read_snapshot());
    let mut app_machine = use_signal(|| {
        let snap = snapshot.read();
        AppSessionMachine::new(
            existing_vault.read().is_some(),
            initial_session.clone(),
            snap.balance.displayed_sats,
            snap.bridge_online,
        )
    });

    let mut syncing = use_signal(|| false);
    let mut nav_section = use_signal(|| NavSection::Activity);
    let mut nav_child = use_signal(|| Option::<NavChild>::None);
    let currency = use_signal(|| DisplayCurrency::Usd);
    let fiat_code = use_signal(|| services.load_fiat_currency());
    let mut fx_rates = use_signal(|| services.current_fx_rates());
    let mut toast = use_signal(|| Option::<ToastNotice>::None);
    let mut fresh_mnemonic = use_signal(|| Option::<String>::None);

    let initial_auth_mode = if existing_vault.read().is_some() {
        AuthFormMode::Unlock
    } else {
        AuthFormMode::Entry
    };
    let mut auth_mode = use_signal(move || initial_auth_mode);

    // Live FX rate updates + initial background fetch (12 fiat currencies).
    {
        let svc_fx = Arc::clone(&services);
        use_future(move || {
            let svc = Arc::clone(&svc_fx);
            async move {
                let mut rx = svc.subscribe_fx();
                let svc_fetch = Arc::clone(&svc);
                svc.engine.runtime_handle().spawn(async move {
                    svc_fetch.refresh_fx_rates_async().await;
                });
                while rx.changed().await.is_ok() {
                    fx_rates.set(rx.borrow().clone());
                }
            }
        });
    }

    // Live reactive updates from WalletEngine push patches (0Hz when idle).
    {
        let svc_patch = Arc::clone(&services);
        use_future(move || {
            let svc = Arc::clone(&svc_patch);
            async move {
                let mut rx = svc.subscribe_patches();
                while rx.changed().await.is_ok() {
                    let next = svc.read_snapshot();
                    let sats = next.balance.displayed_sats;
                    let online = next.bridge_online;
                    snapshot.set(next);
                    let mut m = app_machine.write();
                    m.send(AppSessionEvent::Bridge { online });
                    m.send(AppSessionEvent::Refreshed { balance_sats: sats });
                }
            }
        });
    }

    // Live Omarchy theme updates.
    {
        let svc_theme = Arc::clone(&services);
        use_future(move || {
            let svc = Arc::clone(&svc_theme);
            async move {
                let mut rx = svc.subscribe_theme();
                while rx.changed().await.is_ok() {
                    os_theme.set(rx.borrow().clone());
                }
            }
        });
    }

    let resolved = os_theme.read().with_preference(*appearance.read());
    let theme_override_css = build_theme_override_css(&resolved);

    let machine_view = app_machine.read().clone();
    let snap = snapshot.read().clone();
    let status_view =
        resolve_wallet_status(&machine_view.state, snap.bridge_online, *syncing.read());

    let svc_sync = Arc::clone(&services);
    let svc_lock = Arc::clone(&services);
    let scoped_sheets: &str = &SCOPED_SHEETS;

    rsx! {
        AeonThemeProvider {
            theme: AeonTheme::Handcash,
            mode: resolved.mode,
            link {
                rel: "stylesheet",
                href: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Syncopate:wght@700&display=swap",
            }
            style { "{scoped_sheets}" }
            style { "{theme_override_css}" }

            // Stands in for `<html>`, which Dioxus Native cannot tag (see `css_scope`).
            div {
                class: ROOT_CLASSES,
                "data-hc": "",
                "data-aeon-mode": resolved.mode.as_str(),
                "data-aeon-platform": PLATFORM,
            div {
                class: "app-shell",
                "data-aeon-scope": "app",
                "data-aeon-state": machine_view.state.as_attr(),

                // ── Top Titlebar (`src/App.tsx` lines 399-436) ──
                header { class: "titlebar aeon-titlebar",
                    BrandLogo { size: 28, show_wordmark: true }

                    div { class: "titlebar-end", "data-aeon-no-drag": "",
                        // WalletStatusPill
                        if machine_view.state == AppSessionState::Ready {
                            button {
                                r#type: "button",
                                class: "status-pill status-pill-btn",
                                "data-aeon-no-drag": "",
                                "data-aeon-state": status_view.state_attr,
                                "data-tone": status_view.tone.as_str(),
                                title: "{status_view.detail}",
                                disabled: *syncing.read(),
                                onclick: move |_| {
                                    syncing.set(true);
                                    match svc_sync.sync_now() {
                                        Ok(msg) => {
                                            let next = svc_sync.read_snapshot();
                                            let sats = next.balance.displayed_sats;
                                            snapshot.set(next);
                                            app_machine.write().send(AppSessionEvent::Refreshed { balance_sats: sats });
                                            toast.set(Some(ToastNotice {
                                                title: "Synced".into(),
                                                body: Some(msg),
                                                tone: "success",
                                            }));
                                        }
                                        Err(e) => {
                                            toast.set(Some(ToastNotice {
                                                title: "Refresh failed".into(),
                                                body: Some(e),
                                                tone: "error",
                                            }));
                                        }
                                    }
                                    syncing.set(false);
                                },
                                span { class: "status-dot", "data-tone": status_view.tone.as_str() }
                                span { class: "status-pill-label", "{status_view.label}" }
                            }
                        } else {
                            div {
                                class: "status-pill",
                                "data-aeon-no-drag": "",
                                "data-aeon-state": status_view.state_attr,
                                "data-tone": status_view.tone.as_str(),
                                title: "{status_view.detail}",
                                span { class: "status-dot", "data-tone": status_view.tone.as_str() }
                                span { class: "status-pill-label", "{status_view.label}" }
                            }
                        }

                        if machine_view.state == AppSessionState::Ready {
                            div { class: "titlebar-actions",
                                button {
                                    r#type: "button",
                                    class: "titlebar-action-btn",
                                    aria_label: "Scan QR code",
                                    title: "Scan QR code",
                                    onclick: move |_| {
                                        nav_child.set(Some(NavChild::Scan));
                                    },
                                    ScanQrIcon { size: 18 }
                                }
                                button {
                                    r#type: "button",
                                    class: "titlebar-action-btn",
                                    aria_label: "Lock wallet",
                                    title: "Lock wallet",
                                    onclick: move |_| {
                                        svc_lock.lock();
                                        fresh_mnemonic.set(None);
                                        nav_child.set(None);
                                        nav_section.set(NavSection::Activity);
                                        auth_mode.set(AuthFormMode::Unlock);
                                        app_machine.write().send(AppSessionEvent::Lock);
                                    },
                                    LockIcon { size: 18 }
                                }
                            }
                        }
                    }
                }

                // ── Main Stage (`src/App.tsx` lines 438-497) ──
                main { class: "stage",
                    match machine_view.state {
                        AppSessionState::Boot => rsx! {
                            auth::AuthShell { state: "loading",
                                section { class: "auth-screen", "data-aeon-state": "loading",
                                    div { class: "auth-copy",
                                        h1 { class: "auth-title", "Opening…" }
                                        p { class: "auth-lede", "Getting your wallet ready." }
                                    }
                                }
                            }
                        },
                        AppSessionState::Failure => rsx! {
                            auth::AuthShell { state: "failure",
                                section { class: "auth-screen", "data-aeon-state": "failure",
                                    div { class: "auth-copy",
                                        h1 { class: "auth-title", "Something broke" }
                                        if let Some(ref err) = machine_view.error {
                                            p { class: "error auth-error", "{err}" }
                                        }
                                    }
                                    button::Root {
                                        variant: button::ButtonVariant::Solid,
                                        class: "btn btn-primary auth-submit",
                                        onclick: move |_| {
                                            app_machine.write().send(AppSessionEvent::ClearError);
                                            app_machine.write().send(AppSessionEvent::Bootstrapped {
                                                has_vault: existing_vault.read().is_some(),
                                            });
                                        },
                                        button::Label { "Retry" }
                                    }
                                }
                            }
                        },
                        AppSessionState::Onboarding | AppSessionState::Locked => rsx! {
                            auth::AuthShell {
                                state: machine_view.state.as_attr(),
                                dark_mode: resolved.mode == aeon_ui::AeonMode::Dark,
                                auth::AuthFlow {
                                    is_locked: machine_view.state == AppSessionState::Locked,
                                    auth_mode,
                                    app_machine,
                                    snapshot,
                                    fiat_code,
                                    fresh_mnemonic,
                                    toast,
                                }
                            }
                        },
                        AppSessionState::Ready => {
                            if let Some(profile) = machine_view.profile.clone() {
                                rsx! {
                                    dashboard::Dashboard {
                                        profile,
                                        app_machine,
                                        snapshot,
                                        nav_section,
                                        nav_child,
                                        currency,
                                        fiat_code,
                                        fx_rates,
                                        appearance,
                                        toast,
                                        fresh_mnemonic,
                                    }
                                }
                            } else {
                                rsx! {}
                            }
                        }
                    }
                }

                chrome::AppToastHost { toast }
            }
            }
        }
    }
}

/// 1:1 port of `src/components/BrandLogo.tsx`.
#[component]
pub fn BrandLogo(
    #[props(default = 28)] size: u32,
    #[props(default = true)] show_wordmark: bool,
) -> Element {
    rsx! {
        div {
            class: "brand",
            "data-aeon-scope": "identity",
            "data-aeon-part": "root",
            span { class: "brand-mark-wrap",
                HandCashBrandMark { size }
                span { class: "brand-beta", "BETA" }
            }
            if show_wordmark {
                div { class: "brand-wordmark",
                    div { class: "brand-name", "HandCash" }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/EmptyState.tsx`.
#[component]
pub fn EmptyState(
    title: String,
    #[props(default = None)] body: Option<String>,
    #[props(default = None)] icon: Option<Element>,
    #[props(default = None)] action: Option<Element>,
) -> Element {
    rsx! {
        div {
            class: "empty-state",
            "data-aeon-scope": "empty-state",
            role: "status",
            if let Some(ic) = icon {
                div { class: "empty-state-icon", {ic} }
            }
            h3 { class: "empty-state-title", "{title}" }
            if let Some(b) = body {
                p { class: "empty-state-body", "{b}" }
            }
            if let Some(act) = action {
                div { class: "empty-state-action", {act} }
            }
        }
    }
}
