// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/AuthShell.tsx`, `src/components/OnboardEntryPanel.tsx`,
//! `src/components/AuthScreen.tsx`, `src/components/CreateKeysBackupPanel.tsx`,
//! `src/components/OnboardAcceptPanel.tsx`, `src/components/OnboardFiatPanel.tsx`,
//! `src/components/OnboardProtectPanel.tsx`, `src/components/HistoryRecoveryPanel.tsx`,
//! `src/components/DeviceSignInPanel.tsx`, `src/components/PasswordField.tsx`, and
//! `src/components/auth/AuthEntryTaglines.tsx`.

use crate::icons::{EyeIcon, EyeOffIcon, ExpandMoreIcon, TickerCoinMark};
use crate::machines::{
    session_to_wallet_profile, AuthFormMode, FiatCode, OnboardStep, RestoreRole, ToastNotice,
};
use crate::state::{AcceptedCoins, AppServices, SessionSummary, WalletSnapshot};
use crate::ui::BrandLogo;
use aeon_dioxus::{use_aeon_machine, AeonMachineHandle};
use aeon_ui::{button, field, list_row};
use dioxus::prelude::*;
use handcash_machines::app::{AppEvent, AppMachine};
use handcash_machines::unlock::{
    password_progress, UnlockEvent, UnlockMachine, UnlockSetupFactor, UnlockState as MachineUnlockState,
};
use handcash_primitives::brc140::{
    extract_brc140_shares, share_download_filename, slice_set_label, Brc140IssuedSet,
    BRC140_DESTINATION_HINTS,
};
use handcash_primitives::keys::MnemonicScheme;
use std::collections::BTreeSet;
use std::sync::Arc;

const AUTH_ENTRY_TAGLINES: &[&str] = &[
    "Exchange directly with peers.",
    "Value that moves between people.",
    "Settle with anyone, anywhere.",
    "Send and receive as equals.",
    "Define your own business.",
    "Shape how your business appears.",
    "Set the terms of your trade.",
    "Present your business your way.",
];

const ACCEPT_ALL_COINS: &[&str] = &["bsv", "ltc", "bch", "btc", "doge", "arc-usd"];
const NO_KEYSTORE_TEXT: &str = "Needs a system keyring on this computer, or anyone who can read its files could open this wallet.";

#[derive(Clone, Debug)]
struct PendingOnboard {
    profile: SessionSummary,
    balance_sats: u64,
    wrap_password: String,
    mnemonic: Option<String>,
    step: OnboardStep,
    is_create: bool,
}

/// 1:1 port of `src/components/AuthShell.tsx` + `AuthMeshBackground.tsx`.
#[component]
pub fn AuthShell(
    #[props(default = "")] state: &'static str,
    #[props(default = true)] dark_mode: bool,
    children: Element,
) -> Element {
    let edge_stroke = if dark_mode {
        "rgba(100, 255, 160, 0.14)"
    } else {
        "rgba(0, 0, 0, 0.08)"
    };
    let node_fill = if dark_mode {
        "rgba(100, 255, 160, 0.42)"
    } else {
        "rgba(56, 203, 123, 0.55)"
    };

    rsx! {
        div {
            class: "auth-shell",
            "data-aeon-scope": "auth-shell",
            "data-aeon-state": state,

            // Geometric payment-mesh SVG backdrop mirroring `AuthMeshBackground.tsx`
            div { class: "auth-shell-mesh", "aria-hidden": "true", "data-aeon-part": "backdrop",
                svg {
                    class: "auth-mesh-canvas",
                    "aria-hidden": "true",
                    "data-aeon-part": "mesh",
                    view_box: "0 0 1200 800",
                    width: "100%",
                    height: "100%",
                    preserve_aspect_ratio: "xMidYMid slice",
                    fill: "none",
                    g { stroke: "{edge_stroke}", stroke_width: "1",
                        line { x1: "90", y1: "120", x2: "260", y2: "190" }
                        line { x1: "260", y1: "190", x2: "430", y2: "110" }
                        line { x1: "430", y1: "110", x2: "640", y2: "180" }
                        line { x1: "640", y1: "180", x2: "860", y2: "120" }
                        line { x1: "860", y1: "120", x2: "1080", y2: "200" }
                        line { x1: "90", y1: "120", x2: "160", y2: "360" }
                        line { x1: "260", y1: "190", x2: "340", y2: "390" }
                        line { x1: "430", y1: "110", x2: "340", y2: "390" }
                        line { x1: "640", y1: "180", x2: "580", y2: "380" }
                        line { x1: "640", y1: "180", x2: "820", y2: "340" }
                        line { x1: "860", y1: "120", x2: "820", y2: "340" }
                        line { x1: "1080", y1: "200", x2: "1020", y2: "430" }
                        line { x1: "160", y1: "360", x2: "340", y2: "390" }
                        line { x1: "340", y1: "390", x2: "580", y2: "380" }
                        line { x1: "580", y1: "380", x2: "820", y2: "340" }
                        line { x1: "820", y1: "340", x2: "1020", y2: "430" }
                        line { x1: "160", y1: "360", x2: "110", y2: "620" }
                        line { x1: "340", y1: "390", x2: "290", y2: "640" }
                        line { x1: "580", y1: "380", x2: "510", y2: "610" }
                        line { x1: "580", y1: "380", x2: "740", y2: "650" }
                        line { x1: "820", y1: "340", x2: "740", y2: "650" }
                        line { x1: "1020", y1: "430", x2: "980", y2: "670" }
                        line { x1: "110", y1: "620", x2: "290", y2: "640" }
                        line { x1: "290", y1: "640", x2: "510", y2: "610" }
                        line { x1: "510", y1: "610", x2: "740", y2: "650" }
                        line { x1: "740", y1: "650", x2: "980", y2: "670" }
                    }
                    g { fill: "{node_fill}",
                        circle { cx: "90", cy: "120", r: "2.5" }
                        circle { cx: "260", cy: "190", r: "3" }
                        circle { cx: "430", cy: "110", r: "2" }
                        circle { cx: "640", cy: "180", r: "3.2" }
                        circle { cx: "860", cy: "120", r: "2.5" }
                        circle { cx: "1080", cy: "200", r: "2.5" }
                        circle { cx: "160", cy: "360", r: "2.8" }
                        circle { cx: "340", cy: "390", r: "3" }
                        circle { cx: "580", cy: "380", r: "2.4" }
                        circle { cx: "820", cy: "340", r: "3.2" }
                        circle { cx: "1020", cy: "430", r: "2.6" }
                        circle { cx: "110", cy: "620", r: "2.5" }
                        circle { cx: "290", cy: "640", r: "3" }
                        circle { cx: "510", cy: "610", r: "2.5" }
                        circle { cx: "740", cy: "650", r: "3" }
                        circle { cx: "980", cy: "670", r: "2.5" }
                    }
                }
            }

            div { class: "auth-shell-scrim", "aria-hidden": "true", "data-aeon-part": "scrim" }
            div { class: "auth-shell-content", "data-aeon-part": "content",
                {children}
            }
        }
    }
}

/// 1:1 port of `src/components/OnboardEntryPanel.tsx` + `src/components/AuthScreen.tsx`.
#[component]
pub fn AuthFlow(
    is_locked: bool,
    mut auth_mode: Signal<AuthFormMode>,
    app_machine: AeonMachineHandle<AppMachine>,
    mut snapshot: Signal<WalletSnapshot>,
    mut fiat_code: Signal<FiatCode>,
    mut fresh_mnemonic: Signal<Option<String>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();

    let unlock_chart = use_aeon_machine::<UnlockMachine>();
    let mut error_msg = use_signal(|| Option::<String>::None);
    let mut password = use_signal(String::new);
    let handle = use_signal(String::new);
    let mut mnemonic_input = use_signal(String::new);
    let mut shares_input = use_signal(String::new);
    let mut root_key_input = use_signal(String::new);
    let mut restore_role = use_signal(RestoreRole::default);
    let mut offer_restore_on_lock = use_signal(|| false);
    let passphrase_input = use_signal(String::new);
    let scheme = use_signal(|| "brc157".to_string());
    let chain = use_signal(|| "main".to_string());
    let mut pending_onboard = use_signal(|| Option::<PendingOnboard>::None);
    let mut phrase_copied = use_signal(|| false);
    let mut backup_kind = use_signal(|| "phrase");
    let mut onboard_shares = use_signal(|| Option::<Brc140IssuedSet>::None);
    let mut saved_slices = use_signal(BTreeSet::<usize>::new);
    let mut accept_choice = use_signal(|| AcceptedCoins::Bitcoin);
    let mut protect_mode = use_signal(|| {
        if services.os_key_storage_available() {
            "none".to_string()
        } else {
            "password".to_string()
        }
    });
    let mut protect_pw = use_signal(String::new);
    let mut protect_confirm = use_signal(String::new);
    let mut protect_error = use_signal(|| Option::<String>::None);

    // ── Post-create / post-restore onboarding steps (`src/components/AuthScreen.tsx` lines 817-895) ──
    if let Some(pending) = pending_onboard.read().clone() {
        match pending.step {
            OnboardStep::History => {
                let p_next = pending.clone();
                let p_skip = pending.clone();
                let svc_hist = Arc::clone(&services);
                let local_snaps = services.list_local_brc39_archive();
                let has_local_snap = local_snaps.first().cloned();
                let has_snap = has_local_snap.is_some();
                let snap_state = if has_snap { "ready" } else { "missing" };
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "history-recovery",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "history-recovery",
                            "data-aeon-state": snap_state,
                            h2 { "Restore your history" }
                            p { class: "auth-lede",
                                "Keys are on this device. Activity, UTXOs, friends, and peer apps live in your encrypted history backup — sealed to this wallet’s key, not your unlock password."
                            }
                            if let Some(ref snap_meta) = has_local_snap {
                                p { class: "auth-lede", role: "status",
                                    "Found an on-device history snapshot ({snap_meta.bytes / 1024} KB). Restore it now or choose a backup file."
                                }
                            } else {
                                p { class: "auth-lede", role: "status",
                                    "Choose a .brc39 or .json history backup file if you saved one, or enter with a chain scan and check Settings → History later."
                                }
                            }
                            div {
                                class: "auth-actions",
                                style: "display: flex; gap: 8px; flex-wrap: wrap;",
                                "data-aeon-part": "history-recovery-actions",
                                "data-aeon-state": snap_state,
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary primary",
                                    onclick: move |_| {
                                        if let Some(ref meta) = has_local_snap {
                                            if let Ok(msg) = svc_hist.restore_local_brc39_snapshot(&meta.id, None) {
                                                snapshot.set(svc_hist.read_snapshot());
                                                toast.set(Some(ToastNotice {
                                                    title: "History restored".into(),
                                                    body: Some(msg),
                                                    tone: "success",
                                                }));
                                            }
                                        } else if let Some(path) = rfd::FileDialog::new()
                                            .add_filter("HandCash History Backup", &["brc39", "json"])
                                            .pick_file()
                                        {
                                            if let Ok(bytes) = std::fs::read(&path) {
                                                match svc_hist.restore_brc39_backup_bytes(&bytes, None) {
                                                    Ok(msg) => {
                                                        snapshot.set(svc_hist.read_snapshot());
                                                        toast.set(Some(ToastNotice {
                                                            title: "History restored".into(),
                                                            body: Some(msg),
                                                            tone: "success",
                                                        }));
                                                    }
                                                    Err(e) => {
                                                        toast.set(Some(ToastNotice {
                                                            title: "Restore failed".into(),
                                                            body: Some(e),
                                                            tone: "error",
                                                        }));
                                                        return;
                                                    }
                                                }
                                            }
                                        }
                                        let mut next = p_next.clone();
                                        next.balance_sats = snapshot.read().balance.displayed_sats;
                                        next.step = OnboardStep::Protect;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Restore history" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        let mut next = p_skip.clone();
                                        next.step = OnboardStep::Protect;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Continue without history" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::KeysBackup => {
                let cur_kind = *backup_kind.read();
                let phrase_text = pending.mnemonic.clone().unwrap_or_default();
                let words: Vec<String> = phrase_text
                    .split_whitespace()
                    .map(ToString::to_string)
                    .collect();
                let threshold = onboard_shares
                    .read()
                    .as_ref()
                    .map(|s| s.threshold)
                    .unwrap_or(2);
                let can_confirm = if cur_kind == "split" {
                    saved_slices.read().len() >= threshold
                } else {
                    *phrase_copied.read()
                };
                let svc_confirm = Arc::clone(&services);
                let svc_defer = Arc::clone(&services);
                let svc_slices = Arc::clone(&services);
                let svc_rotate = Arc::clone(&services);
                let p_confirm = pending.clone();
                let p_defer = pending.clone();
                let phrase_for_copy = phrase_text.clone();
                let share_set_opt = onboard_shares.read().clone();
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "keys-backup",
                        div {
                            class: "wallet-setup-config keys-backup",
                            "data-aeon-scope": "create-keys-backup",
                            header { class: "keys-backup-head",
                                h2 { "Save recovery backup" }
                                div { class: "keys-backup-tabs", role: "tablist", aria_label: "Backup kind",
                                    button {
                                        r#type: "button",
                                        role: "tab",
                                        aria_selected: if cur_kind == "phrase" { "true" } else { "false" },
                                        class: if cur_kind == "phrase" {
                                            "btn btn-primary keys-backup-tab"
                                        } else {
                                            "btn btn-ghost keys-backup-tab"
                                        },
                                        onclick: move |_| {
                                            backup_kind.set("phrase");
                                            onboard_shares.set(None);
                                            saved_slices.set(BTreeSet::new());
                                        },
                                        "Phrase"
                                    }
                                    button {
                                        r#type: "button",
                                        role: "tab",
                                        aria_selected: if cur_kind == "split" { "true" } else { "false" },
                                        class: if cur_kind == "split" {
                                            "btn btn-primary keys-backup-tab"
                                        } else {
                                            "btn btn-ghost keys-backup-tab"
                                        },
                                        onclick: move |_| {
                                            match svc_slices.load_or_issue_brc140_set() {
                                                Ok(set) => {
                                                    saved_slices.set(BTreeSet::new());
                                                    onboard_shares.set(Some(set));
                                                    backup_kind.set("split");
                                                }
                                                Err(e) => toast.set(Some(ToastNotice {
                                                    title: "Couldn’t prepare slices".into(),
                                                    body: Some(e),
                                                    tone: "error",
                                                })),
                                            }
                                        },
                                        "Key slices"
                                    }
                                }
                            }
                            div { class: "keys-backup-body", "data-aeon-scroll": "hover",
                                if cur_kind == "phrase" {
                                    div { class: "split-backup-shares",
                                        ol {
                                            class: "recovery-phrase-grid",
                                            "data-words": "{words.len()}",
                                            for (i, word) in words.iter().enumerate() {
                                                li { key: "{i}-{word}",
                                                    span { class: "recovery-phrase-index", "{i + 1}" }
                                                    span { class: "recovery-phrase-word", "{word}" }
                                                }
                                            }
                                        }
                                    }
                                } else if let Some(set) = share_set_opt {
                                    div { class: "split-backup-shares",
                                        KeySliceList {
                                            set,
                                            saved_indices: saved_slices,
                                            toast,
                                            on_rotate: move |_| {
                                                match svc_rotate.rotate_brc140_set() {
                                                    Ok(next_set) => {
                                                        saved_slices.set(BTreeSet::new());
                                                        onboard_shares.set(Some(next_set));
                                                        toast.set(Some(ToastNotice {
                                                            title: "New slice set".into(),
                                                            body: Some("Slices from the previous set will not combine with these.".into()),
                                                            tone: "success",
                                                        }));
                                                    }
                                                    Err(e) => toast.set(Some(ToastNotice {
                                                        title: "Rotate failed".into(),
                                                        body: Some(e),
                                                        tone: "error",
                                                    })),
                                                }
                                            },
                                        }
                                    }
                                }
                            }
                            footer { class: "keys-backup-foot",
                                if cur_kind == "phrase" {
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        onclick: move |_| {
                                            let _ = crate::state::copy_to_clipboard(&phrase_for_copy);
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some("Phrase copied to clipboard.".into()),
                                                tone: "success",
                                            }));
                                            phrase_copied.set(true);
                                        },
                                        button::Label { "Copy phrase" }
                                    }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !can_confirm,
                                    onclick: move |_| {
                                        svc_confirm.mark_keys_backup_confirmed(cur_kind);
                                        toast.set(Some(ToastNotice {
                                            title: "Recovery backup saved".into(),
                                            body: None,
                                            tone: "success",
                                        }));
                                        let mut next = p_confirm.clone();
                                        next.step = OnboardStep::Accept;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "I’ve saved it — continue" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    "data-aeon-part": "backup-later",
                                    onclick: move |_| {
                                        svc_defer.mark_keys_backup_deferred();
                                        let mut next = p_defer.clone();
                                        next.step = OnboardStep::Accept;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "I’ll do this later" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::Accept => {
                let choice = *accept_choice.read();
                let svc_accept = Arc::clone(&services);
                let p_accept = pending.clone();
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "accept",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "onboard-accept",
                            "data-aeon-state": choice.as_str(),
                            h2 { "What do you want to accept?" }
                            p { class: "auth-lede",
                                "Just Bitcoin SV is the default. You can change this later in Settings."
                            }
                            div {
                                class: "wallet-setup-options onboard-accept-options",
                                role: "radiogroup",
                                aria_label: "Accept",
                                for opt in AcceptedCoins::CHOICES {
                                    {
                                        let active = choice == opt;
                                        let cls = if active {
                                            "wallet-setup-option onboard-accept-option is-selected"
                                        } else {
                                            "wallet-setup-option onboard-accept-option"
                                        };
                                        let coins: &[&str] = match opt {
                                            AcceptedCoins::Bitcoin => &["bsv"],
                                            AcceptedCoins::All => ACCEPT_ALL_COINS,
                                        };
                                        let svc_opt = Arc::clone(&svc_accept);
                                        rsx! {
                                            label { key: "{opt.as_str()}", class: "{cls}",
                                                input {
                                                    r#type: "radio",
                                                    name: "onboard-accept",
                                                    value: opt.as_str(),
                                                    checked: active,
                                                    onchange: move |_| {
                                                        accept_choice.set(opt);
                                                        svc_opt.save_accepted_coins(opt);
                                                    },
                                                }
                                                span { class: "onboard-accept-icons", aria_hidden: "true",
                                                    for coin in coins.iter().copied() {
                                                        span {
                                                            key: "{coin}",
                                                            class: "onboard-accept-icon",
                                                            "data-coin": "{coin}",
                                                            TickerCoinMark { coin, size: 28 }
                                                        }
                                                    }
                                                }
                                                span { class: "wallet-setup-option-body",
                                                    strong { "{opt.title()}" }
                                                    span { "{opt.description()}" }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            div {
                                class: "auth-actions",
                                style: "margin-top: 16px;",
                                "data-aeon-part": "onboard-accept-actions",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary auth-submit",
                                    onclick: move |_| {
                                        services.save_accepted_coins(*accept_choice.read());
                                        let mut next = p_accept.clone();
                                        next.step = OnboardStep::Fiat;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Continue" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::Fiat => {
                let current_fiat = *fiat_code.read();
                let svc_fiat = Arc::clone(&services);
                let p_fiat = pending.clone();
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "fiat",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "onboard-fiat",
                            "data-aeon-state": current_fiat.as_str(),
                            h2 { "Show balances in" }
                            p { class: "auth-lede",
                                "Government currency for totals on the home screen. You can change this anytime from Activity."
                            }
                            div {
                                class: "onboard-fiat-options",
                                role: "listbox",
                                aria_label: "Government currency",
                                "data-aeon-part": "fiat",
                                for code in FiatCode::ALL {
                                    {
                                        let selected = code == current_fiat;
                                        let state_attr = if selected { "selected" } else { "idle" };
                                        let svc_pick = Arc::clone(&svc_fiat);
                                        rsx! {
                                            button {
                                                key: "{code.as_str()}",
                                                r#type: "button",
                                                role: "option",
                                                class: "onboard-fiat-option",
                                                aria_selected: if selected { "true" } else { "false" },
                                                aria_label: "{code.iso()} — {code.name()}",
                                                "data-aeon-state": state_attr,
                                                onclick: move |_| {
                                                    fiat_code.set(code);
                                                    svc_pick.save_fiat_currency(code);
                                                },
                                                span { class: "onboard-fiat-flag", aria_hidden: "true", "{code.flag()}" }
                                                span { class: "onboard-fiat-iso", "{code.iso()}" }
                                            }
                                        }
                                    }
                                }
                            }
                            div {
                                class: "auth-actions",
                                style: "margin-top: 16px;",
                                "data-aeon-part": "onboard-fiat-actions",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary auth-submit",
                                    onclick: move |_| {
                                        let mut next = p_fiat.clone();
                                        next.step = OnboardStep::Protect;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Continue" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::Protect => {
                let none_allowed = services.os_key_storage_available();
                let cur_mode = protect_mode.read().clone();
                let needs_password = cur_mode == "password" || cur_mode == "both";
                let svc_protect = Arc::clone(&services);
                let p_protect = pending.clone();
                let options: [(&str, &str, &str, bool); 4] = [
                    (
                        "none",
                        "None",
                        "Open this wallet on this computer without a prompt.",
                        false,
                    ),
                    (
                        "password",
                        "Password",
                        "Unlock with a HandCash password you choose.",
                        false,
                    ),
                    (
                        "device",
                        "Touch ID",
                        "Unlock with this device’s fingerprint or lock screen.",
                        true,
                    ),
                    (
                        "both",
                        "Password + Touch ID",
                        "Either your password or this device can unlock.",
                        true,
                    ),
                ];
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "protect",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "onboard-protect",
                            h2 { "Protect this device" }
                            p { class: "auth-lede",
                                "Choose how HandCash unlocks on this computer. You can change this later in Settings."
                            }
                            div {
                                class: "wallet-setup-options",
                                role: "radiogroup",
                                aria_label: "Device lock",
                                for (id, title, desc, needs_device) in options {
                                    {
                                        let no_keystore = id == "none" && !none_allowed;
                                        let disabled = needs_device || no_keystore;
                                        let active = cur_mode == id;
                                        let cls = match (active, disabled) {
                                            (true, true) => "wallet-setup-option is-selected is-disabled",
                                            (true, false) => "wallet-setup-option is-selected",
                                            (false, true) => "wallet-setup-option is-disabled",
                                            (false, false) => "wallet-setup-option",
                                        };
                                        let sub = if no_keystore {
                                            NO_KEYSTORE_TEXT
                                        } else if disabled {
                                            "Touch ID is not available on this device"
                                        } else {
                                            desc
                                        };
                                        let id_owned = id.to_string();
                                        rsx! {
                                            label { key: "{id}", class: "{cls}",
                                                input {
                                                    r#type: "radio",
                                                    name: "onboard-lock",
                                                    value: "{id}",
                                                    checked: active,
                                                    disabled: disabled,
                                                    onchange: move |_| {
                                                        if !disabled {
                                                            protect_error.set(None);
                                                            protect_mode.set(id_owned.clone());
                                                        }
                                                    },
                                                }
                                                span { class: "wallet-setup-option-body",
                                                    strong { "{title}" }
                                                    span { "{sub}" }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if needs_password {
                                div { class: "auth-form", style: "margin-top: 8px;",
                                    PasswordField {
                                        id: "onboard-lock-password",
                                        label: "HandCash password",
                                        placeholder: "10+ chars, letter and number",
                                        value: protect_pw,
                                    }
                                    p { class: "password-hint",
                                        "This password unlocks the wallet on this device. Don’t forget it."
                                    }
                                    PasswordField {
                                        id: "onboard-lock-password-confirm",
                                        label: "Confirm password",
                                        placeholder: "Type it again",
                                        value: protect_confirm,
                                    }
                                }
                            }
                            if let Some(ref err) = *protect_error.read() {
                                p { class: "error auth-error", role: "alert", "{err}" }
                            }
                            div {
                                class: "auth-actions",
                                style: "margin-top: 16px;",
                                "data-aeon-part": "onboard-protect-actions",
                                "data-aeon-state": "idle",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary auth-submit",
                                    onclick: move |_| {
                                        protect_error.set(None);
                                        let m = protect_mode.read().clone();
                                        let pw = protect_pw.read().clone();
                                        let cpw = protect_confirm.read().clone();
                                        if (m == "password" || m == "both") && pw != cpw {
                                            protect_error.set(Some("Passwords do not match".into()));
                                            return;
                                        }
                                        let user_pw = if m == "password" || m == "both" {
                                            Some(pw.as_str())
                                        } else {
                                            None
                                        };
                                        match svc_protect.apply_onboard_lock(
                                            &p_protect.wrap_password,
                                            &m,
                                            user_pw,
                                        ) {
                                            Ok(()) => {
                                                protect_pw.set(String::new());
                                                protect_confirm.set(String::new());
                                                let sum = p_protect.profile.clone();
                                                let sats = p_protect.balance_sats;
                                                let is_create = p_protect.is_create;
                                                pending_onboard.set(None);
                                                if is_create {
                                                    app_machine.send(AppEvent::Created {
                                                        profile: session_to_wallet_profile(&sum),
                                                        balance_sats: sats,
                                                    });
                                                } else {
                                                    app_machine.send(AppEvent::Unlocked {
                                                        profile: session_to_wallet_profile(&sum),
                                                        balance_sats: sats,
                                                    });
                                                }
                                            }
                                            Err(e) => {
                                                protect_error.set(Some(e));
                                            }
                                        }
                                    },
                                    button::Label { "Continue" }
                                }
                            }
                        }
                    }
                };
            }
        }
    }

    let mode = *auth_mode.read();

    // ── OnboardEntryPanel (`src/components/OnboardEntryPanel.tsx`) ──
    if !is_locked && mode == AuthFormMode::Entry {
        let tagline = AUTH_ENTRY_TAGLINES[0];
        return rsx! {
            section {
                class: "auth-screen",
                "data-aeon-scope": "auth",
                "data-aeon-state": "onboard-entry",
                div { class: "auth-entry-brand", "data-aeon-part": "entry-brand",
                    BrandLogo { size: 48, show_wordmark: true }
                }
                div { class: "auth-entry-actions", "data-aeon-part": "entry-actions",
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary auth-entry-primary",
                        "data-aeon-part": "sign-in",
                        onclick: move |_| {
                            error_msg.set(None);
                            auth_mode.set(AuthFormMode::Signin);
                        },
                        button::Label { "Sign in" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost auth-entry-secondary",
                        "data-aeon-part": "create",
                        onclick: move |_| {
                            error_msg.set(None);
                            auth_mode.set(AuthFormMode::Create);
                        },
                        button::Label { "Create new wallet" }
                    }
                }
                p { class: "auth-alt",
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "auth-alt-link",
                        "data-aeon-part": "migrate",
                        onclick: move |_| {
                            error_msg.set(None);
                            auth_mode.set(AuthFormMode::Create);
                        },
                        button::Label { "Recover an old HandCash wallet" }
                    }
                }
                p {
                    aria_live: "polite",
                    class: "auth-entry-tagline is-in",
                    "data-aeon-part": "entry-tagline",
                    "{tagline}"
                }
            }
        };
    }

    // ── DeviceSignInPanel (`src/components/DeviceSignInPanel.tsx`) ──
    if !is_locked && mode == AuthFormMode::Signin {
        return rsx! {
            section {
                class: "auth-screen",
                "data-aeon-scope": "auth",
                "data-aeon-state": "signin",
                div {
                    class: "auth-copy device-signin",
                    "data-aeon-scope": "device-signin",
                    "data-aeon-state": "scan",
                    h1 { class: "auth-title", "Sign in" }
                    div { class: "scan-login", "data-aeon-part": "scan",
                        p { class: "auth-lede", "Scan with a signed-in device." }
                        div { class: "scan-login-qr", aria_busy: "true" }
                    }
                    div { class: "actions", "data-aeon-part": "exits",
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Entry);
                            },
                            button::Label { "Back" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Phrase);
                            },
                            button::Label { "Other ways" }
                        }
                    }
                }
            }
        };
    }

    let is_restore = mode.is_restore_method();
    let title = if is_restore {
        "Restore on this device"
    } else if mode == AuthFormMode::Create {
        "Create wallet"
    } else {
        "Welcome back"
    };

    let lede = match mode {
        AuthFormMode::Phrase => {
            "Enter your recovery phrase, 12 or 24 words. Same phrase = same identity on Desktop or Mobile."
        }
        AuthFormMode::Shares => {
            "Paste every BRC-140 key slice you have, one per line. HandCash finds two from the same set."
        }
        AuthFormMode::Key => "Paste your emergency root key (64 hex chars).",
        AuthFormMode::Create => "Your keys stay on this device.",
        AuthFormMode::Unlock | AuthFormMode::Entry | AuthFormMode::Signin => {
            if (services.should_auto_unlock() || services.is_no_device_lock())
                && unlock_chart.state() != MachineUnlockState::Failed
            {
                "Opening your wallet on this device."
            } else if services.has_memorable_password() {
                "Enter your HandCash password to unlock."
            } else {
                "Unlock with this device, or restore from a backup."
            }
        }
    };

    let primary_label = if is_restore {
        "Restore"
    } else if mode == AuthFormMode::Create {
        "Create"
    } else {
        "Unlock"
    };

    let submitting = unlock_chart.state() == MachineUnlockState::Opening;
    let unlock_state_attr = unlock_chart.state_attr();
    let submit_label = if submitting {
        "Working…"
    } else {
        primary_label
    };
    let svc_submit = Arc::clone(&services);
    let shares_found = extract_brc140_shares(&shares_input.read()).len();

    rsx! {
        section {
            class: "auth-screen",
            "data-aeon-scope": "auth",
            "data-aeon-state": "{unlock_state_attr}",

            div { class: "auth-copy",
                h1 { class: "auth-title", "{title}" }
                p { class: "auth-lede", "{lede}" }
            }

            form {
                class: "auth-form",
                "data-aeon-part": "form",
                onsubmit: move |e| {
                    e.prevent_default();
                    error_msg.set(None);
                    if unlock_chart.state() == MachineUnlockState::Failed {
                        unlock_chart.send(UnlockEvent::Retry);
                    }
                    let setup_factor = match mode {
                        AuthFormMode::Create => UnlockSetupFactor::Create,
                        AuthFormMode::Phrase | AuthFormMode::Key | AuthFormMode::Shares => {
                            UnlockSetupFactor::Restore
                        }
                        _ => UnlockSetupFactor::Approved,
                    };
                    unlock_chart.send(UnlockEvent::Start {
                        factor: setup_factor,
                        progress: password_progress(),
                    });

                    match mode {
                        AuthFormMode::Unlock | AuthFormMode::Entry | AuthFormMode::Signin => {
                            let pw = password.read().clone();
                            match svc_submit.unlock_with_password(&pw) {
                                Ok(sum) => {
                                    password.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    app_machine.send(AppEvent::Unlocked {
                                        profile: session_to_wallet_profile(&sum),
                                        balance_sats: sats,
                                    });
                                    svc_submit.spawn_sync_identities_from_peers();
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    offer_restore_on_lock.set(true);
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Create => {
                            let h = handle.read().trim().to_string();
                            let c = chain.read().clone();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            match svc_submit.create_vault_onboard(&eff_handle, &c) {
                                Ok((sum, phrase, wrap_pw)) => {
                                    fresh_mnemonic.set(phrase.clone());
                                    phrase_copied.set(false);
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: phrase,
                                        step: OnboardStep::KeysBackup,
                                        is_create: true,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Phrase => {
                            let h = handle.read().trim().to_string();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            let m = mnemonic_input.read().clone();
                            let pass = passphrase_input.read().clone();
                            let c = chain.read().clone();
                            let sch = match scheme.read().as_str() {
                                "brc75" => MnemonicScheme::Brc75,
                                "legacy" => MnemonicScheme::LegacyHd,
                                _ => MnemonicScheme::Brc157,
                            };
                            match svc_submit.restore_vault_onboard(&eff_handle, &m, &pass, &c, sch) {
                                Ok((sum, wrap_pw)) => {
                                    mnemonic_input.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: None,
                                        step: OnboardStep::History,
                                        is_create: false,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Key => {
                            let h = handle.read().trim().to_string();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            let rk = root_key_input.read().clone();
                            let c = chain.read().clone();
                            match svc_submit.restore_vault_root_key_onboard(&eff_handle, &rk, &c) {
                                Ok((sum, wrap_pw)) => {
                                    root_key_input.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: None,
                                        step: OnboardStep::History,
                                        is_create: false,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Shares => {
                            let h = handle.read().trim().to_string();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            let raw_shares = shares_input.read().clone();
                            let c = chain.read().clone();
                            match svc_submit.restore_vault_brc140_shares_onboard(
                                &eff_handle,
                                &raw_shares,
                                &c,
                            ) {
                                Ok((sum, wrap_pw)) => {
                                    shares_input.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: None,
                                        step: OnboardStep::History,
                                        is_create: false,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                    }
                },

                // Mode switch on locked screen (Unlock / Restore)
                if is_locked && (*offer_restore_on_lock.read() || is_restore) {
                    div { class: "auth-mode-switch", role: "tablist", aria_label: "Wallet access",
                        button {
                            r#type: "button",
                            role: "tab",
                            class: "auth-mode-tab",
                            "data-aeon-state": if mode == AuthFormMode::Unlock { "selected" } else { "idle" },
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Unlock);
                            },
                            "Unlock"
                        }
                        button {
                            r#type: "button",
                            role: "tab",
                            class: "auth-mode-tab",
                            "data-aeon-state": if is_restore { "selected" } else { "idle" },
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Phrase);
                            },
                            "Restore"
                        }
                    }
                }

                // Restore method tabs (`Phrase | Key slices | Emergency key`)
                if is_restore {
                    div { class: "auth-mode-switch", role: "tablist", aria_label: "Restore method",
                        for (m_id, m_label) in AuthFormMode::RESTORE_METHODS {
                            button {
                                key: "{m_label}",
                                r#type: "button",
                                role: "tab",
                                aria_selected: if mode == m_id { "true" } else { "false" },
                                class: "auth-mode-tab",
                                "data-aeon-state": if mode == m_id { "selected" } else { "idle" },
                                onclick: move |_| {
                                    error_msg.set(None);
                                    auth_mode.set(m_id);
                                },
                                "{m_label}"
                            }
                        }
                    }
                }

                // Recovery phrase field
                if mode == AuthFormMode::Phrase {
                    field::Root { class: "field",
                        field::Label { r#for: "mnemonic", "Recovery phrase" }
                        textarea {
                            id: "mnemonic",
                            rows: "3",
                            "data-aeon-part": "textarea",
                            placeholder: "12 or 24 words separated by spaces",
                            value: "{mnemonic_input}",
                            oninput: move |e| mnemonic_input.set(e.value()),
                        }
                    }
                }

                // Key slices field
                if mode == AuthFormMode::Shares {
                    field::Root { class: "field",
                        field::Label { "BRC-140 key slices" }
                        textarea {
                            id: "shares",
                            rows: "5",
                            placeholder: "x.y.2.integrity\nx.y.2.integrity",
                            value: "{shares_input}",
                            oninput: move |e| shares_input.set(e.value()),
                        }
                        p { class: "field-hint", "data-aeon-part": "shares-count",
                            if shares_found == 0 {
                                "Slices from different sets of one wallet will not combine — add every one you saved."
                            } else if shares_found == 1 {
                                "1 slice found"
                            } else {
                                "{shares_found} slices found"
                            }
                        }
                    }
                }

                // Emergency root key field
                if mode == AuthFormMode::Key {
                    field::Root { class: "field",
                        field::Label { "Emergency root key" }
                        textarea {
                            id: "root-key",
                            rows: "2",
                            placeholder: "64 hex characters",
                            value: "{root_key_input}",
                            oninput: move |e| root_key_input.set(e.value()),
                        }
                    }
                }

                // Restore role radio group (`Replace old device` | `Keep both`)
                if is_restore {
                    div { class: "field", "data-aeon-part": "restore-role",
                        div { class: "auth-mode-switch", role: "radiogroup", aria_label: "Your other device",
                            for (r_id, r_label, _) in RestoreRole::ALL {
                                button {
                                    key: "{r_label}",
                                    r#type: "button",
                                    role: "radio",
                                    aria_checked: if *restore_role.read() == r_id { "true" } else { "false" },
                                    class: "auth-mode-tab",
                                    "data-aeon-state": if *restore_role.read() == r_id { "selected" } else { "idle" },
                                    onclick: move |_| restore_role.set(r_id),
                                    "{r_label}"
                                }
                            }
                        }
                        p { class: "field-hint",
                            {
                                let cur = *restore_role.read();
                                RestoreRole::ALL
                                    .iter()
                                    .find(|(id, _, _)| *id == cur)
                                    .map(|(_, _, hint)| *hint)
                                    .unwrap_or("")
                            }
                        }
                    }
                }

                // Password field on Unlock (only when memorable password lock is active)
                if mode == AuthFormMode::Unlock && services.has_memorable_password() {
                    PasswordField {
                        id: "password",
                        label: "HandCash password",
                        placeholder: "Your password",
                        value: password,
                    }
                }

                if let Some(ref err) = *error_msg.read() {
                    p { class: "error auth-error", role: "alert", "{err}" }
                }

                button::Root {
                    variant: button::ButtonVariant::Solid,
                    button_type: "submit",
                    class: "btn btn-primary auth-submit",
                    "data-aeon-part": "trigger",
                    "data-aeon-state": "{unlock_state_attr}",
                    disabled: submitting,
                    button::Label { "{submit_label}" }
                }

                if !is_locked && mode == AuthFormMode::Create {
                    p { class: "auth-alt",
                        "Already have a wallet? "
                        button {
                            r#type: "button",
                            class: "auth-alt-link",
                            "data-aeon-part": "existing-wallet",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Signin);
                            },
                            "Sign in"
                        }
                    }
                }

                if !is_locked && is_restore {
                    p { class: "auth-alt",
                        button {
                            r#type: "button",
                            class: "auth-alt-link",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Signin);
                            },
                            "Sign in with email and your device"
                        }
                        " · New here? "
                        button {
                            r#type: "button",
                            class: "auth-alt-link",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Create);
                            },
                            "Create a wallet"
                        }
                    }
                }

                if is_restore {
                    p { class: "auth-lede auth-restore-note",
                        "Next you’ll restore history, then choose how this device unlocks."
                    }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardEntryPanel.tsx` for direct rendering & DOM parity tests.
#[component]
pub fn OnboardEntryPanel(
    on_sign_in: EventHandler<()>,
    on_create: EventHandler<()>,
    on_migrate: EventHandler<()>,
) -> Element {
    let tagline = AUTH_ENTRY_TAGLINES[0];
    rsx! {
        section {
            class: "auth-screen",
            "data-aeon-scope": "auth",
            "data-aeon-state": "onboard-entry",
            div { class: "auth-entry-brand", "data-aeon-part": "entry-brand",
                BrandLogo { size: 48, show_wordmark: true }
            }
            div { class: "auth-entry-actions", "data-aeon-part": "entry-actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary auth-entry-primary",
                    "data-aeon-part": "sign-in",
                    onclick: move |_| on_sign_in.call(()),
                    button::Label { "Sign in" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost auth-entry-secondary",
                    "data-aeon-part": "create",
                    onclick: move |_| on_create.call(()),
                    button::Label { "Create new wallet" }
                }
            }
            p { class: "auth-alt",
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "auth-alt-link",
                    "data-aeon-part": "migrate",
                    onclick: move |_| on_migrate.call(()),
                    button::Label { "Recover an old HandCash wallet" }
                }
            }
            p {
                aria_live: "polite",
                class: "auth-entry-tagline is-in",
                "data-aeon-part": "entry-tagline",
                "{tagline}"
            }
        }
    }
}

/// Standalone `src/components/CreateKeysBackupPanel.tsx`.
#[component]
pub fn CreateKeysBackupPanel(
    mnemonic: String,
    #[props(default)] on_done: Option<EventHandler<()>>,
) -> Element {
    let mut backup_kind = use_signal(|| "phrase");
    let mut phrase_copied = use_signal(|| false);
    let cur_kind = *backup_kind.read();
    let words: Vec<String> = mnemonic.split_whitespace().map(ToString::to_string).collect();
    let can_confirm = *phrase_copied.read();
    let phrase_for_copy = mnemonic.clone();
    rsx! {
        div {
            class: "wallet-setup-config keys-backup",
            "data-aeon-scope": "create-keys-backup",
            header { class: "keys-backup-head",
                h2 { "Save recovery backup" }
                div { class: "keys-backup-tabs", role: "tablist", aria_label: "Backup kind",
                    button {
                        r#type: "button",
                        role: "tab",
                        aria_selected: if cur_kind == "phrase" { "true" } else { "false" },
                        class: if cur_kind == "phrase" { "btn btn-primary keys-backup-tab" } else { "btn btn-ghost keys-backup-tab" },
                        onclick: move |_| backup_kind.set("phrase"),
                        "Phrase"
                    }
                    button {
                        r#type: "button",
                        role: "tab",
                        aria_selected: if cur_kind == "split" { "true" } else { "false" },
                        class: if cur_kind == "split" { "btn btn-primary keys-backup-tab" } else { "btn btn-ghost keys-backup-tab" },
                        onclick: move |_| backup_kind.set("split"),
                        "Key slices"
                    }
                }
            }
            div { class: "keys-backup-body", "data-aeon-scroll": "hover",
                div { class: "split-backup-shares",
                    ol { class: "recovery-phrase-grid", "data-words": "{words.len()}",
                        for (i, word) in words.iter().enumerate() {
                            li { key: "{i}-{word}",
                                span { class: "recovery-phrase-index", "{i + 1}" }
                                span { class: "recovery-phrase-word", "{word}" }
                            }
                        }
                    }
                }
            }
            footer { class: "keys-backup-foot",
                if cur_kind == "phrase" {
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| {
                            let _ = crate::state::copy_to_clipboard(&phrase_for_copy);
                            phrase_copied.set(true);
                        },
                        button::Label { "Copy phrase" }
                    }
                }
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: !can_confirm,
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(());
                        }
                    },
                    button::Label { "I’ve saved it — continue" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    "data-aeon-part": "backup-later",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(());
                        }
                    },
                    button::Label { "I’ll do this later" }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardAcceptPanel.tsx`.
#[component]
pub fn OnboardAcceptPanel(
    #[props(default)] initial_choice: Option<AcceptedCoins>,
    #[props(default)] bsv_ready: bool,
    #[props(default)] on_done: Option<EventHandler<AcceptedCoins>>,
) -> Element {
    let mut choice_sig = use_signal(move || initial_choice.unwrap_or(AcceptedCoins::Bitcoin));
    let choice = *choice_sig.read();
    rsx! {
        div {
            class: "wallet-setup-config",
            "data-aeon-scope": "onboard-accept",
            "data-aeon-state": choice.as_str(),
            h2 { "What do you want to accept?" }
            p { class: "auth-lede",
                "Just Bitcoin SV is the default. You can change this later in Settings."
            }
            div {
                class: "wallet-setup-options onboard-accept-options",
                role: "radiogroup",
                aria_label: "Accept",
                for opt in AcceptedCoins::CHOICES {
                    {
                        let active = choice == opt;
                        let cls = if active {
                            "wallet-setup-option onboard-accept-option is-selected"
                        } else {
                            "wallet-setup-option onboard-accept-option"
                        };
                        let coins: &[&str] = match opt {
                            AcceptedCoins::Bitcoin => &["bsv"],
                            AcceptedCoins::All => ACCEPT_ALL_COINS,
                        };
                        rsx! {
                            label { key: "{opt.as_str()}", class: "{cls}",
                                input {
                                    r#type: "radio",
                                    name: "onboard-accept",
                                    value: opt.as_str(),
                                    checked: active,
                                    onchange: move |_| choice_sig.set(opt),
                                }
                                span { class: "onboard-accept-icons", aria_hidden: "true",
                                    for coin in coins.iter().copied() {
                                        span {
                                            key: "{coin}",
                                            class: "onboard-accept-icon",
                                            "data-coin": "{coin}",
                                            if coin == "bsv" {
                                                crate::ui::primitives::DeferredImage {
                                                    src: Some(crate::icons::bsv_logo_png_data_uri().to_string()),
                                                    alt: String::new(),
                                                    ready: bsv_ready,
                                                }
                                            } else {
                                                TickerCoinMark { coin, size: 28 }
                                            }
                                        }
                                    }
                                }
                                span { class: "wallet-setup-option-body",
                                    strong { "{opt.title()}" }
                                    span { "{opt.description()}" }
                                }
                            }
                        }
                    }
                }
            }
            div {
                class: "auth-actions",
                "data-aeon-part": "onboard-accept-actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary auth-submit",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(*choice_sig.read());
                        }
                    },
                    button::Label { "Continue" }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardFiatPanel.tsx`.
#[component]
pub fn OnboardFiatPanel(
    #[props(default = FiatCode::Usd)] initial_fiat: FiatCode,
    #[props(default)] on_done: Option<EventHandler<FiatCode>>,
) -> Element {
    let mut fiat_sig = use_signal(move || initial_fiat);
    let current_fiat = *fiat_sig.read();
    rsx! {
        div {
            class: "wallet-setup-config",
            "data-aeon-scope": "onboard-fiat",
            "data-aeon-state": current_fiat.as_str(),
            h2 { "Show balances in" }
            p { class: "auth-lede",
                "Government currency for totals on the home screen. You can change this anytime from Activity."
            }
            div {
                class: "onboard-fiat-options",
                role: "listbox",
                aria_label: "Government currency",
                "data-aeon-part": "fiat",
                for code in FiatCode::ALL {
                    {
                        let selected = code == current_fiat;
                        rsx! {
                            button {
                                key: "{code.as_str()}",
                                r#type: "button",
                                role: "option",
                                class: "onboard-fiat-option",
                                aria_selected: if selected { "true" } else { "false" },
                                aria_label: "{code.iso()} — {code.name()}",
                                "data-aeon-state": if selected { "selected" } else { "idle" },
                                onclick: move |_| fiat_sig.set(code),
                                span { class: "onboard-fiat-flag", aria_hidden: "true", "{code.flag()}" }
                                span { class: "onboard-fiat-iso", "{code.iso()}" }
                            }
                        }
                    }
                }
            }
            div {
                class: "auth-actions",
                "data-aeon-part": "onboard-fiat-actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary auth-submit",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(*fiat_sig.read());
                        }
                    },
                    button::Label { "Continue" }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardProtectPanel.tsx`.
#[component]
pub fn OnboardProtectPanel(
    #[props(default = true)] none_allowed: bool,
    #[props(default = "none".to_string())] default_mode: String,
    #[props(default)] on_done: Option<EventHandler<String>>,
) -> Element {
    let mut mode_sig = use_signal(move || default_mode);
    let cur_mode = mode_sig.read().clone();
    let options: [(&str, &str, &str, bool); 4] = [
        ("none", "None", "Open this wallet on this computer without a prompt.", false),
        ("password", "Password", "Unlock with a HandCash password you choose.", false),
        ("device", "Touch ID", "Unlock with this device’s fingerprint or lock screen.", true),
        ("both", "Password + Touch ID", "Either your password or this device can unlock.", true),
    ];
    rsx! {
        div {
            class: "wallet-setup-config",
            "data-aeon-scope": "onboard-protect",
            h2 { "Protect this device" }
            p { class: "auth-lede",
                "Choose how HandCash unlocks on this computer. You can change this later in Settings."
            }
            div {
                class: "wallet-setup-options",
                role: "radiogroup",
                aria_label: "Device lock",
                for (id, title, desc, needs_device) in options {
                    {
                        let no_keystore = id == "none" && !none_allowed;
                        let disabled = needs_device || no_keystore;
                        let active = cur_mode == id;
                        let cls = match (active, disabled) {
                            (true, true) => "wallet-setup-option is-selected is-disabled",
                            (true, false) => "wallet-setup-option is-selected",
                            (false, true) => "wallet-setup-option is-disabled",
                            (false, false) => "wallet-setup-option",
                        };
                        let sub = if no_keystore {
                            NO_KEYSTORE_TEXT
                        } else if disabled {
                            "Touch ID is not available on this device"
                        } else {
                            desc
                        };
                        let id_owned = id.to_string();
                        rsx! {
                            label { key: "{id}", class: "{cls}",
                                input {
                                    r#type: "radio",
                                    name: "onboard-lock",
                                    value: "{id}",
                                    checked: active,
                                    disabled: disabled,
                                    onchange: move |_| {
                                        if !disabled {
                                            mode_sig.set(id_owned.clone());
                                        }
                                    },
                                }
                                span { class: "wallet-setup-option-body",
                                    strong { "{title}" }
                                    span { "{sub}" }
                                }
                            }
                        }
                    }
                }
            }
            div {
                class: "auth-actions",
                "data-aeon-part": "onboard-protect-actions",
                "data-aeon-state": "idle",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary auth-submit",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(mode_sig.read().clone());
                        }
                    },
                    button::Label { "Continue" }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/PasswordField.tsx`.
#[component]
pub fn PasswordField(
    id: String,
    label: String,
    placeholder: String,
    mut value: Signal<String>,
) -> Element {
    let mut visible = use_signal(|| false);
    let is_vis = *visible.read();

    rsx! {
        field::Root { class: "field",
            field::Label { "{label}" }
            div { class: "password-field",
                input {
                    id: "{id}",
                    r#type: if is_vis { "text" } else { "password" },
                    placeholder: "{placeholder}",
                    value: "{value}",
                    oninput: move |e| value.set(e.value()),
                }
                button {
                    r#type: "button",
                    class: "password-field-toggle",
                    aria_label: if is_vis { "Hide password" } else { "Show password" },
                    onclick: move |_| visible.set(!is_vis),
                    if is_vis {
                        EyeOffIcon { size: 18 }
                    } else {
                        EyeIcon { size: 18 }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/KeySliceList.tsx`.
#[component]
pub fn KeySliceList(
    set: Brc140IssuedSet,
    mut saved_indices: Signal<BTreeSet<usize>>,
    mut toast: Signal<Option<ToastNotice>>,
    on_rotate: EventHandler<MouseEvent>,
) -> Element {
    let mut open_idx = use_signal(|| Some(0usize));
    let saved_set = saved_indices.read().clone();
    let saved_count = saved_set.len();
    let threshold = set.threshold;
    let total = set.shares.len();
    let complete = saved_count >= threshold;
    let pct = ((saved_count.min(threshold) * 100) / threshold.max(1)).min(100);
    let issued_label = slice_set_label(set.issued_at);

    rsx! {
        div {
            class: "key-slice-list",
            "data-aeon-scope": "key-slice-list",
            "data-aeon-state": if complete { "complete" } else { "pending" },

            div { class: "key-slice-progress-block", "data-aeon-part": "progress",
                div { class: "key-slice-progress-meta",
                    span { class: "key-slice-progress-label",
                        if complete {
                            "Ready — {saved_count} of {total} slices confirmed saved"
                        } else {
                            "{saved_count} of {threshold} required slices confirmed saved"
                        }
                    }
                    span { class: "key-slice-progress-count mono", "{saved_count}/{threshold}" }
                }
                div {
                    class: "key-slice-progress",
                    role: "progressbar",
                    aria_valuenow: "{saved_count.min(threshold)}",
                    aria_valuemin: "0",
                    aria_valuemax: "{threshold}",
                    div { class: "key-slice-progress-track",
                        div {
                            class: "key-slice-progress-range",
                            style: "width: {pct}%;",
                        }
                    }
                }
                p { class: "settings-row-desc",
                    "{issued_label} · Integrity "
                    span { class: "mono", "{set.integrity}" }
                    " · any {threshold} of {total} from this set restore the wallet"
                }
            }

            div { class: "key-slice-accordion",
                for (index, share) in set.shares.iter().enumerate() {
                    {
                        let saved = saved_set.contains(&index);
                        let is_open = *open_idx.read() == Some(index);
                        let destination = BRC140_DESTINATION_HINTS
                            .get(index)
                            .copied()
                            .unwrap_or("Separate account or device");
                        let share_copy = share.clone();
                        let share_save = share.clone();
                        let share_email = share.clone();
                        let integrity_save = set.integrity.clone();
                        let integrity_email = set.integrity.clone();
                        let issued_save = issued_label.clone();
                        let issued_email = issued_label.clone();
                        rsx! {
                            div {
                                key: "{share}",
                                class: "key-slice-item",
                                "data-aeon-state": if saved { "saved" } else { "pending" },
                                button {
                                    r#type: "button",
                                    class: "key-slice-trigger",
                                    aria_expanded: is_open,
                                    onclick: move |_| {
                                        let cur = *open_idx.read();
                                        open_idx.set(if cur == Some(index) { None } else { Some(index) });
                                    },
                                    list_row::Root { class: "key-slice-row",
                                        list_row::Leading { class: "key-slice-leading", "{index + 1}" }
                                        span { class: "key-slice-row-text",
                                            list_row::Label { class: "key-slice-label", "Slice {index + 1}" }
                                            list_row::Description { class: "key-slice-desc", "{destination}" }
                                        }
                                        list_row::Trailing { class: "key-slice-trailing",
                                            span {
                                                class: "key-slice-status",
                                                "data-aeon-state": if saved { "saved" } else { "pending" },
                                                if saved { "Confirmed" } else { "Open" }
                                            }
                                            ExpandMoreIcon { size: 16 }
                                        }
                                    }
                                }
                                if is_open {
                                    div { class: "key-slice-body",
                                        code { class: "mono split-backup-share", "{share}" }
                                        div { class: "actions split-backup-item-actions",
                                            button::Root {
                                                variant: button::ButtonVariant::Solid,
                                                class: "btn btn-primary",
                                                onclick: move |_| {
                                                    let subject = format!("HandCash key slice {} of {total}", index + 1);
                                                    let body = format!(
                                                        "HandCash key slice {}/{total}\nSuggested place: {destination}\nIntegrity: {integrity_email}\n{issued_email}\n\n{share_email}\n\nOnly slices from the same set combine.",
                                                        index + 1
                                                    );
                                                    let mailto = format!(
                                                        "mailto:?subject={}&body={}",
                                                        subject.replace(' ', "%20"),
                                                        body.replace('\n', "%0A").replace(' ', "%20")
                                                    );
                                                    let _ = crate::state::open_external_url(&mailto);
                                                    toast.set(Some(ToastNotice {
                                                        title: "Opened email".into(),
                                                        body: Some(destination.into()),
                                                        tone: "success",
                                                    }));
                                                },
                                                button::Label { "Share this slice" }
                                            }
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost",
                                                onclick: move |_| {
                                                    if crate::state::copy_to_clipboard(&share_copy).is_ok() {
                                                        toast.set(Some(ToastNotice {
                                                            title: "Copied".into(),
                                                            body: Some(destination.into()),
                                                            tone: "success",
                                                        }));
                                                    }
                                                },
                                                button::Label { "Copy" }
                                            }
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost",
                                                onclick: move |_| {
                                                    let fname = share_download_filename(index, total, &integrity_save);
                                                    let content = format!(
                                                        "# {destination}\n# integrity {integrity_save}\n# {issued_save}\n{share_save}\n"
                                                    );
                                                    if let Some(path) = rfd::FileDialog::new()
                                                        .set_file_name(&fname)
                                                        .save_file()
                                                    {
                                                        if std::fs::write(&path, content).is_ok() {
                                                            let mut next = saved_indices.read().clone();
                                                            next.insert(index);
                                                            saved_indices.set(next);
                                                            toast.set(Some(ToastNotice {
                                                                title: format!("Slice {} saved", index + 1),
                                                                body: Some(path.display().to_string()),
                                                                tone: "success",
                                                            }));
                                                        }
                                                    }
                                                },
                                                button::Label { "Save file" }
                                            }
                                        }
                                        div { class: "actions split-backup-item-actions",
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: if saved { "btn btn-ghost" } else { "btn btn-primary" },
                                                disabled: saved,
                                                onclick: move |_| {
                                                    let mut next = saved_indices.read().clone();
                                                    next.insert(index);
                                                    saved_indices.set(next);
                                                    toast.set(Some(ToastNotice {
                                                        title: format!("Slice {} confirmed", index + 1),
                                                        body: Some("Keep it separate from your other slice.".into()),
                                                        tone: "success",
                                                    }));
                                                },
                                                button::Label {
                                                    if saved { "Saved — confirmed" } else { "I saved this slice" }
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

            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    title: "Replace this set. Slices from the old set will not combine with the new ones.",
                    onclick: move |evt| on_rotate.call(evt),
                    button::Label { "Replace slice set" }
                }
            }
        }
    }
}
