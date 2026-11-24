// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop wallet chrome components:
//! - `src/components/FiatCurrencyMenu.tsx`
//! - `src/components/WalletAccountMenu.tsx`
//! - `src/components/WalletActionDock.tsx`
//! - `src/components/AppToastHost.tsx`

use crate::icons::{
    AddIcon, BackIcon, CheckIcon, CloseIcon, CopyIcon, DownloadIcon, EditIcon, ExpandMoreIcon,
    FireIcon, PersonAddIcon, SendIcon, TickerCoinMark,
};
use crate::machines::{
    AppSessionEvent, AppSessionMachine, FiatCode, MarketCoin, NavChild, NavSection, ToastNotice,
};
use crate::state::{copy_to_clipboard, format_bsv, AppServices, SessionSummary, WalletSnapshot};
use crate::ui::primitives::ProfileAvatar;
use dioxus::prelude::*;
use std::sync::Arc;

/// Tone for a docked CTA inside `WalletActionBar` (`placement="nav"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionTone {
    Primary,
    Secondary,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionIcon {
    Check,
    Close,
    Back,
    Send,
    Fire,
    PersonAdd,
    Download,
    Copy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DockActionSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub short_label: &'static str,
    pub tone: ActionTone,
    pub icon: ActionIcon,
    pub disabled: bool,
    pub tertiary_before: Option<Box<DockActionSpec>>,
}

impl DockActionSpec {
    pub const fn new(
        id: &'static str,
        label: &'static str,
        tone: ActionTone,
        icon: ActionIcon,
    ) -> Self {
        Self {
            id,
            label,
            short_label: label,
            tone,
            icon,
            disabled: false,
            tertiary_before: None,
        }
    }

    pub const fn short_label(mut self, short_label: &'static str) -> Self {
        self.short_label = short_label;
        self
    }

    pub const fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn with_tertiary(mut self, tertiary: DockActionSpec) -> Self {
        self.tertiary_before = Some(Box::new(tertiary));
        self
    }
}

/// Declarative CTA specification docked directly into `.wallet-nav-titlebar-tabs[data-permission=""]`
/// and `.wallet-nav-bar-track`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DockSpec {
    pub aria_label: &'static str,
    pub secondary: Option<DockActionSpec>,
    pub primary: DockActionSpec,
}

impl DockSpec {
    pub fn three(
        aria_label: &'static str,
        tertiary: DockActionSpec,
        secondary: DockActionSpec,
        primary: DockActionSpec,
    ) -> Self {
        Self {
            aria_label,
            secondary: Some(secondary.with_tertiary(tertiary)),
            primary,
        }
    }

    pub fn actions(&self) -> Vec<DockActionSpec> {
        let mut actions = Vec::with_capacity(3);
        if let Some(ref sec) = self.secondary {
            if let Some(ref tert) = sec.tertiary_before {
                actions.push((**tert).clone());
            }
            let mut clean_sec = sec.clone();
            clean_sec.tertiary_before = None;
            actions.push(clean_sec);
        }
        if let Some(ref tert) = self.primary.tertiary_before {
            actions.push((**tert).clone());
        }
        let mut clean_prim = self.primary.clone();
        clean_prim.tertiary_before = None;
        actions.push(clean_prim);
        actions
    }
}

/// Monotonic CTA dispatch event (`(sequence, action_id)`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DockTrigger {
    pub seq: u64,
    pub action_id: &'static str,
}

fn render_action_icon(icon: ActionIcon) -> Element {
    match icon {
        ActionIcon::Check => rsx! { CheckIcon { size: 18 } },
        ActionIcon::Close => rsx! { CloseIcon { size: 18 } },
        ActionIcon::Back => rsx! { BackIcon { size: 18 } },
        ActionIcon::Send => rsx! { SendIcon { size: 17 } },
        ActionIcon::Fire => rsx! { FireIcon { size: 17 } },
        ActionIcon::PersonAdd => rsx! { PersonAddIcon { size: 17 } },
        ActionIcon::Download => rsx! { DownloadIcon { size: 17 } },
        ActionIcon::Copy => rsx! { CopyIcon { size: 16 } },
    }
}

/// 1:1 port of `src/components/WalletActionBar.tsx` (`<footer class="wallet-action-bar wallet-action-bar--nav">`).
#[component]
pub fn WalletActionBarFooter(spec: DockSpec, mut trigger: Signal<DockTrigger>) -> Element {
    let mut hovered_idx = use_signal(|| Option::<usize>::None);
    let actions = spec.actions();

    // Prefer the primary CTA when enabled; danger secondaries/tertiaries never rest highlighted.
    let fallback_idx: Option<usize> = if !spec.primary.disabled {
        Some(actions.len() - 1)
    } else {
        actions
            .iter()
            .enumerate()
            .rev()
            .skip(1)
            .find(|(_, a)| !a.disabled && a.tone != ActionTone::Danger)
            .map(|(i, _)| i)
    };

    let cur_hover = (*hovered_idx.read()).filter(|&i| actions.get(i).is_some_and(|a| !a.disabled));
    let highlighted_idx = cur_hover.or(fallback_idx);

    let data_cta = highlighted_idx.map(|i| {
        if actions[i].tone == ActionTone::Danger {
            "danger"
        } else {
            "primary"
        }
    });

    rsx! {
        footer {
            class: "wallet-action-bar wallet-action-bar--nav",
            role: "group",
            aria_label: "{spec.aria_label}",
            "data-cta": data_cta,
            onmouseleave: move |_| hovered_idx.set(None),
            for (idx, action) in actions.into_iter().enumerate() {
                {
                    let is_highlighted = highlighted_idx == Some(idx) && !action.disabled;
                    let slot_tone = if !is_highlighted {
                        "neutral"
                    } else if action.tone == ActionTone::Danger {
                        "danger"
                    } else {
                        "primary"
                    };
                    let slot_class = format!("wallet-action-slot wallet-action-slot--{slot_tone}");
                    let btn_class = match action.tone {
                        ActionTone::Primary => "wallet-nav-tab wallet-nav-tab-accept",
                        ActionTone::Danger => "wallet-nav-tab wallet-nav-tab-danger",
                        ActionTone::Secondary => "wallet-nav-tab wallet-nav-tab-deny",
                    };
                    let aid = action.id;
                    rsx! {
                        span {
                            key: "{action.id}-{idx}",
                            class: "{slot_class}",
                            "data-highlighted": if is_highlighted { Some("") } else { None },
                            button {
                                r#type: "button",
                                class: "{btn_class}",
                                "data-selected": if is_highlighted { Some("") } else { None },
                                disabled: action.disabled,
                                title: "{action.label}",
                                aria_label: "{action.label}",
                                onmouseenter: move |_| hovered_idx.set(Some(idx)),
                                onclick: move |_| {
                                    let next_seq = trigger.read().seq.wrapping_add(1);
                                    trigger.set(DockTrigger {
                                        seq: next_seq,
                                        action_id: aid,
                                    });
                                },
                                span { class: "wallet-nav-tab-icon",
                                    {render_action_icon(action.icon)}
                                }
                                span { class: "wallet-nav-tab-label", "{action.label}" }
                                span { class: "wallet-nav-tab-label-short", "{action.short_label}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/WalletActionBar.tsx` (`placement="nav"`),
/// rendered directly inside `.wallet-nav-titlebar-tabs[data-permission=""]`.
#[component]
pub fn WalletActionBarNav(spec: DockSpec, trigger: Signal<DockTrigger>) -> Element {
    let aria = spec.aria_label;
    rsx! {
        div {
            class: "wallet-nav-titlebar-tabs",
            role: "group",
            aria_label: "{aria}",
            "data-permission": "",
            WalletActionBarFooter { spec, trigger }
        }
    }
}

/// 1:1 port of `src/components/FiatCurrencyMenu.tsx` (12 government currencies persisted to durable store).
#[component]
pub fn FiatCurrencyMenu(
    mut fiat_code: Signal<FiatCode>,
    amount_label: String,
    mut open_menu: Signal<Option<&'static str>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let open = *open_menu.read() == Some("fiat");
    let current = *fiat_code.read();

    rsx! {
        div {
            class: "wallet-nav-actions-pill wallet-hero-metric fiat-currency-menu",
            "data-aeon-scope": "fiat-currency",
            "data-aeon-state": if open { "open" } else { "closed" },
            button {
                r#type: "button",
                class: "fiat-currency-trigger",
                "data-aeon-part": "trigger",
                aria_haspopup: "dialog",
                aria_expanded: open,
                title: "Choose display currency",
                onclick: move |_| {
                    let next = if *open_menu.read() == Some("fiat") { None } else { Some("fiat") };
                    open_menu.set(next);
                },
                span { class: "fiat-currency-flag", aria_hidden: true, "{current.flag()}" }
                span { class: "wallet-hero-metric-amount", "{amount_label}" }
                ExpandMoreIcon {
                    size: 16,
                    class: if open { "wallet-account-caret is-open" } else { "wallet-account-caret" },
                }
            }

            if open {
                section {
                    id: "fiat-currency-dropdown",
                    class: "wallet-account-dropdown fiat-currency-menu-dropdown",
                    "data-aeon-part": "content",
                    aria_label: "Choose currency",
                    header { class: "wallet-account-heading",
                        div { strong { "Choose currency" } }
                        span { class: "wallet-account-count", "{FiatCode::ALL.len()}" }
                    }
                    ul { class: "wallet-account-list", role: "listbox", aria_label: "Currencies",
                        for opt in FiatCode::ALL {
                            {
                                let selected = opt == current;
                                let svc_save = Arc::clone(&services);
                                rsx! {
                                    li { key: "{opt.as_str()}",
                                        div { class: "wallet-account-row",
                                            button {
                                                r#type: "button",
                                                role: "option",
                                                aria_selected: selected,
                                                class: if selected { "wallet-account-option is-selected" } else { "wallet-account-option" },
                                                onclick: move |_| {
                                                    fiat_code.set(opt);
                                                    svc_save.save_fiat_currency(opt);
                                                    if svc_save.current_fx_rates().rate_for(opt).is_none() {
                                                        let svc_bg = Arc::clone(&svc_save);
                                                        svc_save.engine.runtime_handle().spawn(async move {
                                                            svc_bg.refresh_fx_rates_async().await;
                                                        });
                                                    }
                                                    open_menu.set(None);
                                                },
                                                span { class: "wallet-account-option-lead",
                                                    span { class: "fiat-currency-option-flag", aria_hidden: true, "{opt.flag()}" }
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
}

/// 1:1 port of `src/components/WalletAccountMenu.tsx` (multi-account switcher + holding status + Add wallet).
#[component]
pub fn WalletAccountMenu(
    profile: SessionSummary,
    mut app_machine: Signal<AppSessionMachine>,
    mut snapshot: Signal<WalletSnapshot>,
    mut nav_section: Signal<NavSection>,
    mut nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
    mut open_menu: Signal<Option<&'static str>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut busy = use_signal(|| false);
    let mut menu_error = use_signal(|| Option::<String>::None);
    let open = *open_menu.read() == Some("account");
    let is_busy = *busy.read();

    let accounts = services.list_vault_accounts();
    let active_index = profile.account_index;
    let current_acc = accounts.iter().find(|a| a.index == active_index);
    let current_ik = current_acc
        .map(|a| a.identity_key.as_str())
        .unwrap_or(&profile.identity_key);
    let current_prof = services.account_profile_for(&profile.chain, active_index, current_ik);
    let current_handle = services.claimed_handle_for(&profile.chain, active_index, current_ik);
    let current_name = current_handle
        .clone()
        .or_else(|| current_prof.as_ref().map(|p| p.name.clone()))
        .or_else(|| {
            current_acc.map(|a| {
                if a.index == 0 {
                    format!("${}", profile.handle)
                } else {
                    a.name.clone()
                }
            })
        })
        .unwrap_or_else(|| format!("${}", profile.handle));
    let identity_copy = profile.identity_key.clone();
    let svc_create = Arc::clone(&services);

    rsx! {
        div { class: "wallet-nav-actions-pill wallet-hero-identity-chrome",
            div {
                class: "wallet-account-menu",
                "data-aeon-scope": "wallet-account-menu",
                "data-aeon-state": if is_busy { "switching" } else if open { "open" } else { "closed" },

                div { class: "wallet-hero-identity-row",
                    button {
                        r#type: "button",
                        class: "wallet-hero-identity",
                        "data-aeon-part": "trigger",
                        aria_controls: "wallet-account-dropdown",
                        aria_expanded: open,
                        aria_haspopup: "dialog",
                        disabled: is_busy,
                        title: "Switch wallet",
                        onclick: move |_| {
                            menu_error.set(None);
                            let next = if *open_menu.read() == Some("account") { None } else { Some("account") };
                            open_menu.set(next);
                        },
                        if let Some(ref prof) = current_prof {
                            ProfileAvatar {
                                label: prof.name.clone(),
                                image_url: prof.image_data_url.clone(),
                                identity_key: Some(prof.identity_key.clone()),
                            }
                        }
                        span { "{current_name}" }
                        ExpandMoreIcon {
                            size: 16,
                            class: if open { "wallet-account-caret is-open" } else { "wallet-account-caret" },
                        }
                    }
                    button {
                        r#type: "button",
                        class: "wallet-hero-identity-copy",
                        title: "Copy identity key",
                        aria_label: "Copy pay address",
                        onclick: move |_| match copy_to_clipboard(&identity_copy) {
                            Ok(()) => toast.set(Some(ToastNotice {
                                title: "Copied".into(),
                                body: Some("Wallet identity key copied.".into()),
                                tone: "success",
                            })),
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Copy failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        },
                        CopyIcon { size: 14 }
                    }
                }

                if open {
                    section {
                        id: "wallet-account-dropdown",
                        class: "wallet-account-dropdown",
                        "data-aeon-part": "content",
                        aria_label: "Choose wallet",
                        header { class: "wallet-account-heading",
                            div { strong { "Choose wallet" } }
                            span { class: "wallet-account-count", "{accounts.len()}" }
                        }

                        ul { class: "wallet-account-list", role: "listbox", aria_label: "Wallets",
                            for acc in accounts.iter() {
                                {
                                    let idx = acc.index;
                                    let selected = idx == active_index;
                                    let held_here = acc.held_here;
                                    let acc_prof = services.account_profile_for(&profile.chain, idx, &acc.identity_key);
                                    let acc_handle = services.claimed_handle_for(&profile.chain, idx, &acc.identity_key);
                                    let fallback_label = if idx == 0 && !profile.handle.is_empty() {
                                        format!("${}", profile.handle)
                                    } else {
                                        acc.name.clone()
                                    };
                                    let display_name = acc_prof
                                        .as_ref()
                                        .map(|p| p.name.clone())
                                        .unwrap_or_else(|| fallback_label.clone());
                                    let subtitle = if !held_here {
                                        "On another device".to_string()
                                    } else if let Some(ref h) = acc_handle {
                                        h.clone()
                                    } else if acc_prof.is_some() {
                                        fallback_label.clone()
                                    } else {
                                        "No public profile".to_string()
                                    };
                                    let svc_switch = Arc::clone(&services);
                                    let svc_edit = Arc::clone(&services);
                                    let edit_label = if acc_prof.is_some() {
                                        format!("Edit {display_name} profile")
                                    } else {
                                        format!("Publish a profile for {display_name}")
                                    };
                                    let avatar_img = acc_prof.as_ref().and_then(|p| p.image_data_url.clone());
                                    let avatar_ik = acc_prof.as_ref().map(|p| p.identity_key.clone());
                                    rsx! {
                                        li { key: "{idx}",
                                            div { class: "wallet-account-row",
                                                button {
                                                    r#type: "button",
                                                    role: "option",
                                                    aria_selected: selected,
                                                    class: if selected { "wallet-account-option is-selected" } else { "wallet-account-option" },
                                                    disabled: is_busy,
                                                    onclick: move |_| {
                                                        menu_error.set(None);
                                                        if selected {
                                                            open_menu.set(None);
                                                            return;
                                                        }
                                                        if !held_here {
                                                            toast.set(Some(ToastNotice {
                                                                title: "Held elsewhere".into(),
                                                                body: Some("This wallet is currently held by another device.".into()),
                                                                tone: "error",
                                                            }));
                                                            return;
                                                        }
                                                        busy.set(true);
                                                        match svc_switch.switch_vault_account(idx) {
                                                            Ok(next_profile) => {
                                                                let next_snap = svc_switch.read_snapshot();
                                                                let sats = next_snap.balance.displayed_sats;
                                                                snapshot.set(next_snap);
                                                                app_machine.write().send(AppSessionEvent::Switched {
                                                                    profile: next_profile,
                                                                    balance_sats: sats,
                                                                });
                                                                nav_child.set(None);
                                                                open_menu.set(None);
                                                            }
                                                            Err(e) => {
                                                                menu_error.set(Some(e.clone()));
                                                                toast.set(Some(ToastNotice {
                                                                    title: "Switch wallet".into(),
                                                                    body: Some(e),
                                                                    tone: "error",
                                                                }));
                                                            }
                                                        }
                                                        busy.set(false);
                                                    },
                                                    span { class: "wallet-account-option-lead",
                                                        ProfileAvatar {
                                                            label: display_name.clone(),
                                                            image_url: avatar_img,
                                                            identity_key: avatar_ik,
                                                        }
                                                        span { class: "wallet-account-option-copy",
                                                            strong { "{display_name}" }
                                                            span { "{subtitle}" }
                                                        }
                                                    }
                                                    if selected {
                                                        CheckIcon { size: 17, class: "wallet-account-option-check" }
                                                    }
                                                }
                                                if held_here {
                                                    button {
                                                        r#type: "button",
                                                        class: "wallet-account-profile-btn",
                                                        disabled: is_busy,
                                                        title: "{edit_label}",
                                                        aria_label: "{edit_label}",
                                                        onclick: move |_| {
                                                            if !selected {
                                                                if let Ok(next_profile) = svc_edit.switch_vault_account(idx) {
                                                                    let next_snap = svc_edit.read_snapshot();
                                                                    let sats = next_snap.balance.displayed_sats;
                                                                    snapshot.set(next_snap);
                                                                    app_machine.write().send(AppSessionEvent::Switched {
                                                                        profile: next_profile,
                                                                        balance_sats: sats,
                                                                    });
                                                                }
                                                            }
                                                            nav_section.set(NavSection::Identity);
                                                            nav_child.set(None);
                                                            open_menu.set(None);
                                                        },
                                                        EditIcon { size: 16 }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        button {
                            r#type: "button",
                            class: "wallet-account-create",
                            disabled: is_busy,
                            onclick: move |_| {
                                menu_error.set(None);
                                busy.set(true);
                                match svc_create.create_vault_account() {
                                    Ok((row, next_profile)) => {
                                        let next_snap = svc_create.read_snapshot();
                                        let sats = next_snap.balance.displayed_sats;
                                        snapshot.set(next_snap);
                                        app_machine.write().send(AppSessionEvent::Switched {
                                            profile: next_profile,
                                            balance_sats: sats,
                                        });
                                        nav_child.set(None);
                                        open_menu.set(None);
                                        toast.set(Some(ToastNotice {
                                            title: "Wallet created".into(),
                                            body: Some(row.name),
                                            tone: "success",
                                        }));
                                    }
                                    Err(e) => {
                                        menu_error.set(Some(e.clone()));
                                        toast.set(Some(ToastNotice {
                                            title: "Create wallet".into(),
                                            body: Some(e),
                                            tone: "error",
                                        }));
                                    }
                                }
                                busy.set(false);
                            },
                            AddIcon { size: 16 }
                            span { "Add wallet" }
                        }

                        if let Some(ref err) = *menu_error.read() {
                            p { class: "wallet-account-error", role: "alert", "{err}" }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/TickerCoinSelector.tsx` (multi-currency coin selector dropdown in `.wallet-hero-head`).
#[component]
pub fn TickerCoinSelector(
    mut active_coin: Signal<MarketCoin>,
    bsv_sats: u64,
    bsv_fiat_label: String,
    zero_fiat_label: String,
    mut open_menu: Signal<Option<&'static str>>,
) -> Element {
    let open = *open_menu.read() == Some("coin");
    let current = *active_coin.read();
    let bsv_text = format_bsv(bsv_sats);
    let bsv_amount = bsv_text.trim_end_matches(" BSV").to_string();
    let trigger_aria = format!("Choose coin ({})", current.code());

    rsx! {
        div {
            class: "wallet-nav-actions-pill wallet-hero-metric ticker-coin-selector",
            "data-aeon-scope": "ticker-coin",
            "data-aeon-state": if open { "open" } else { "closed" },
            button {
                r#type: "button",
                class: "ticker-coin-trigger",
                "data-aeon-part": "trigger",
                aria_haspopup: "dialog",
                aria_expanded: open,
                aria_label: "{trigger_aria}",
                title: "Choose coin",
                onclick: move |_| {
                    let next = if *open_menu.read() == Some("coin") { None } else { Some("coin") };
                    open_menu.set(next);
                },
                span { class: "ticker-coin-trigger-mark", aria_hidden: true,
                    TickerCoinMark { coin: current.as_str(), size: 18 }
                }
                span { class: "ticker-coin-trigger-code", "{current.code()}" }
                ExpandMoreIcon {
                    size: 16,
                    class: if open { "wallet-account-caret is-open" } else { "wallet-account-caret" },
                }
            }

            if open {
                section {
                    id: "ticker-coin-dropdown",
                    class: "wallet-account-dropdown ticker-coin-dropdown",
                    "data-aeon-part": "content",
                    aria_label: "Choose coin",
                    header { class: "wallet-account-heading",
                        div { strong { "Choose coin" } }
                        span { class: "wallet-account-count", "{MarketCoin::ALL.len()}" }
                    }
                    ul { class: "wallet-account-list", role: "listbox", aria_label: "Coins",
                        for coin in MarketCoin::ALL {
                            {
                                let selected = coin == current;
                                let amt_str = if coin == MarketCoin::Bsv {
                                    bsv_amount.clone()
                                } else {
                                    "0".to_string()
                                };
                                let fiat_str = if coin == MarketCoin::Bsv {
                                    bsv_fiat_label.clone()
                                } else {
                                    zero_fiat_label.clone()
                                };
                                rsx! {
                                    li { key: "{coin.as_str()}",
                                        div { class: "wallet-account-row",
                                            button {
                                                r#type: "button",
                                                role: "option",
                                                aria_selected: selected,
                                                class: if selected {
                                                    "wallet-account-option ticker-coin-row is-selected"
                                                } else {
                                                    "wallet-account-option ticker-coin-row"
                                                },
                                                onclick: move |_| {
                                                    active_coin.set(coin);
                                                    open_menu.set(None);
                                                },
                                                span { class: "wallet-account-option-lead",
                                                    span { class: "ticker-coin-option-mark", aria_hidden: true,
                                                        TickerCoinMark { coin: coin.as_str(), size: 22 }
                                                    }
                                                    span { class: "wallet-account-option-copy",
                                                        strong { "{coin.code()}" }
                                                        span { "{coin.name()}" }
                                                    }
                                                }
                                                span { class: "ticker-coin-option-balance",
                                                    strong { "{amt_str}" }
                                                    span { "{fiat_str}" }
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
}

/// 1:1 port of `src/components/AppToastHost.tsx` (global dismissible toast banner).
#[component]
pub fn AppToastHost(mut toast: Signal<Option<ToastNotice>>) -> Element {
    let current = toast.read().clone();
    let Some(t) = current else {
        return rsx! {};
    };
    rsx! {
        div {
            class: "app-toast-host",
            role: "status",
            aria_live: "polite",
            "data-aeon-scope": "toast",
            "data-tone": "{t.tone}",
            button {
                r#type: "button",
                class: "app-toast",
                "data-tone": "{t.tone}",
                title: "Dismiss",
                onclick: move |_| toast.set(None),
                strong { class: "app-toast-title", "{t.title}" }
                if let Some(ref b) = t.body {
                    span { class: "app-toast-body", "{b}" }
                }
            }
        }
    }
}
