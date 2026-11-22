// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of the HandCash Desktop navigation panels:
//! `SendPanel`, `ReceivePanel`, `RecentActivity` / `TransactionsPanel`,
//! `ConnectedAppsPanel`, `InventoryPanel`, `FriendsPanel`, `IdentityPanel`, `SettingsPanel`.

use crate::icons::{
    ActivityIcon, AppsIcon, CodeIcon, CoinGlyphIcon, DarkModeIcon, DevicesIcon, DownloadIcon,
    EncryptIcon, FileIcon, InfoIcon, LaunchIcon, LightModeIcon, LockIcon, LtcGlyphIcon,
    MonitorIcon, PaletteIcon, RefreshIcon, ScanQrIcon, SwapIcon, WarningIcon,
};
use crate::machines::{NavChild, SettingSubpage, ToastNotice};
use crate::state::{
    copy_to_clipboard, render_qr_svg, truncate_mid, AcceptedCoins, AppServices, LabFeature,
    SessionSummary, WalletSnapshot, APP_VERSION,
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
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let app_pref = *appearance.read();
    let mut accepted = use_signal(|| services.load_accepted_coins());
    let accepted_now = *accepted.read();
    let mut open = move |sub: SettingSubpage| nav_child.set(Some(NavChild::Setting(sub)));

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
                            description: "SQLite WAL, UTXOs, and BRC-100 bridge status",
                            icon: setting_icon(SettingSubpage::WalletHealth),
                            onclick: move |_| open(SettingSubpage::WalletHealth),
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
    description: &'static str,
    #[props(default = "default")] tone: &'static str,
    icon: Element,
    onclick: EventHandler<MouseEvent>,
) -> Element {
    rsx! {
        li { class: "settings-nav-item",
            list_row::Root {
                class: "settings-nav-row",
                onclick: move |evt| onclick.call(evt),
                list_row::Leading {
                    span { class: "settings-row-icon", "data-tone": "{tone}", {icon} }
                }
                list_row::Label { "{label}" }
                list_row::Description { "data-aeon-state": "idle", "{description}" }
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
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut show_phrase = use_signal(|| false);
    let mut cur_pw = use_signal(String::new);
    let mut next_pw = use_signal(String::new);

    match subpage {
        SettingSubpage::Backup => {
            let phrase_opt = if *show_phrase.read() {
                services.current_mnemonic()
            } else {
                None
            };
            rsx! {
                div { class: "nav-child-panel", style: "display: flex; flex-direction: column; gap: 14px;",
                    h3 { "Recovery backup" }
                    p { class: "settings-row-desc",
                        "Your 24-word recovery phrase restores this wallet on any Desktop or Mobile device."
                    }
                    if profile.has_mnemonic {
                        div { class: "actions",
                            button::Root {
                                variant: button::ButtonVariant::Solid,
                                class: "btn btn-primary",
                                onclick: move |_| {
                                    let next = !*show_phrase.read();
                                    show_phrase.set(next);
                                },
                                button::Label {
                                    if *show_phrase.read() { "Hide recovery phrase" } else { "Show recovery phrase" }
                                }
                            }
                        }
                        if let Some(ref phrase) = phrase_opt {
                            div {
                                class: "mono",
                                style: "padding: 14px; border-radius: 10px; border: 1px solid var(--hc-border); background: var(--hc-field); line-height: 1.6;",
                                "{phrase}"
                            }
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: {
                                    let p = phrase.clone();
                                    move |_| match copy_to_clipboard(&p) {
                                        Ok(()) => toast.set(Some(ToastNotice {
                                            title: "Copied".into(),
                                            body: Some("Recovery phrase copied.".into()),
                                            tone: "success",
                                        })),
                                        Err(e) => toast.set(Some(ToastNotice {
                                            title: "Copy failed".into(),
                                            body: Some(e),
                                            tone: "error",
                                        })),
                                    }
                                },
                                button::Label { "Copy phrase" }
                            }
                        }
                    } else {
                        p { class: "settings-row-desc", "No mnemonic stored for this vault." }
                    }
                }
            }
        }
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
        SettingSubpage::Unlock => {
            let svc_pw = Arc::clone(&services);
            rsx! {
                div { class: "nav-child-panel", style: "display: flex; flex-direction: column; gap: 14px; max-width: 420px;",
                    h3 { "Change vault password" }
                    PasswordField {
                        id: "cur-pw",
                        label: "Current password",
                        placeholder: "Your current password",
                        value: cur_pw,
                    }
                    PasswordField {
                        id: "next-pw",
                        label: "New password",
                        placeholder: "8+ characters",
                        value: next_pw,
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| {
                                let c = cur_pw.read().clone();
                                let n = next_pw.read().clone();
                                match svc_pw.change_password(&c, &n) {
                                    Ok(()) => {
                                        cur_pw.set(String::new());
                                        next_pw.set(String::new());
                                        toast.set(Some(ToastNotice {
                                            title: "Password updated".into(),
                                            body: Some("Your vault password has been changed.".into()),
                                            tone: "success",
                                        }));
                                    }
                                    Err(e) => toast.set(Some(ToastNotice {
                                        title: "Update failed".into(),
                                        body: Some(e),
                                        tone: "error",
                                    })),
                                }
                            },
                            button::Label { "Update password" }
                        }
                    }
                }
            }
        }
        SettingSubpage::WalletHealth => rsx! {
            div { class: "nav-child-panel", style: "display: flex; flex-direction: column; gap: 12px;",
                h3 { "Wallet health" }
                ul { class: "identity-list",
                    li { class: "identity-field",
                        span { class: "identity-field-label", "Spendable UTXOs" }
                        strong { "{snap.balance.spendable_utxo_count}" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "1Sat items" }
                        strong { "{snap.balance.item_count}" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "Engine phase" }
                        strong { "Phase {snap.engine_phase} · gen {snap.engine_generation}" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "BRC-100 HTTP" }
                        strong { class: "mono", "{snap.bridge_http_url}" }
                    }
                    li { class: "identity-field",
                        span { class: "identity-field-label", "BRC-100 HTTPS" }
                        strong { class: "mono", "{snap.bridge_https_url}" }
                    }
                }
            }
        },
        SettingSubpage::About => rsx! {
            div { class: "nav-child-panel", style: "display: flex; flex-direction: column; gap: 12px;",
                h3 { "HandCash Desktop v{APP_VERSION}" }
                p { class: "settings-row-desc",
                    "Self-custodial BRC-100 Bitcoin SV wallet built natively in Rust with Aeon UI, Dioxus Native (Blitz/Stylo/Vello), and per-account SQLite WAL storage."
                }
            }
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
        // Not ported yet (Slice 5 remainder): say so plainly rather than fake a control.
        SettingSubpage::HandCashRecovery
        | SettingSubpage::HistoryBackup
        | SettingSubpage::DeviceHandoff
        | SettingSubpage::SigninEmail
        | SettingSubpage::WipeWallet
        | SettingSubpage::RecoverTx
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
