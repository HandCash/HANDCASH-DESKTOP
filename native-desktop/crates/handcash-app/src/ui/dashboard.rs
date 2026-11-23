// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/Dashboard.tsx` and `src/components/WalletNav.tsx`,
//! with child-flow CTAs baked directly into `.wallet-nav-titlebar-tabs[data-permission=""]`
//! via `WalletActionBarNav`.

use crate::icons::{
    ActivityIcon, AppsIcon, BackIcon, CoinGlyphIcon, CollectablesIcon, FriendsIcon, IdentityIcon,
    PersonAddIcon, ReceiveIcon, RefreshIcon, SendIcon, SettingsIcon, SwapIcon,
};
use crate::machines::{
    AppSessionMachine, DisplayCurrency, FiatCode, NavChild, NavSection, ToastNotice,
};
use crate::state::{
    copy_to_clipboard, format_bsv, format_fiat_value, AppServices, FxRates, SessionSummary,
    WalletSnapshot,
};
use crate::theme::AppearancePreference;
use crate::ui::chrome::{DockSpec, DockTrigger, WalletActionBarNav};
use crate::ui::{activity, apps, chrome, collectables, friends, panels, send, side};
use aeon_ui::button;
use dioxus::prelude::*;
use std::sync::Arc;

/// 1:1 port of `src/components/Dashboard.tsx`.
#[component]
pub fn Dashboard(
    profile: SessionSummary,
    app_machine: Signal<AppSessionMachine>,
    mut snapshot: Signal<WalletSnapshot>,
    mut nav_section: Signal<NavSection>,
    mut nav_child: Signal<Option<NavChild>>,
    mut currency: Signal<DisplayCurrency>,
    fiat_code: Signal<FiatCode>,
    fx_rates: Signal<FxRates>,
    appearance: Signal<AppearancePreference>,
    mut toast: Signal<Option<ToastNotice>>,
    mut fresh_mnemonic: Signal<Option<String>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let open_menu = use_signal(|| Option::<&'static str>::None);
    let mut dock_spec = use_signal(|| Option::<DockSpec>::None);
    let dock_trigger = use_signal(DockTrigger::default);
    let collection_view = use_signal(|| services.load_collection_view());
    let svc_brc150 = Arc::clone(&services);

    let snap = snapshot.read().clone();
    let cur = *currency.read();
    let active_child = nav_child.read().clone();
    let active_section = *nav_section.read();

    // Clear docked CTAs whenever no child panel is active (or a non-docked child is open).
    let child_supports_dock = matches!(
        active_child,
        Some(
            NavChild::Send(_)
                | NavChild::CollectableDetails(_)
                | NavChild::SendCollectable(_)
                | NavChild::BurnAsset(_)
                | NavChild::AddFriend
                | NavChild::FriendDetails(_)
                | NavChild::AppDetails(_)
        )
    );
    if !child_supports_dock && dock_spec.read().is_some() {
        dock_spec.set(None);
    }
    let active_dock = if child_supports_dock {
        dock_spec.read().clone()
    } else {
        None
    };

    let bsv_text = format_bsv(snap.balance.displayed_sats);
    let bsv_num = bsv_text.trim_end_matches(" BSV");
    let cur_fiat = *fiat_code.read();
    let fx = fx_rates.read().clone();
    let fiat_label = fx
        .format_sats(snap.balance.displayed_sats, cur_fiat)
        .unwrap_or_else(|| {
            if snap.balance.displayed_sats == 0 {
                format_fiat_value(0.0, cur_fiat)
            } else {
                format!("{} {}", bsv_num, cur_fiat.iso())
            }
        });
    let menu_open_attr = if open_menu.read().is_some() {
        Some("true")
    } else {
        None
    };
    let has_crumbs_attr = if active_child.is_some() {
        Some("")
    } else {
        None
    };

    rsx! {
        section {
            class: "dashboard",
            "data-aeon-scope": "dashboard",
            "data-aeon-state": "ready",

            div { class: "dashboard-main",
                // ── Wallet Hero Panel (`src/components/Dashboard.tsx` lines 751-869) ──
                div {
                    class: "panel wallet-hero",
                    "data-aeon-scope": "wallet-hero",
                    "data-aeon-shell": "wide",
                    "data-menu-open": menu_open_attr,

                    div { class: "connected-panel-head wallet-hero-head",
                        chrome::FiatCurrencyMenu {
                            fiat_code,
                            amount_label: fiat_label.clone(),
                            open_menu,
                        }

                        chrome::WalletAccountMenu {
                            profile: profile.clone(),
                            app_machine,
                            snapshot,
                            nav_section,
                            nav_child,
                            toast,
                            open_menu,
                        }
                    }

                    div { class: "wallet-hero-main",
                        div { class: "wallet-balance-block",
                            div { class: "wallet-balance-slot",
                                button {
                                    r#type: "button",
                                    class: "wallet-balance",
                                    "data-aeon-part": "balance",
                                    "data-aeon-state": cur.as_attr(),
                                    title: if cur == DisplayCurrency::Usd {
                                        "Show in BSV"
                                    } else {
                                        "Show in fiat"
                                    },
                                    onclick: move |_| {
                                        let next = cur.toggle();
                                        currency.set(next);
                                    },
                                    span {
                                        class: if cur == DisplayCurrency::Bsv {
                                            "balance balance-primary balance-coin"
                                        } else {
                                            "balance balance-primary balance-fiat"
                                        },
                                        "data-chain": "bsv",
                                        span { class: "balance-unit-mark",
                                            CoinGlyphIcon { size: 22 }
                                        }
                                        if cur == DisplayCurrency::Bsv {
                                            "{bsv_num}"
                                        } else {
                                            "{fiat_label}"
                                        }
                                    }
                                }
                            }
                        }

                        div { class: "actions wallet-actions",
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost btn-icon",
                                aria_pressed: matches!(active_child, Some(NavChild::Send(_))),
                                onclick: move |_| nav_child.set(Some(NavChild::Send(None))),
                                SendIcon { size: 22 }
                                span { class: "wallet-action-label", "Send" }
                            }
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost btn-icon wallet-action--swap",
                                aria_pressed: active_child == Some(NavChild::Swap),
                                onclick: move |_| nav_child.set(Some(NavChild::Swap)),
                                SwapIcon { size: 22 }
                                span { class: "wallet-action-label", "Swap" }
                            }
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost btn-icon",
                                aria_pressed: active_child == Some(NavChild::Receive),
                                onclick: move |_| nav_child.set(Some(NavChild::Receive)),
                                ReceiveIcon { size: 22 }
                                span { class: "wallet-action-label", "Receive" }
                            }
                        }
                    }
                }

                // ── Fresh Recovery Phrase Banner (if just created) ──
                if let Some(ref phrase) = *fresh_mnemonic.read() {
                    div { class: "panel", style: "display: flex; flex-direction: column; gap: 10px;",
                        div { class: "connected-panel-head",
                            h2 { "Save your 24-word recovery phrase" }
                        }
                        p { class: "settings-row-desc",
                            "Write these 24 words down offline. HandCash cannot recover them for you."
                        }
                        div {
                            class: "mono",
                            style: "padding: 12px; border-radius: 10px; border: 1px solid var(--hc-border); background: var(--hc-field); line-height: 1.6;",
                            "{phrase}"
                        }
                        div { class: "actions",
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
                            button::Root {
                                variant: button::ButtonVariant::Solid,
                                class: "btn btn-primary",
                                onclick: move |_| fresh_mnemonic.set(None),
                                button::Label { "I saved it" }
                            }
                        }
                    }
                }

                // ── WalletNav Shell (`src/components/WalletNav.tsx`) ──
                section {
                    class: "wallet-nav-shell panel",
                    "data-aeon-scope": "wallet-nav",
                    "data-aeon-state": active_section.as_attr(),

                    div { class: "wallet-nav",
                        // Desktop titlebar pill: root label (+ / child) then either docked CTAs OR section tabs
                        div {
                            class: "wallet-nav-titlebar",
                            "data-has-crumbs": has_crumbs_attr,
                            div {
                                class: "wallet-nav-titlebar-pill",
                                "data-has-crumbs": has_crumbs_attr,
                                span { class: "wallet-nav-titlebar-label",
                                    "{active_section.label()}"
                                }
                                if let Some(ref child) = active_child {
                                    nav { class: "nav-breadcrumb wallet-nav-titlebar-crumbs",
                                        span { class: "nav-breadcrumb-sep nav-breadcrumb-sep--leading", "/" }
                                        span { class: "nav-breadcrumb-current", "{child.label()}" }
                                    }
                                }
                                if let Some(spec) = active_dock {
                                    WalletActionBarNav {
                                        spec,
                                        trigger: dock_trigger,
                                    }
                                } else {
                                    div {
                                        class: "wallet-nav-titlebar-tabs",
                                        role: "tablist",
                                        aria_label: "Wallet sections",
                                        for (idx, sec) in NavSection::ALL.into_iter().enumerate() {
                                            button {
                                                r#type: "button",
                                                role: "tab",
                                                class: "wallet-nav-tab",
                                                title: "{sec.label()}",
                                                aria_selected: active_section == sec && has_crumbs_attr.is_none(),
                                                "data-selected": if active_section == sec && has_crumbs_attr.is_none() { Some("") } else { None },
                                                "data-before-selected": if has_crumbs_attr.is_none() && NavSection::ALL.get(idx + 1) == Some(&active_section) { Some("") } else { None },
                                                onclick: move |_| {
                                                    dock_spec.set(None);
                                                    nav_section.set(sec);
                                                    nav_child.set(None);
                                                },
                                                match sec {
                                                    NavSection::Activity => rsx! { ActivityIcon { size: 18 } },
                                                    NavSection::Apps => rsx! { AppsIcon { size: 18 } },
                                                    NavSection::Collectables => rsx! { CollectablesIcon { size: 18 } },
                                                    NavSection::Friends => rsx! { FriendsIcon { size: 18 } },
                                                    NavSection::Identity => rsx! { IdentityIcon { size: 18 } },
                                                    NavSection::Settings => rsx! { SettingsIcon { size: 18 } },
                                                }
                                                span { class: "wallet-nav-tab-label", "{sec.label()}" }
                                                span { class: "wallet-nav-tab-label-short", "{sec.short_label()}" }
                                            }
                                        }
                                    }
                                }
                            }

                            div { class: "wallet-nav-titlebar-actions",
                                if active_child.is_some() {
                                    div { class: "wallet-nav-actions-pill",
                                        button {
                                            r#type: "button",
                                            class: "wallet-nav-chrome-btn",
                                            aria_label: "Back",
                                            title: "Back",
                                            onclick: move |_| {
                                                dock_spec.set(None);
                                                nav_child.set(None);
                                            },
                                            BackIcon { size: 18 }
                                        }
                                    }
                                } else if active_section == NavSection::Collectables {
                                    div { class: "wallet-nav-actions-pill",
                                        collectables::CollectionViewToggle { view: collection_view }
                                        button {
                                            r#type: "button",
                                            class: "wallet-nav-chrome-btn",
                                            aria_label: "Verify BRC-150",
                                            title: "Verify BRC-150",
                                            onclick: move |_| match svc_brc150.verify_brc150_batch() {
                                                Ok(n) => {
                                                    snapshot.set(svc_brc150.read_snapshot());
                                                    toast.set(Some(ToastNotice {
                                                        title: "BRC-150 verified".into(),
                                                        body: Some(format!("Verified {n} item(s).")),
                                                        tone: "success",
                                                    }));
                                                }
                                                Err(e) => toast.set(Some(ToastNotice {
                                                    title: "Verification failed".into(),
                                                    body: Some(e),
                                                    tone: "error",
                                                })),
                                            },
                                            RefreshIcon { size: 16 }
                                        }
                                    }
                                } else if active_section == NavSection::Friends {
                                    div { class: "wallet-nav-actions-pill",
                                        button {
                                            r#type: "button",
                                            class: "wallet-nav-chrome-btn",
                                            aria_label: "Add friend",
                                            title: "Add friend",
                                            onclick: move |_| nav_child.set(Some(NavChild::AddFriend)),
                                            PersonAddIcon { size: 16 }
                                        }
                                        collectables::CollectionViewToggle { view: collection_view }
                                    }
                                } else if active_section == NavSection::Apps {
                                    div { class: "wallet-nav-actions-pill",
                                        collectables::CollectionViewToggle { view: collection_view }
                                    }
                                }
                            }
                        }

                        // Stage: either active child flow or active root section
                        div { class: "wallet-nav-stage",
                            if let Some(child) = active_child {
                                div { class: "wallet-nav-panel nav-child-stage",
                                    div { class: "nav-child-body",
                                        match child {
                                            NavChild::Send(initial_recipient) => rsx! {
                                                send::SendPanel {
                                                    snap: snap.clone(),
                                                    initial_recipient,
                                                    nav_child,
                                                    dock_spec,
                                                    dock_trigger,
                                                    toast,
                                                }
                                            },
                                            NavChild::Receive => rsx! {
                                                panels::ReceivePanel {
                                                    profile: profile.clone(),
                                                    toast,
                                                }
                                            },
                                            NavChild::Swap => rsx! {
                                                panels::SwapPanel {}
                                            },
                                            NavChild::Scan => rsx! {
                                                panels::ScanPanel {
                                                    nav_child,
                                                }
                                            },
                                            NavChild::PaymentDetails(entry_id) => rsx! {
                                                activity::PaymentDetailsPanel {
                                                    entry_id,
                                                    chain: profile.chain.clone(),
                                                    snap: snap.clone(),
                                                    currency: cur,
                                                    fiat_code: cur_fiat,
                                                    fx_rates: fx.clone(),
                                                    toast,
                                                }
                                            },
                                            NavChild::CollectableDetails(outpoint) => rsx! {
                                                collectables::CollectableDetailsPanel {
                                                    outpoint,
                                                    chain: profile.chain.clone(),
                                                    snap: snap.clone(),
                                                    snapshot,
                                                    nav_child,
                                                    dock_spec,
                                                    dock_trigger,
                                                    toast,
                                                }
                                            },
                                            NavChild::SendCollectable(outpoint) => rsx! {
                                                collectables::SendCollectablePanel {
                                                    outpoint,
                                                    snap: snap.clone(),
                                                    nav_child,
                                                    dock_spec,
                                                    dock_trigger,
                                                    toast,
                                                }
                                            },
                                            NavChild::BurnAsset(outpoint) => rsx! {
                                                collectables::BurnAssetPanel {
                                                    outpoint,
                                                    snap: snap.clone(),
                                                    nav_child,
                                                    dock_spec,
                                                    dock_trigger,
                                                    toast,
                                                }
                                            },
                                            NavChild::AddFriend => rsx! {
                                                friends::AddFriendPanel {
                                                    nav_child,
                                                    dock_spec,
                                                    dock_trigger,
                                                    toast,
                                                }
                                            },
                                            NavChild::FriendDetails(friend_id) => rsx! {
                                                friends::FriendDetailsPanel {
                                                    friend_id,
                                                    nav_child,
                                                    dock_spec,
                                                    dock_trigger,
                                                    toast,
                                                }
                                            },
                                            NavChild::AppDetails(origin) => rsx! {
                                                apps::AppDetailsPanel {
                                                    origin,
                                                    nav_child,
                                                    dock_spec,
                                                    dock_trigger,
                                                    toast,
                                                }
                                            },
                                            NavChild::Setting(sub) => rsx! {
                                                panels::SettingSubpagePanel {
                                                    subpage: sub,
                                                    profile: profile.clone(),
                                                    snap: snap.clone(),
                                                    snapshot,
                                                    toast,
                                                }
                                            },
                                        }
                                    }
                                }
                            } else {
                                div { class: "wallet-nav-panel",
                                    div { class: "wallet-nav-slot",
                                        match active_section {
                                            NavSection::Activity => rsx! {
                                                activity::ActivityFeed {
                                                    snap: snap.clone(),
                                                    title: "Activity",
                                                    embedded: true,
                                                    show_view_all: false,
                                                    show_filters: true,
                                                    currency: cur,
                                                    fiat_code: cur_fiat,
                                                    fx_rates: fx.clone(),
                                                    nav_section,
                                                    nav_child,
                                                }
                                            },
                                            NavSection::Apps => rsx! {
                                                apps::ConnectedAppsPanel {
                                                    snap: snap.clone(),
                                                    view: collection_view,
                                                    nav_child,
                                                }
                                            },
                                            NavSection::Collectables => rsx! {
                                                collectables::InventoryPanel {
                                                    snap: snap.clone(),
                                                    view: collection_view,
                                                    nav_child,
                                                }
                                            },
                                            NavSection::Friends => rsx! {
                                                friends::FriendsPanel {
                                                    view: collection_view,
                                                    nav_child,
                                                }
                                            },
                                            NavSection::Identity => rsx! {
                                                panels::IdentityPanel {
                                                    profile: profile.clone(),
                                                    toast,
                                                }
                                            },
                                            NavSection::Settings => rsx! {
                                                panels::SettingsPanel {
                                                    snap: snap.clone(),
                                                    appearance,
                                                    nav_child,
                                                    fiat_code,
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

            // ── Right Side Column (`src/components/DashboardSideColumn.tsx`) ──
            side::DashboardSideColumn {
                snap,
                currency: cur,
                fiat_code: cur_fiat,
                fx_rates: fx,
                nav_section,
                nav_child,
                toast,
            }
        }
    }
}
