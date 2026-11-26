// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 Pure-Rust Dioxus + Aeon UI port of HandCash Desktop (`src/App.tsx`,
//! `src/components/*`, `src/styles/handcash.css`, `src/styles/layout-compact.css`).

pub mod activity;
pub mod app_browser;
pub mod apps;
pub mod auth;
pub mod chrome;
pub mod collectables;
pub mod collectables_extra;
pub mod dashboard;
pub mod devices;
pub mod friends;
pub mod import;
pub mod messages;
pub mod panels;
pub mod permissions;
pub mod platform_extras;
pub mod primitives;
pub mod send;
pub mod side;
pub mod swaps;

use crate::css_scope::{PLATFORM, ROOT_CLASSES, SCOPED_SHEETS};
use crate::icons::{HandCashBrandMark, LockIcon, ScanQrIcon};
use crate::machines::{
    app_state_to_wallet_session, resolve_wallet_status, session_to_wallet_profile, AuthFormMode,
    DisplayCurrency, NavChild, NavSection, ToastNotice,
};
use crate::state::{AppServices, SessionSummary};
use crate::theme::{build_theme_override_css, read_resolved_theme};
use aeon_dioxus::{use_aeon_machine, use_aeon_machine_with};
use aeon_ui::{button, AeonTheme, AeonThemeProvider};
use dioxus::prelude::*;
use handcash_machines::app::{AppEvent, AppMachine, AppState};
use handcash_machines::wallet_status::{
    WalletStatusEvent, WalletStatusInput, WalletStatusMachine,
};
use std::sync::Arc;

#[component]
pub fn HandCashApp() -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut os_theme = use_signal(read_resolved_theme);
    let appearance = use_signal(|| services.load_appearance());
    let existing_vault = use_signal(|| services.load_vault_record());

    // Auto-unlock passwordless vaults (mirrors `src/App.tsx` + `src/wallet/deviceLockPrefs.ts`).
    let initial_session = use_hook(|| {
        let s = if let Some(s) = services.current_session_summary() {
            Some(s)
        } else if let Some(Ok(s)) = services.try_auto_unlock() {
            Some(s)
        } else {
            None
        };
        if s.is_some() {
            services.spawn_sync_identities_from_peers();
        }
        s
    });

    let mut snapshot = use_signal(|| services.read_snapshot());
    let app_machine = use_aeon_machine::<AppMachine>();
    use_hook(|| {
        let snap = snapshot.peek().clone();
        let has_vault = existing_vault.peek().is_some();
        app_machine.send(AppEvent::Bridge {
            online: snap.bridge_online,
        });
        app_machine.send(AppEvent::Bootstrapped {
            has_vault,
            version: env!("CARGO_PKG_VERSION").to_string(),
            orphaned_toolbox: false,
        });
        if let Some(ref s) = initial_session {
            app_machine.send(AppEvent::Unlocked {
                profile: session_to_wallet_profile(s),
                balance_sats: snap.balance.displayed_sats,
            });
        }
    });

    let wallet_status = use_aeon_machine_with::<WalletStatusMachine>(WalletStatusInput {
        session: app_state_to_wallet_session(app_machine.peek_snapshot().value),
        network_online: true,
        bridge_online: snapshot.peek().bridge_online,
        ..Default::default()
    });

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

    // Keep WalletStatusMachine synchronized with AppMachine session transitions.
    use_effect(move || {
        wallet_status.send(WalletStatusEvent::Session {
            session: app_state_to_wallet_session(app_machine.state()),
        });
    });

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
                    app_machine.send(AppEvent::Bridge { online });
                    app_machine.send(AppEvent::Refreshed { balance_sats: sats });
                    wallet_status.send(WalletStatusEvent::Bridge { online });
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

    let app_state = app_machine.state();
    let app_ctx = app_machine.context();
    let app_state_attr = app_machine.state_attr();
    let status_state = wallet_status.state();
    let status_ctx = wallet_status.context();
    let status_view = resolve_wallet_status(status_state);
    let is_refreshing = status_ctx.refreshing;

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
                "data-aeon-state": "{app_state_attr}",

                // ── Top Titlebar (`src/App.tsx` lines 399-436) ──
                header { class: "titlebar aeon-titlebar",
                    BrandLogo { size: 28, show_wordmark: true }

                    div { class: "titlebar-end", "data-aeon-no-drag": "",
                        // WalletStatusPill
                        if app_state == AppState::Ready {
                            button {
                                r#type: "button",
                                class: "status-pill status-pill-btn",
                                "data-aeon-no-drag": "",
                                "data-aeon-state": status_view.state_attr,
                                "data-tone": status_view.tone.as_str(),
                                title: "{status_view.detail}",
                                disabled: is_refreshing,
                                onclick: move |_| {
                                    wallet_status.send(WalletStatusEvent::Refresh);
                                    if !wallet_status.peek_snapshot().context.refreshing {
                                        return;
                                    }
                                    let svc_sync = Arc::clone(&svc_sync);
                                    spawn(async move {
                                        let svc_bg = Arc::clone(&svc_sync);
                                        let res = svc_sync
                                            .engine
                                            .runtime_handle()
                                            .spawn(async move { svc_bg.sync_now_async().await })
                                            .await
                                            .unwrap_or_else(|e| Err(format!("Sync task failed: {e}")));
                                        match res {
                                            Ok(msg) => {
                                                let next = svc_sync.read_snapshot();
                                                let sats = next.balance.displayed_sats;
                                                let online = next.bridge_online;
                                                snapshot.set(next);
                                                app_machine.send(AppEvent::Bridge { online });
                                                app_machine.send(AppEvent::Refreshed { balance_sats: sats });
                                                wallet_status.send(WalletStatusEvent::Bridge { online });
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
                                        wallet_status.send(WalletStatusEvent::RefreshDone);
                                    });
                                },
                                span { class: "status-dot", "data-tone": status_view.tone.as_str() }
                                span { class: "status-pill-sizer", aria_hidden: true, "Synced" }
                                primitives::TextOverflowCarousel {
                                    label: status_view.label.to_string(),
                                    class: "status-pill-label".to_string(),
                                }
                            }
                        } else {
                            div {
                                class: "status-pill",
                                "data-aeon-no-drag": "",
                                "data-aeon-state": status_view.state_attr,
                                "data-tone": status_view.tone.as_str(),
                                title: "{status_view.detail}",
                                span { class: "status-dot", "data-tone": status_view.tone.as_str() }
                                span { class: "status-pill-sizer", aria_hidden: true, "Synced" }
                                primitives::TextOverflowCarousel {
                                    label: status_view.label.to_string(),
                                    class: "status-pill-label".to_string(),
                                }
                            }
                        }

                        if app_state == AppState::Ready {
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
                                        app_machine.send(AppEvent::Lock);
                                    },
                                    LockIcon { size: 18 }
                                }
                            }
                        }
                    }
                }

                // ── Main Stage (`src/App.tsx` lines 438-497) ──
                main { class: "stage",
                    match app_state {
                        AppState::Boot => rsx! {
                            auth::AuthShell { state: "loading",
                                section { class: "auth-screen", "data-aeon-state": "loading",
                                    div { class: "auth-copy",
                                        h1 { class: "auth-title", "Opening…" }
                                        p { class: "auth-lede", "Getting your wallet ready." }
                                    }
                                }
                            }
                        },
                        AppState::Failure => rsx! {
                            auth::AuthShell { state: "failure",
                                section { class: "auth-screen", "data-aeon-state": "failure",
                                    div { class: "auth-copy",
                                        h1 { class: "auth-title", "Something broke" }
                                        if let Some(ref err) = app_ctx.error {
                                            p { class: "error auth-error", "{err}" }
                                        }
                                    }
                                    button::Root {
                                        variant: button::ButtonVariant::Solid,
                                        class: "btn btn-primary auth-submit",
                                        onclick: move |_| {
                                            app_machine.send(AppEvent::ClearError);
                                            app_machine.send(AppEvent::Bootstrapped {
                                                has_vault: existing_vault.read().is_some(),
                                                version: env!("CARGO_PKG_VERSION").to_string(),
                                                orphaned_toolbox: false,
                                            });
                                        },
                                        button::Label { "Retry" }
                                    }
                                }
                            }
                        },
                        AppState::Onboarding | AppState::Locked => {
                            let auth_state: &'static str = if app_state == AppState::Locked {
                                "locked"
                            } else {
                                "onboarding"
                            };
                            rsx! {
                                auth::AuthShell {
                                    state: auth_state,
                                    dark_mode: resolved.mode == aeon_ui::AeonMode::Dark,
                                    auth::AuthFlow {
                                        is_locked: app_state == AppState::Locked,
                                        auth_mode,
                                        app_machine,
                                        snapshot,
                                        fiat_code,
                                        fresh_mnemonic,
                                        toast,
                                    }
                                }
                            }
                        }
                        AppState::Ready => {
                            let active_profile = services.current_session_summary().or_else(|| {
                                app_ctx.profile.as_ref().map(|wp| SessionSummary {
                                    handle: wp.handle.clone(),
                                    identity_key: wp.identity_key.clone(),
                                    address: wp.address.clone(),
                                    chain: wp.chain.as_str().to_string(),
                                    account_id: "acct-0".to_string(),
                                    account_index: 0,
                                    toolbox_db_name: "handcash-toolbox-0".to_string(),
                                    generation: 1,
                                    has_mnemonic: true,
                                    derivation: "brc157".to_string(),
                                })
                            });
                            if let Some(profile) = active_profile {
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
                div { class: "empty-state-icon", "aria-hidden": "true", {ic} }
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
