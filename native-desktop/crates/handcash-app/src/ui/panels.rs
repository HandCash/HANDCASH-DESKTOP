// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of the HandCash Desktop navigation panels:
//! `SendPanel`, `ReceivePanel`, `RecentActivity` / `TransactionsPanel`,
//! `ConnectedAppsPanel`, `InventoryPanel`, `FriendsPanel`, `IdentityPanel`, `SettingsPanel`.

use crate::icons::{
    ActivityIcon, AppsIcon, ArcUsdGlyphIcon, CheckIcon, CodeIcon, CoinGlyphIcon, DarkModeIcon,
    DevicesIcon, DownloadIcon, EncryptIcon, ExpandMoreIcon, FileIcon, FingerprintIcon, InfoIcon,
    LaunchIcon, LightModeIcon, LockIcon, LtcGlyphIcon, MonitorIcon, PaletteIcon, RefreshIcon,
    ScanQrIcon, SwapIcon, SystemUpdateIcon, WarningIcon,
};
use crate::health::{dependency_health_alert, DependencyHealthSnapshot, HealthAlert};
use crate::machines::{FiatCode, NavChild, SettingSubpage, ToastNotice};
use crate::state::{
    copy_to_clipboard, render_qr_svg, truncate_mid, AcceptedCoins, AppServices, LabFeature,
    RecoverScan, SessionSummary, WalletSnapshot, APP_VERSION,
};
use crate::theme::AppearancePreference;
use crate::ui::auth::PasswordField;
use crate::ui::EmptyState;
use aeon_ui::{button, list_row};
use dioxus::prelude::*;
use std::sync::Arc;

/// 1:1 port of `src/components/ReceivePanel.tsx`.
#[component]
pub fn ReceivePanel(profile: SessionSummary, mut toast: Signal<Option<ToastNotice>>) -> Element {
    let mut mode = use_signal(|| "address");
    let current_mode = *mode.read();
    let value = if current_mode == "peerpay" {
        format!("peerpay:{}", profile.identity_key)
    } else {
        profile.address.clone()
    };
    let qr_svg = render_qr_svg(&value);
    let val_for_qr = value.clone();
    let val_for_addr = value.clone();
    let val_for_btn = value.clone();

    rsx! {
        div {
            class: "nav-child-panel receive-panel",
            "data-aeon-scope": "receive",
            "data-chain": "bsv",
            div { class: "receive-layout",
                header { class: "receive-panel-intro",
                    h3 { class: "receive-panel-title", "Receive BSV" }
                }

                div { class: "receive-qr", "data-aeon-part": "media",
                    button {
                        r#type: "button",
                        class: "qr-frame receive-qr-frame",
                        title: "Click to copy",
                        onclick: move |_| match copy_to_clipboard(&val_for_qr) {
                            Ok(()) => toast.set(Some(ToastNotice {
                                title: "Copied".into(),
                                body: Some("Receive address copied.".into()),
                                tone: "success",
                            })),
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Copy failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        },
                        div { dangerous_inner_html: "{qr_svg}" }
                    }
                    div { class: "receive-mode-toggle", role: "group",
                        button {
                            r#type: "button",
                            class: "receive-mode-opt",
                            "data-active": if current_mode == "peerpay" { Some("") } else { None },
                            aria_pressed: current_mode == "peerpay",
                            onclick: move |_| mode.set("peerpay"),
                            "PeerPay"
                        }
                        button {
                            r#type: "button",
                            class: "receive-mode-opt",
                            "data-active": if current_mode == "address" { Some("") } else { None },
                            aria_pressed: current_mode == "address",
                            onclick: move |_| mode.set("address"),
                            "Address"
                        }
                    }
                }

                div { class: "receive-side",
                    div { class: "field receive-address-field",
                        label {
                            if current_mode == "peerpay" { "PeerPay link" } else { "BSV address" }
                        }
                        button {
                            r#type: "button",
                            class: "mono qr-value receive-address",
                            title: "Click to copy",
                            onclick: move |_| match copy_to_clipboard(&val_for_addr) {
                                Ok(()) => toast.set(Some(ToastNotice {
                                    title: "Copied".into(),
                                    body: Some("Copied to clipboard.".into()),
                                    tone: "success",
                                })),
                                Err(e) => toast.set(Some(ToastNotice {
                                    title: "Copy failed".into(),
                                    body: Some(e),
                                    tone: "error",
                                })),
                            },
                            "{value}"
                        }
                    }
                    p { class: "receive-eta-row", "data-native": "",
                        span { class: "receive-eta-label", "Arrival" }
                        strong { class: "receive-eta-value", "Instant · BSV" }
                    }
                }

                div { class: "actions receive-actions",
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        onclick: move |_| match copy_to_clipboard(&val_for_btn) {
                            Ok(()) => toast.set(Some(ToastNotice {
                                title: "Copied".into(),
                                body: Some("Copied to clipboard.".into()),
                                tone: "success",
                            })),
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Copy failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        },
                        button::Label {
                            if current_mode == "peerpay" { "Copy PeerPay" } else { "Copy address" }
                        }
                    }
                }
            }
        }
    }
}

#[component]
pub fn SwapPanel() -> Element {
    rsx! {
        div { class: "nav-child-panel",
            EmptyState {
                icon: Some(rsx! { SwapIcon { size: 28 } }),
                title: "Swap BSV",
                body: Some("Cross-chain swaps arrive natively in the next Rust engine milestone.".into()),
            }
        }
    }
}

#[component]
pub fn ScanPanel(mut nav_child: Signal<Option<NavChild>>) -> Element {
    rsx! {
        div { class: "nav-child-panel",
            EmptyState {
                icon: Some(rsx! { ScanQrIcon { size: 28 } }),
                title: "Scan QR code",
                body: Some("Paste a BSV address or PeerPay URI directly in Send.".into()),
                action: Some(rsx! {
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        onclick: move |_| nav_child.set(Some(NavChild::Send(None))),
                        button::Label { "Open Send" }
                    }
                }),
            }
        }
    }
}

/// 1:1 port of `src/components/IdentityPanel.tsx`.
#[component]
pub fn IdentityPanel(profile: SessionSummary, mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let details = services.load_identity_details(&profile);
    let qr_svg = render_qr_svg(&profile.identity_key);
    let handle_str = details
        .claimed_handle
        .clone()
        .unwrap_or_else(|| format!("${}", profile.handle));
    let handle_copy = handle_str.clone();
    let id_copy = profile.identity_key.clone();
    let addr_copy = profile.address.clone();
    let bap_copy = details.bap_profile_id.clone();

    rsx! {
        div {
            class: "nav-section-body identity-nav nav-section-with-scroll",
            "data-aeon-scope": "identity",
            div { class: "connected-panel-head",
                h2 { "Identity" }
            }
            div { class: "nav-section-scroll-body",
                section { class: "identity-card", aria_label: "Wallet identity",
                    div { class: "identity-hero",
                        div { class: "identity-qr",
                            div { class: "identity-qr-frame",
                                div { dangerous_inner_html: "{qr_svg}" }
                            }
                        }
                        section {
                            class: "handle-ipt",
                            "data-aeon-scope": "handle-ipt",
                            "data-aeon-state": "held",
                            header { "data-aeon-part": "head",
                                h3 { "data-aeon-part": "title", "Handle" }
                                span { "data-aeon-part": "profile", "{profile.derivation}" }
                            }
                            div { "data-aeon-part": "held",
                                button {
                                    r#type: "button",
                                    class: "identity-qr-handle",
                                    "data-aeon-part": "label",
                                    onclick: move |_| {
                                        if copy_to_clipboard(&handle_copy).is_ok() {
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some(format!("{handle_copy} copied.")),
                                                tone: "success",
                                            }));
                                        }
                                    },
                                    "{handle_str}"
                                }
                                span { "data-aeon-part": "owned", "Owned" }
                            }
                        }
                    }

                    ul { class: "identity-list",
                        if let Some(ref name) = details.display_name {
                            li { class: "identity-field",
                                span { class: "identity-field-label", "Display name" }
                                strong { "{name}" }
                            }
                        }
                        if let Some(ref bio) = details.bio {
                            li { class: "identity-field",
                                span { class: "identity-field-label", "Bio" }
                                span { class: "settings-row-desc", "{bio}" }
                            }
                        }
                        li { class: "identity-field",
                            span { class: "identity-field-label", "Network" }
                            strong {
                                class: "identity-network",
                                "data-network": "{profile.chain}",
                                if profile.chain == "main" {
                                    "Bitcoin SV Mainnet"
                                } else {
                                    "Bitcoin SV Testnet"
                                }
                            }
                        }
                        if let Some(ref bap_id) = bap_copy {
                            {
                                let bap_c = bap_id.clone();
                                rsx! {
                                    li { class: "identity-field",
                                        span { class: "identity-field-label", "Profile ID (BAP)" }
                                        button {
                                            r#type: "button",
                                            class: "mono identity-bap-id",
                                            style: "background: transparent; border: none; color: inherit; cursor: pointer; padding: 0;",
                                            onclick: move |_| {
                                                if copy_to_clipboard(&bap_c).is_ok() {
                                                    toast.set(Some(ToastNotice {
                                                        title: "Copied".into(),
                                                        body: Some("Profile ID copied.".into()),
                                                        tone: "success",
                                                    }));
                                                }
                                            },
                                            "{truncate_mid(bap_id, 12)}"
                                        }
                                    }
                                }
                            }
                        }
                        li { class: "identity-field",
                            span { class: "identity-field-label", "Identity key" }
                            button {
                                r#type: "button",
                                class: "mono identity-bap-id",
                                style: "background: transparent; border: none; color: inherit; cursor: pointer; padding: 0;",
                                onclick: move |_| {
                                    if copy_to_clipboard(&id_copy).is_ok() {
                                        toast.set(Some(ToastNotice {
                                            title: "Copied".into(),
                                            body: Some("Identity key copied.".into()),
                                            tone: "success",
                                        }));
                                    }
                                },
                                "{truncate_mid(&profile.identity_key, 12)}"
                            }
                        }
                        li { class: "identity-field",
                            span { class: "identity-field-label", "Receive address" }
                            button {
                                r#type: "button",
                                class: "mono identity-bap-id",
                                style: "background: transparent; border: none; color: inherit; cursor: pointer; padding: 0;",
                                onclick: move |_| {
                                    if copy_to_clipboard(&addr_copy).is_ok() {
                                        toast.set(Some(ToastNotice {
                                            title: "Copied".into(),
                                            body: Some("Receive address copied.".into()),
                                            tone: "success",
                                        }));
                                    }
                                },
                                "{truncate_mid(&profile.address, 12)}"
                            }
                        }
                        li { class: "identity-field",
                            span { class: "identity-field-label", "Account" }
                            strong { class: "mono", "#{profile.account_index} · {profile.derivation}" }
                        }
                    }

                    if !details.public_identities.is_empty() {
                        ul { class: "identity-list", style: "margin-top: 10px;",
                            for (pub_name, pub_id) in details.public_identities.iter() {
                                li { key: "{pub_id}", class: "identity-field",
                                    span { class: "identity-field-label", "{pub_name}" }
                                    span { class: "mono", "{truncate_mid(pub_id, 10)}" }
                                }
                            }
                        }
                    }
                    p { class: "identity-note",
                        "People pay your wallet key, and your profile is signed by it: a copycat can borrow your name and picture, never this key."
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/SettingsPanel.tsx`.
#[component]
pub fn SettingsPanel(
    snap: WalletSnapshot,
    mut appearance: Signal<AppearancePreference>,
    mut nav_child: Signal<Option<NavChild>>,
    fiat_code: Signal<FiatCode>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let app_pref = *appearance.read();
    let mut accepted = use_signal(|| services.load_accepted_coins());
    let accepted_now = *accepted.read();
    let mut open = move |sub: SettingSubpage| nav_child.set(Some(NavChild::Setting(sub)));
    let health = use_dependency_health();
    {
        let svc = Arc::clone(&services);
        use_hook(move || spawn_health_refresh(&svc, None));
    }
    let health_view = health.read().clone();
    let health_alert = dependency_health_alert(&health_view);
    let alerting = matches!(health_alert, HealthAlert::Warn | HealthAlert::Error);
    let health_desc = if health_view.at == 0 {
        "Checking…".to_string()
    } else {
        health_view.summary.clone()
    };

    rsx! {
        div {
            class: "nav-section-body settings-nav settings-with-scroll",
            "data-aeon-scope": "settings",
            div { class: "connected-panel-head settings-panel-head",
                h2 { "Settings" }
            }
            div { class: "settings-scroll-body",
                // HandCash Recovery section
                section { class: "settings-group", "data-aeon-part": "handcash-recovery",
                    h3 { class: "settings-group-title", "HandCash Recovery" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Back this up on another device",
                            description: "Each device keeps a full copy",
                            icon: setting_icon(SettingSubpage::HandCashRecovery),
                            onclick: move |_| open(SettingSubpage::HandCashRecovery),
                        }
                    }
                }

                // Security section (`SECURITY_ITEMS` in SettingsPanel.tsx)
                section { class: "settings-group", "data-aeon-part": "security",
                    h3 { class: "settings-group-title", "Security" }
                    ul { class: "settings-list",
                        for (sub, label, description) in SECURITY_ITEMS {
                            SettingsNavRow {
                                key: "{label}",
                                label,
                                description,
                                tone: setting_tone(sub),
                                icon: setting_icon(sub),
                                onclick: move |_| open(sub),
                            }
                        }
                    }
                }

                // Preferences section
                section { class: "settings-group", "data-aeon-part": "preferences",
                    h3 { class: "settings-group-title", "Preferences" }
                    ul { class: "settings-list",
                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Leading {
                                    span { class: "settings-row-icon", "data-tone": "default",
                                        PaletteIcon { size: 20 }
                                    }
                                }
                                list_row::Label { "Appearance" }
                                list_row::Description {
                                    if app_pref == AppearancePreference::System {
                                        "Follows Omarchy or your system theme."
                                    } else if app_pref == AppearancePreference::Dark {
                                        "HandCash OLED dark sheet."
                                    } else {
                                        "HandCash light paper sheet."
                                    }
                                }
                                list_row::Trailing {
                                    div { class: "settings-icon-toggle", role: "radiogroup", aria_label: "Appearance",
                                        for (pref, label) in [
                                            (AppearancePreference::System, "System"),
                                            (AppearancePreference::Dark, "Dark"),
                                            (AppearancePreference::Light, "Light"),
                                        ] {
                                            {
                                                let svc_app = Arc::clone(&services);
                                                rsx! {
                                                    button {
                                                        r#type: "button",
                                                        class: "settings-icon-toggle-btn",
                                                        title: "{label}",
                                                        aria_label: "{label}",
                                                        "data-selected": if app_pref == pref { Some("") } else { None },
                                                        onclick: move |_| {
                                                            appearance.set(pref);
                                                            svc_app.save_appearance(pref);
                                                        },
                                                        match pref {
                                                            AppearancePreference::System => rsx! { MonitorIcon { size: 16 } },
                                                            AppearancePreference::Dark => rsx! { DarkModeIcon { size: 16 } },
                                                            AppearancePreference::Light => rsx! { LightModeIcon { size: 16 } },
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Leading {
                                    span { class: "settings-row-icon", "data-tone": "default",
                                        CoinGlyphIcon { size: 20 }
                                    }
                                }
                                list_row::Label { "Accept" }
                                list_row::Description {
                                    "{accepted_now.title()}. {accepted_now.description()}"
                                }
                                list_row::Trailing {
                                    div { class: "settings-icon-toggle", role: "radiogroup", aria_label: "Accept",
                                        for choice in AcceptedCoins::CHOICES {
                                            {
                                                let svc_coins = Arc::clone(&services);
                                                rsx! {
                                                    button {
                                                        r#type: "button",
                                                        class: "settings-icon-toggle-btn",
                                                        title: "{choice.title()}",
                                                        aria_label: "{choice.title()}",
                                                        "data-selected": if accepted_now == choice { Some("") } else { None },
                                                        onclick: move |_| {
                                                            accepted.set(choice);
                                                            svc_coins.save_accepted_coins(choice);
                                                        },
                                                        match choice {
                                                            AcceptedCoins::Bitcoin => rsx! { CoinGlyphIcon { size: 16 } },
                                                            AcceptedCoins::All => rsx! {
                                                                span { class: "accepted-coins-glyphs",
                                                                    CoinGlyphIcon { size: 12 }
                                                                    LtcGlyphIcon { size: 12 }
                                                                }
                                                            },
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Leading {
                                    span { class: "settings-row-icon", "data-tone": "default",
                                        ArcUsdGlyphIcon { size: 20 }
                                    }
                                }
                                list_row::Label { "Currency" }
                                list_row::Description { "Currency for balances and totals." }
                                list_row::Trailing {
                                    SettingsFiatDropdown { fiat_code }
                                }
                            }
                        }

                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Leading {
                                    span { class: "settings-row-icon", "data-tone": "default",
                                        InfoIcon { size: 20 }
                                    }
                                }
                                list_row::Label { "Version {APP_VERSION}" }
                                list_row::Description {
                                    "Pure-Rust SQLite WAL · Engine phase {snap.engine_phase}"
                                }
                            }
                        }
                    }
                }

                // Apps section
                section { class: "settings-group", "data-aeon-part": "chart-apps",
                    h3 { class: "settings-group-title", "Apps" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Apps",
                            description: CHART_APPS_DESCRIPTION,
                            icon: setting_icon(SettingSubpage::ChartApps),
                            onclick: move |_| open(SettingSubpage::ChartApps),
                        }
                    }
                }

                // Support section
                section { class: "settings-group", "data-aeon-part": "support",
                    h3 { class: "settings-group-title", "Support" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Wallet health",
                            description: if alerting { String::new() } else { health_desc.clone() },
                            status: if alerting { Some(health_desc.clone()) } else { None },
                            status_tone: "warn",
                            icon: setting_icon(SettingSubpage::WalletHealth),
                            onclick: move |_| open(SettingSubpage::WalletHealth),
                            trailing_end: if alerting {
                                Some(rsx! { WalletHealthAlertBadge { tone: health_alert.as_str() } })
                            } else {
                                None
                            },
                        }
                        SettingsNavRow {
                            label: "Recover from transaction",
                            description: "Claim a token or item by its txid",
                            icon: setting_icon(SettingSubpage::RecoverTx),
                            onclick: move |_| open(SettingSubpage::RecoverTx),
                        }
                        SettingsNavRow {
                            label: "Session logs",
                            description: "View, copy, and open log folder",
                            icon: setting_icon(SettingSubpage::Logs),
                            onclick: move |_| open(SettingSubpage::Logs),
                        }
                        SettingsNavRow {
                            label: "Statecharts",
                            description: "Live app and engine state",
                            icon: setting_icon(SettingSubpage::Statecharts),
                            onclick: move |_| open(SettingSubpage::Statecharts),
                        }
                    }
                }

                // Labs section
                section { class: "settings-group", "data-aeon-part": "labs",
                    h3 { class: "settings-group-title", "Labs" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Labs",
                            description: "Experimental features, off by default",
                            icon: setting_icon(SettingSubpage::Labs),
                            onclick: move |_| open(SettingSubpage::Labs),
                        }
                    }
                }

                // About section
                section { class: "settings-group", "data-aeon-part": "about",
                    h3 { class: "settings-group-title", "About" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "HandCash",
                            description: "Desktop wallet",
                            icon: setting_icon(SettingSubpage::About),
                            onclick: move |_| open(SettingSubpage::About),
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/settings/SettingsFiatDropdown.tsx`. Shares the
/// durable `fiat_code` signal with the hero `FiatCurrencyMenu`.
#[component]
fn SettingsFiatDropdown(mut fiat_code: Signal<FiatCode>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut open = use_signal(|| false);
    let is_open = *open.read();
    let current = *fiat_code.read();

    rsx! {
        div {
            class: "wallet-account-menu settings-fiat-menu",
            "data-aeon-scope": "wallet-account-menu",
            "data-aeon-state": if is_open { "open" } else { "closed" },
            onkeydown: move |e: KeyboardEvent| {
                if e.key() == Key::Escape {
                    open.set(false);
                }
            },
            button {
                r#type: "button",
                class: "wallet-hero-identity settings-fiat-trigger",
                "data-aeon-part": "trigger",
                aria_controls: "settings-fiat-dropdown",
                aria_expanded: is_open,
                aria_haspopup: "listbox",
                aria_label: "Currency: {current.iso()}",
                onclick: move |_| open.set(!is_open),
                span { class: "settings-fiat-flag", aria_hidden: true, "{current.flag()}" }
                span { "{current.iso()}" }
                ExpandMoreIcon {
                    size: 16,
                    class: if is_open { "wallet-account-caret is-open" } else { "wallet-account-caret" },
                }
            }
            if is_open {
                section {
                    id: "settings-fiat-dropdown",
                    class: "wallet-account-dropdown settings-fiat-dropdown",
                    "data-aeon-part": "content",
                    aria_label: "Choose currency",
                    header { class: "wallet-account-heading",
                        div { strong { "Choose currency" } }
                        span { class: "wallet-account-count", "{FiatCode::ALL.len()}" }
                    }
                    ul { class: "wallet-account-list", role: "listbox", aria_label: "Government currency",
                        for opt in FiatCode::ALL {
                            {
                                let selected = opt == current;
                                let svc = Arc::clone(&services);
                                rsx! {
                                    li { key: "{opt.as_str()}", role: "none",
                                        button {
                                            r#type: "button",
                                            role: "option",
                                            aria_selected: selected,
                                            class: if selected { "wallet-account-option is-selected" } else { "wallet-account-option" },
                                            onclick: move |_| {
                                                fiat_code.set(opt);
                                                svc.save_fiat_currency(opt);
                                                if svc.current_fx_rates().rate_for(opt).is_none() {
                                                    let svc_bg = Arc::clone(&svc);
                                                    svc.engine.runtime_handle().spawn(async move {
                                                        svc_bg.refresh_fx_rates_async().await;
                                                    });
                                                }
                                                open.set(false);
                                            },
                                            span { class: "wallet-account-option-lead",
                                                span { class: "settings-fiat-flag", aria_hidden: true, "{opt.flag()}" }
                                                span { class: "wallet-account-option-copy",
                                                    strong { "{opt.iso()}" }
                                                    span { "{opt.name()}" }
                                                }
                                            }
                                            if selected {
                                                CheckIcon { size: 17, class: "wallet-account-option-check" }
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

/// Mirrors `CHART_APPS_DESCRIPTION` in `src/apps/chartFormat.ts`.
const CHART_APPS_DESCRIPTION: &str =
    "Small single-purpose apps your wallet runs itself. Not a replacement for websites.";

/// 1:1 port of `SECURITY_ITEMS` in `src/components/SettingsPanel.tsx`.
const SECURITY_ITEMS: [(SettingSubpage, &str, &str); 7] = [
    (
        SettingSubpage::Backup,
        "Recovery backup",
        "Save your phrase or key slices",
    ),
    (
        SettingSubpage::HistoryBackup,
        "History",
        "Required for recovery",
    ),
    (
        SettingSubpage::DeviceHandoff,
        "Device backup",
        "Keep a copy on your other device",
    ),
    (
        SettingSubpage::SigninEmail,
        "Sign-in email",
        "For new devices that can\u{2019}t reach this one",
    ),
    (
        SettingSubpage::Import,
        "Import",
        "HandCash, Twetch, Yours, phrases and keys",
    ),
    (
        SettingSubpage::Unlock,
        "Unlock",
        "Device lock or HandCash password",
    ),
    (
        SettingSubpage::WipeWallet,
        "Wipe wallet",
        "Remove from this device",
    ),
];

/// Port of `settingIconFor` tone in `src/components/settings/settingIcons.tsx`.
fn setting_tone(sub: SettingSubpage) -> &'static str {
    match sub {
        SettingSubpage::WipeWallet => "danger",
        _ => "default",
    }
}

/// Port of `settingIconFor` icon in `src/components/settings/settingIcons.tsx`.
fn setting_icon(sub: SettingSubpage) -> Element {
    match sub {
        SettingSubpage::Backup | SettingSubpage::HandCashRecovery => {
            rsx! { EncryptIcon { size: 20 } }
        }
        SettingSubpage::HistoryBackup => rsx! { DownloadIcon { size: 20 } },
        SettingSubpage::DeviceHandoff | SettingSubpage::SigninEmail => {
            rsx! { DevicesIcon { size: 20 } }
        }
        SettingSubpage::Import | SettingSubpage::RecoverTx => rsx! { RefreshIcon { size: 20 } },
        SettingSubpage::Unlock => rsx! { LockIcon { size: 20 } },
        SettingSubpage::WipeWallet => rsx! { WarningIcon { size: 20 } },
        SettingSubpage::About => rsx! { LaunchIcon { size: 20 } },
        SettingSubpage::Statecharts | SettingSubpage::WalletHealth => {
            rsx! { ActivityIcon { size: 20 } }
        }
        SettingSubpage::Logs => rsx! { FileIcon { size: 20 } },
        SettingSubpage::Labs => rsx! { CodeIcon { size: 20 } },
        SettingSubpage::ChartApps => rsx! { AppsIcon { size: 20 } },
    }
}

#[component]
fn SettingsNavRow(
    label: &'static str,
    #[props(into, default)] description: String,
    /// Live status replaces the description (`status || description` in TS).
    #[props(default)] status: Option<String>,
    #[props(default = "muted")] status_tone: &'static str,
    #[props(default = "default")] tone: &'static str,
    icon: Element,
    onclick: EventHandler<MouseEvent>,
    #[props(default)] trailing_end: Option<Element>,
) -> Element {
    let desc_state = if status.is_some() { status_tone } else { "idle" };
    let desc = status.unwrap_or(description);
    rsx! {
        li { class: "settings-nav-item",
            list_row::Root {
                class: "settings-nav-row",
                onclick: move |evt| onclick.call(evt),
                list_row::Leading {
                    span { class: "settings-row-icon", "data-tone": "{tone}", {icon} }
                }
                list_row::Label { "{label}" }
                if !desc.is_empty() {
                    list_row::Description { "data-aeon-state": "{desc_state}", "{desc}" }
                }
                if let Some(end) = trailing_end {
                    list_row::Trailing { {end} }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/settings/WalletHealthAlertBadge.tsx`.
#[component]
fn WalletHealthAlertBadge(tone: &'static str) -> Element {
    rsx! {
        div { class: "settings-icon-toggle wallet-health-trailing", aria_hidden: "true",
            span {
                class: "settings-icon-toggle-btn wallet-health-alert",
                "data-tone": "{tone}",
                "data-selected": "",
                WarningIcon { size: 16 }
            }
        }
    }
}

/// Live dependency-health snapshot (`subscribeDependencyHealth`).
fn use_dependency_health() -> Signal<DependencyHealthSnapshot> {
    let services = use_context::<Arc<AppServices>>();
    let mut snap = use_signal(|| services.dependency_health());
    use_future(move || {
        let svc = Arc::clone(&services);
        async move {
            let mut rx = svc.subscribe_dependency_health();
            while rx.changed().await.is_ok() {
                snap.set(rx.borrow().clone());
            }
        }
    });
    snap
}

/// Fire one probe pass on the engine runtime; `done` flips back when it lands.
fn spawn_health_refresh(services: &Arc<AppServices>, mut running: Option<Signal<bool>>) {
    if let Some(r) = running.as_mut() {
        r.set(true);
    }
    let svc = Arc::clone(services);
    let handle = svc.engine.runtime_handle().clone();
    let task = handle.spawn(async move {
        svc.refresh_dependency_health_async().await;
    });
    if let Some(mut r) = running {
        spawn(async move {
            let _ = task.await;
            r.set(false);
        });
    }
}

/// 1:1 port of `src/components/settings/WalletHealthPanel.tsx`.
#[component]
fn WalletHealthPanel() -> Element {
    let services = use_context::<Arc<AppServices>>();
    let snap = use_dependency_health();
    let checking = use_signal(|| false);
    {
        let svc = Arc::clone(&services);
        use_hook(move || spawn_health_refresh(&svc, Some(checking)));
    }
    let is_checking = *checking.read();
    let view = snap.read().clone();
    let svc_btn = Arc::clone(&services);

    rsx! {
        div { class: "nav-section-body settings-nav", "data-aeon-scope": "wallet-health",
            div { class: "connected-panel-head settings-panel-head",
                h2 { "Wallet health" }
                div {
                    class: "connected-panel-head-actions",
                    "data-aeon-part": "health-actions",
                    "data-aeon-state": if is_checking { "running" } else { "idle" },
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary settings-action-btn",
                        disabled: is_checking,
                        onclick: move |_| spawn_health_refresh(&svc_btn, Some(checking)),
                        button::Label { if is_checking { "Checking…" } else { "Refresh" } }
                    }
                }
            }

            ul { class: "settings-list",
                for probe in view.probes.iter() {
                    li { key: "{probe.id}",
                        list_row::Root { "data-aeon-layout": "control",
                            list_row::Label { "{probe.label}" }
                            list_row::Description {
                                if is_checking && view.at == 0 { "…" } else { "{probe.detail}" }
                            }
                            list_row::Trailing {
                                span {
                                    class: "status-pill status-pill-compact",
                                    "data-tone": "{probe.status.tone()}",
                                    "data-aeon-state": "{probe.status.as_str()}",
                                    "{probe.status.label()}"
                                }
                            }
                        }
                    }
                }
            }

            section { class: "settings-group", "data-aeon-part": "utxo-heal",
                h3 { class: "settings-group-title", "Local recovery" }
                ul { class: "settings-list",
                    li {
                        list_row::Root { "data-aeon-layout": "control",
                            list_row::Leading {
                                span { class: "settings-row-icon", "data-tone": "default",
                                    SystemUpdateIcon { size: 20 }
                                }
                            }
                            list_row::Label { "Heal wallet UTXOs" }
                            list_row::Description {
                                "UTXO heal is not available in the native Rust build yet."
                            }
                            list_row::Trailing {
                                span {
                                    class: "status-pill status-pill-compact",
                                    "data-tone": "muted",
                                    "data-aeon-state": "unavailable",
                                    "—"
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary settings-action-btn",
                                    disabled: true,
                                    "data-aeon-part": "heal-action",
                                    "data-aeon-state": "unavailable",
                                    button::Label { "Heal" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/SettingsFeatureAbout.tsx`.
#[component]
pub fn SettingsFeatureAbout(tags: &'static [&'static str], copy: &'static str) -> Element {
    rsx! {
        footer { class: "settings-feature-about", "data-aeon-scope": "feature-about",
            div { class: "settings-feature-about-tags",
                for tag in tags.iter().copied() {
                    span { key: "{tag}", class: "spec-tag", "{tag}" }
                }
            }
            p { class: "settings-feature-about-copy", "{copy}" }
        }
    }
}

/// 1:1 port of `src/components/WalletBackupPanel.tsx`.
#[component]
fn WalletBackupPanel(
    profile: SessionSummary,
    mut nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let has_phrase = profile.has_mnemonic;
    let mut kind = use_signal(|| if has_phrase { "phrase" } else { "key" });
    let mut revealed = use_signal(|| false);
    let mut copied = use_signal(|| false);

    let cur_kind = *kind.read();
    let is_revealed = *revealed.read();
    let can_confirm = *copied.read();
    let phrase_val = if is_revealed && cur_kind == "phrase" {
        services.current_mnemonic()
    } else {
        None
    };
    let key_val = if is_revealed && cur_kind == "key" {
        services.current_root_key_hex()
    } else {
        None
    };
    let svc_confirm_phrase = Arc::clone(&services);
    let svc_confirm_key = Arc::clone(&services);

    rsx! {
        div {
            class: "nav-section-body settings-scroll",
            "data-aeon-scope": "wallet-backup",
            "data-aeon-state": if is_revealed { "revealed" } else { "idle" },
            p { class: "settings-hint",
                "Save two of three slices in separate accounts or apps you control; HandCash receives none."
            }
            div { class: "backup-format-tabs", role: "tablist", aria_label: "Recovery formats",
                button {
                    r#type: "button",
                    role: "tab",
                    aria_selected: if cur_kind == "split" { "true" } else { "false" },
                    class: if cur_kind == "split" { "btn btn-primary" } else { "btn btn-ghost" },
                    disabled: true,
                    title: "BRC-140 slice issuance is pending GF(256) splitter port",
                    "Key slices"
                }
                button {
                    r#type: "button",
                    role: "tab",
                    aria_selected: if cur_kind == "phrase" { "true" } else { "false" },
                    class: if cur_kind == "phrase" { "btn btn-primary" } else { "btn btn-ghost" },
                    disabled: !has_phrase,
                    onclick: move |_| {
                        revealed.set(false);
                        copied.set(false);
                        kind.set("phrase");
                    },
                    "Recovery phrase"
                }
                button {
                    r#type: "button",
                    role: "tab",
                    aria_selected: if cur_kind == "key" { "true" } else { "false" },
                    class: if cur_kind == "key" { "btn btn-primary" } else { "btn btn-ghost" },
                    onclick: move |_| {
                        revealed.set(false);
                        copied.set(false);
                        kind.set("key");
                    },
                    "Emergency key"
                }
            }

            if !is_revealed {
                div { class: "confirm-password-gate", "data-aeon-scope": "reveal-recovery",
                    div { class: "confirm-password-copy",
                        h3 { class: "confirm-password-title", "Show recovery material" }
                        p { class: "confirm-password-lede",
                            "The wallet is unlocked; no password is needed to show backups."
                        }
                    }
                    div {
                        class: "actions",
                        "data-aeon-part": "reveal-actions",
                        "data-aeon-state": "idle",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| {
                                copied.set(false);
                                revealed.set(true);
                            },
                            button::Label {
                                if cur_kind == "phrase" { "Show phrase" } else { "Show key" }
                            }
                        }
                    }
                }
            }

            if let Some(ref phrase) = phrase_val {
                {
                    let words: Vec<String> = phrase
                        .split_whitespace()
                        .map(ToString::to_string)
                        .collect();
                    let p_copy = phrase.clone();
                    rsx! {
                        div { class: "split-backup-shares",
                            p { class: "settings-hint", "Keep these words private." }
                            ol { class: "recovery-phrase-grid",
                                for (i, word) in words.iter().enumerate() {
                                    li { key: "{i}-{word}",
                                        span { class: "recovery-phrase-index", "{i + 1}." }
                                        " {word}"
                                    }
                                }
                            }
                            div { class: "actions",
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        if copy_to_clipboard(&p_copy).is_ok() {
                                            copied.set(true);
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some("Recovery phrase copied.".into()),
                                                tone: "success",
                                            }));
                                        }
                                    },
                                    button::Label { "Copy" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !can_confirm,
                                    onclick: move |_| {
                                        svc_confirm_phrase.mark_keys_backup_confirmed("phrase");
                                        revealed.set(false);
                                        toast.set(Some(ToastNotice {
                                            title: "Keys backup saved".into(),
                                            body: Some("History backup is next if you have not done it yet.".into()),
                                            tone: "success",
                                        }));
                                        nav_child.set(Some(NavChild::Setting(SettingSubpage::HistoryBackup)));
                                    },
                                    button::Label { "I’ve saved my phrase" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        revealed.set(false);
                                        copied.set(false);
                                    },
                                    button::Label { "Hide" }
                                }
                            }
                        }
                    }
                }
            }

            if let Some(ref rk) = key_val {
                {
                    let rk_copy = rk.clone();
                    rsx! {
                        div { class: "split-backup-shares",
                            p { class: "settings-hint", "Keep this key private." }
                            p { class: "mono backup-root-key", "{rk}" }
                            div { class: "actions",
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        if copy_to_clipboard(&rk_copy).is_ok() {
                                            copied.set(true);
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some("Emergency key copied.".into()),
                                                tone: "success",
                                            }));
                                        }
                                    },
                                    button::Label { "Copy" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !can_confirm,
                                    onclick: move |_| {
                                        svc_confirm_key.mark_keys_backup_confirmed("key");
                                        revealed.set(false);
                                        toast.set(Some(ToastNotice {
                                            title: "Keys backup saved".into(),
                                            body: Some("History backup is next if you have not done it yet.".into()),
                                            tone: "success",
                                        }));
                                        nav_child.set(Some(NavChild::Setting(SettingSubpage::HistoryBackup)));
                                    },
                                    button::Label { "I’ve saved my key" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        revealed.set(false);
                                        copied.set(false);
                                    },
                                    button::Label { "Hide" }
                                }
                            }
                        }
                    }
                }
            }

            SettingsFeatureAbout {
                tags: &["BRC-140", "BRC-157", "BRC-75"],
                copy: "Any two slices from one set restore the wallet. Only Replace slice set creates a new set.",
            }
        }
    }
}

/// 1:1 port of `src/components/UnlockSettingsPanel.tsx` + `src/components/ConfirmPasswordGate.tsx`.
#[component]
fn UnlockSettingsPanel(mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut mode = use_signal(|| "overview");
    let mut gate_input = use_signal(String::new);
    let mut gate_verified_pw = use_signal(|| Option::<String>::None);
    let mut new_pw = use_signal(String::new);
    let mut confirm_pw = use_signal(String::new);
    let mut error_msg = use_signal(|| Option::<String>::None);
    let mut rev = use_signal(|| 0u64);
    let _ = *rev.read();

    let cur_mode = *mode.read();
    let no_lock = services.is_no_device_lock();
    let has_mem_pw = services.has_memorable_password();

    if cur_mode == "change-password" && gate_verified_pw.read().is_none() {
        let svc_gate = Arc::clone(&services);
        let pw_len = gate_input.read().len();
        return rsx! {
            div {
                class: "settings-detail settings-detail-compact settings-scroll",
                "data-aeon-scope": "settings-unlock",
                div {
                    class: "confirm-password-gate",
                    "data-aeon-scope": "confirm-password",
                    "data-aeon-state": "idle",
                    "data-factor": "password",
                    div { class: "confirm-password-copy",
                        h3 { class: "confirm-password-title", "Change password" }
                        p { class: "confirm-password-lede", "Confirm your current password to change it." }
                    }
                    form {
                        class: "settings-form settings-form-compact",
                        onsubmit: move |e| {
                            e.prevent_default();
                            error_msg.set(None);
                            let entered = gate_input.read().clone();
                            match svc_gate.verify_password(&entered) {
                                Ok(()) => {
                                    gate_input.set(String::new());
                                    gate_verified_pw.set(Some(entered));
                                }
                                Err(err) => error_msg.set(Some(err)),
                            }
                        },
                        PasswordField {
                            id: "unlock-change-password",
                            label: "HandCash password",
                            placeholder: "Your unlock password",
                            value: gate_input,
                        }
                        if let Some(ref err) = *error_msg.read() {
                            p { class: "error", role: "alert", "{err}" }
                        }
                        div { class: "actions",
                            button::Root {
                                variant: button::ButtonVariant::Solid,
                                button_type: "submit",
                                class: "btn btn-primary",
                                disabled: pw_len < 8,
                                button::Label { "Continue" }
                            }
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| {
                                    gate_input.set(String::new());
                                    error_msg.set(None);
                                    mode.set("overview");
                                },
                                button::Label { "Cancel" }
                            }
                        }
                    }
                }
            }
        };
    }

    if cur_mode == "change-password" {
        let svc_change = Arc::clone(&services);
        let new_empty = new_pw.read().is_empty();
        return rsx! {
            div {
                class: "settings-detail settings-detail-compact settings-scroll",
                "data-aeon-scope": "settings-unlock",
                "data-aeon-state": "change-password",
                div { class: "confirm-password-copy",
                    h3 { class: "confirm-password-title", "Choose a new password" }
                    p { class: "confirm-password-lede",
                        "This HandCash password is separate from your phone or computer unlock."
                    }
                }
                form {
                    class: "settings-form settings-form-compact",
                    "data-aeon-part": "factor-form",
                    "data-aeon-state": "idle",
                    onsubmit: move |e| {
                        e.prevent_default();
                        error_msg.set(None);
                        let np = new_pw.read().clone();
                        let cp = confirm_pw.read().clone();
                        if np != cp {
                            error_msg.set(Some("Passwords do not match".into()));
                            return;
                        }
                        if let Some(err) = handcash_primitives::vault::password_policy_error(&np) {
                            error_msg.set(Some(err));
                            return;
                        }
                        let cur = gate_verified_pw.read().clone().unwrap_or_default();
                        match svc_change.change_password(&cur, &np) {
                            Ok(()) => {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                gate_verified_pw.set(None);
                                mode.set("overview");
                                let next = *rev.read() + 1;
                                rev.set(next);
                                toast.set(Some(ToastNotice {
                                    title: "Password updated".into(),
                                    body: None,
                                    tone: "success",
                                }));
                            }
                            Err(err) => error_msg.set(Some(err)),
                        }
                    },
                    PasswordField {
                        id: "settings-new-password",
                        label: "New password",
                        placeholder: "10+ chars, letter and number",
                        value: new_pw,
                    }
                    PasswordField {
                        id: "settings-confirm-password",
                        label: "Confirm password",
                        placeholder: "Type it again",
                        value: confirm_pw,
                    }
                    if let Some(ref err) = *error_msg.read() {
                        p { class: "error", role: "alert", "{err}" }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            button_type: "submit",
                            class: "btn btn-primary",
                            disabled: new_empty,
                            button::Label { "Update password" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                gate_verified_pw.set(None);
                                error_msg.set(None);
                                mode.set("overview");
                            },
                            button::Label { "Back" }
                        }
                    }
                }
            }
        };
    }

    if cur_mode == "set-password" {
        let svc_set = Arc::clone(&services);
        let new_empty = new_pw.read().is_empty();
        return rsx! {
            div {
                class: "settings-detail settings-detail-compact settings-scroll",
                "data-aeon-scope": "settings-unlock",
                "data-aeon-state": "set-password",
                div { class: "confirm-password-copy",
                    h3 { class: "confirm-password-title", "Add a HandCash password" }
                    p { class: "confirm-password-lede",
                        "Backup unlock without biometrics; confirm with this device first."
                    }
                }
                form {
                    class: "settings-form settings-form-compact",
                    "data-aeon-part": "factor-form",
                    "data-aeon-state": "idle",
                    onsubmit: move |e| {
                        e.prevent_default();
                        error_msg.set(None);
                        let np = new_pw.read().clone();
                        let cp = confirm_pw.read().clone();
                        if np != cp {
                            error_msg.set(Some("Passwords do not match".into()));
                            return;
                        }
                        match svc_set.set_password_from_open(&np) {
                            Ok(()) => {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                mode.set("overview");
                                let next = *rev.read() + 1;
                                rev.set(next);
                                toast.set(Some(ToastNotice {
                                    title: "HandCash password added".into(),
                                    body: None,
                                    tone: "success",
                                }));
                            }
                            Err(err) => error_msg.set(Some(err)),
                        }
                    },
                    PasswordField {
                        id: "settings-set-password",
                        label: "HandCash password",
                        placeholder: "10+ chars, letter and number",
                        value: new_pw,
                    }
                    PasswordField {
                        id: "settings-set-password-confirm",
                        label: "Confirm password",
                        placeholder: "Type it again",
                        value: confirm_pw,
                    }
                    if let Some(ref err) = *error_msg.read() {
                        p { class: "error", role: "alert", "{err}" }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            button_type: "submit",
                            class: "btn btn-primary",
                            disabled: new_empty,
                            button::Label { "Save password" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                error_msg.set(None);
                                mode.set("overview");
                            },
                            button::Label { "Back" }
                        }
                    }
                }
            }
        };
    }

    rsx! {
        div {
            class: "settings-detail settings-detail-compact settings-scroll",
            "data-aeon-scope": "settings-unlock",
            "data-aeon-state": "overview",
            div { class: "confirm-password-copy",
                h3 { class: "confirm-password-title", "Unlock" }
                p { class: "confirm-password-lede",
                    if no_lock {
                        "This device opens the wallet without a prompt. Add a password any time."
                    } else {
                        "Use device unlock, a HandCash password, or both. Keep at least one."
                    }
                }
            }
            ul { class: "settings-list",
                li {
                    list_row::Root { "data-aeon-layout": "control",
                        list_row::Leading {
                            span { class: "settings-row-icon", "data-tone": "default",
                                FingerprintIcon { size: 20 }
                            }
                        }
                        list_row::Label { "Device unlock" }
                        list_row::Description { "Not available on this device" }
                    }
                }
                li {
                    list_row::Root { "data-aeon-layout": "control",
                        list_row::Leading {
                            span { class: "settings-row-icon", "data-tone": "default",
                                LockIcon { size: 20 }
                            }
                        }
                        list_row::Label { "HandCash password" }
                        list_row::Description {
                            if no_lock {
                                "Off · no prompt on this device"
                            } else if has_mem_pw {
                                "On · separate from device lock"
                            } else {
                                "Off"
                            }
                        }
                        list_row::Trailing {
                            if has_mem_pw {
                                div { class: "actions",
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        onclick: move |_| {
                                            error_msg.set(None);
                                            gate_input.set(String::new());
                                            gate_verified_pw.set(None);
                                            mode.set("change-password");
                                        },
                                        button::Label { "Change" }
                                    }
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        disabled: true,
                                        button::Label { "Remove" }
                                    }
                                }
                            } else {
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !no_lock,
                                    onclick: move |_| {
                                        error_msg.set(None);
                                        new_pw.set(String::new());
                                        confirm_pw.set(String::new());
                                        mode.set("set-password");
                                    },
                                    button::Label { "Add" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/AboutHandCashPanel.tsx`.
#[component]
fn AboutHandCashPanel(mut nav_child: Signal<Option<NavChild>>) -> Element {
    rsx! {
        div {
            class: "nav-section-body settings-scroll about-handcash",
            "data-aeon-scope": "about-handcash",
            p { class: "settings-hint about-handcash-lead",
                "Your Bitcoin SV keys stay here; you approve app access through the local bridge."
            }
            div { class: "about-handcash-body",
                p { "HandCash cannot recover your funds if you lose this device without a backup." }
            }
            section { class: "settings-group", "data-aeon-part": "app",
                h3 { class: "settings-group-title", "This app" }
                ul { class: "settings-list",
                    li {
                        list_row::Root { "data-aeon-layout": "control",
                            list_row::Leading {
                                span { class: "settings-row-icon", "data-tone": "default",
                                    InfoIcon { size: 20 }
                                }
                            }
                            list_row::Label { "Version" }
                            list_row::Trailing {
                                span { class: "settings-row-desc mono", "{APP_VERSION}" }
                            }
                        }
                    }
                    SettingsNavRow {
                        label: "Statecharts",
                        description: "The state machines behind each flow",
                        icon: setting_icon(SettingSubpage::Statecharts),
                        onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::Statecharts))),
                    }
                }
            }
        }
    }
}

/// Settings child panels (Recovery backup, Import BRC-38, Unlock/Password, Wallet health, About).
#[component]
pub fn SettingSubpagePanel(
    subpage: SettingSubpage,
    profile: SessionSummary,
    snap: WalletSnapshot,
    mut snapshot: Signal<WalletSnapshot>,
    nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();

    match subpage {
        SettingSubpage::Backup => rsx! {
            WalletBackupPanel {
                profile,
                nav_child,
                toast,
            }
        },
        SettingSubpage::Import => {
            let svc_import = Arc::clone(&services);
            rsx! {
                div { class: "nav-child-panel", style: "display: flex; flex-direction: column; gap: 14px;",
                    h3 { "Import BRC-38 backup" }
                    p { class: "settings-row-desc",
                        "Import a BRC-38 JSON backup directly into this account's SQLite WAL store."
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| {
                                if let Some(path) = rfd::FileDialog::new()
                                    .add_filter("BRC-38 JSON", &["json"])
                                    .pick_file()
                                {
                                    match std::fs::read_to_string(&path)
                                        .map_err(|e| e.to_string())
                                        .and_then(|raw| svc_import.import_brc38_json(raw))
                                    {
                                        Ok(msg) => {
                                            snapshot.set(svc_import.read_snapshot());
                                            toast.set(Some(ToastNotice {
                                                title: "Import complete".into(),
                                                body: Some(msg),
                                                tone: "success",
                                            }));
                                        }
                                        Err(e) => toast.set(Some(ToastNotice {
                                            title: "Import failed".into(),
                                            body: Some(e),
                                            tone: "error",
                                        })),
                                    }
                                }
                            },
                            DownloadIcon { size: 16 }
                            button::Label { "Choose BRC-38 JSON file" }
                        }
                    }
                }
            }
        }
        SettingSubpage::Unlock => rsx! {
            UnlockSettingsPanel { toast }
        },
        SettingSubpage::WalletHealth => rsx! { WalletHealthPanel {} },
        SettingSubpage::About => rsx! {
            AboutHandCashPanel { nav_child }
        },
        SettingSubpage::Labs => {
            let mut rev = use_signal(|| 0u64);
            let _ = *rev.read();
            rsx! {
                div {
                    class: "nav-child-panel",
                    "data-aeon-scope": "settings-labs",
                    style: "display: flex; flex-direction: column; gap: 14px;",
                    h3 { "Labs" }
                    p { class: "settings-row-desc",
                        "Experimental features, off by default. Stored locally in your durable settings."
                    }
                    ul { class: "settings-list",
                        for feature in LabFeature::ALL {
                            {
                                let enabled = services.lab_enabled(feature);
                                let svc_lab = Arc::clone(&services);
                                rsx! {
                                    li { key: "{feature.key()}",
                                        list_row::Root { "data-aeon-layout": "control",
                                            list_row::Label { "{feature.title()}" }
                                            list_row::Description { "{feature.description()}" }
                                            list_row::Trailing {
                                                button {
                                                    r#type: "button",
                                                    role: "switch",
                                                    aria_checked: enabled,
                                                    class: "settings-icon-toggle-btn",
                                                    style: "padding: 4px 10px; min-width: 52px;",
                                                    "data-selected": if enabled { Some("") } else { None },
                                                    onclick: move |_| {
                                                        svc_lab.set_lab_enabled(feature, !enabled);
                                                        let next = *rev.read() + 1;
                                                        rev.set(next);
                                                    },
                                                    if enabled { "On" } else { "Off" }
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
        SettingSubpage::Logs => {
            let mut log_rev = use_signal(|| 0u64);
            let _ = *log_rev.read();
            let payload = services.host_log.read_logs(Some(256 * 1024));
            let log_text = payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("No log entries yet.")
                .to_string();
            let log_path = payload
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let log_copy = log_text.clone();
            let svc_open = Arc::clone(&services);
            rsx! {
                div {
                    class: "nav-child-panel",
                    "data-aeon-scope": "settings-logs",
                    style: "display: flex; flex-direction: column; gap: 12px;",
                    h3 { "Session logs" }
                    p { class: "settings-row-desc",
                        "Logs are privacy-scrubbed before writing (no addresses, amounts, or raw identity keys)."
                    }
                    if !log_path.is_empty() {
                        p { class: "mono settings-row-desc", "{log_path}" }
                    }
                    div { class: "actions", style: "display: flex; gap: 8px; flex-wrap: wrap;",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| match copy_to_clipboard(&log_copy) {
                                Ok(()) => toast.set(Some(ToastNotice {
                                    title: "Copied".into(),
                                    body: Some("Session logs copied.".into()),
                                    tone: "success",
                                })),
                                Err(e) => toast.set(Some(ToastNotice {
                                    title: "Copy failed".into(),
                                    body: Some(e),
                                    tone: "error",
                                })),
                            },
                            button::Label { "Copy logs" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                let next = *log_rev.read() + 1;
                                log_rev.set(next);
                            },
                            button::Label { "Refresh" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                let _ = svc_open.host_log.open_logs();
                            },
                            button::Label { "Open folder" }
                        }
                    }
                    pre {
                        class: "mono",
                        style: "padding: 12px; border-radius: 10px; border: 1px solid var(--hc-border); background: var(--hc-field); max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 11px; line-height: 1.45;",
                        "{log_text}"
                    }
                }
            }
        }
        SettingSubpage::Statecharts => rsx! {
            div {
                class: "nav-child-panel",
                "data-aeon-scope": "settings-statecharts",
                style: "display: flex; flex-direction: column; gap: 12px;",
                h3 { "Statecharts" }
                p { class: "settings-row-desc",
                    "Live runtime states of the native Rust wallet machines."
                }
                ul { class: "identity-list",
                    li { class: "identity-field",
                        span { class: "identity-field-label", "Session" }
                        strong { class: "mono", "ready" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "Engine" }
                        strong { class: "mono", "phase {snap.engine_phase} · gen {snap.engine_generation}" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "Account" }
                        strong { class: "mono", "#{profile.account_index} · {profile.chain} · {profile.derivation}" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "BRC-100 bridge" }
                        strong { class: "mono", "{snap.bridge_http_url}" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "UTXOs / 1Sat items" }
                        strong { class: "mono", "{snap.balance.spendable_utxo_count} / {snap.balance.item_count}" }
                    }
                }
            }
        },
        SettingSubpage::RecoverTx => rsx! { RecoverTxPanel {} },
        // Not ported yet (Slice 5 remainder): say so plainly rather than fake a control.
        SettingSubpage::HandCashRecovery
        | SettingSubpage::HistoryBackup
        | SettingSubpage::DeviceHandoff
        | SettingSubpage::SigninEmail
        | SettingSubpage::WipeWallet
        | SettingSubpage::ChartApps => rsx! {
            div { class: "nav-child-panel", "data-aeon-state": "unavailable", style: "display: flex; flex-direction: column; gap: 12px;",
                h3 { "{subpage.label()}" }
                p { class: "settings-row-desc",
                    "This setting is not available in the native Rust build yet. Nothing on this page changes your wallet."
                }
            }
        },
    }
}

/// Recover from a transaction (scan step of `RecoverFromTxPanel.tsx`): lists
/// the 1-sat outputs of a txid that pay this wallet. Read-only; claiming the
/// items into the wallet is still done by the TS app, and the page says so.
#[component]
fn RecoverTxPanel() -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut txid = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut result = use_signal(|| None::<Result<RecoverScan, String>>);
    let state = if *busy.read() { "scanning" } else { "idle" };
    let current = result.read().clone();
    rsx! {
        div {
            class: "nav-child-panel",
            "data-aeon-scope": "settings-recover-tx",
            "data-aeon-state": state,
            style: "display: flex; flex-direction: column; gap: 12px;",
            h3 { "Recover from transaction" }
            p { class: "settings-row-desc",
                "Paste the sender's transaction id to find the items in it that were sent to this wallet. Scanning only reads the chain; it does not move anything."
            }
            input {
                class: "mono",
                placeholder: "64-character transaction id",
                value: "{txid}",
                oninput: move |e| {
                    result.set(None);
                    txid.set(e.value());
                },
            }
            div { class: "actions", style: "display: flex; gap: 8px;",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: *busy.read() || txid.read().trim().is_empty(),
                    onclick: move |_| {
                        let svc = Arc::clone(&services);
                        let raw = txid.read().clone();
                        busy.set(true);
                        result.set(None);
                        spawn(async move {
                            let handle = svc.engine.runtime_handle().clone();
                            let svc_bg = Arc::clone(&svc);
                            let out = handle
                                .spawn(async move { svc_bg.scan_recover_tx(&raw).await })
                                .await
                                .unwrap_or_else(|e| Err(e.to_string()));
                            result.set(Some(out));
                            busy.set(false);
                        });
                    },
                    button::Label { if *busy.read() { "Scanning…" } else { "Scan transaction" } }
                }
            }
            match current {
                None => rsx! {},
                Some(Err(e)) => rsx! {
                    p { class: "settings-row-desc", role: "alert", "data-tone": "error", "{e}" }
                },
                Some(Ok(scan)) if scan.outputs.is_empty() => rsx! {
                    p { class: "settings-row-desc",
                        "No 1-sat outputs in this transaction pay this wallet's address."
                    }
                },
                Some(Ok(scan)) => {
                    let count = scan.outputs.len();
                    rsx! {
                        p { class: "settings-row-desc",
                            "{count} output(s) in this transaction pay this wallet. Claiming them into your wallet is not available in the native Rust build yet; use Recover from transaction in the HandCash desktop app to claim them."
                        }
                        ul { class: "identity-list",
                            for out in scan.outputs {
                                li { key: "{out.outpoint}", class: "identity-field",
                                    span { class: "identity-field-label",
                                        if out.inscribed { "Inscribed output" } else { "1-sat output" }
                                    }
                                    strong { class: "mono", "{truncate_mid(&out.outpoint, 10)}" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
