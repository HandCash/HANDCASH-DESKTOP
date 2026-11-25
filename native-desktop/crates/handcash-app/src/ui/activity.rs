// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/RecentActivity.tsx`, `src/components/PaymentFiltersPanel.tsx`,
//! and `src/components/PaymentDetailsPanel.tsx`.

use crate::icons::{
    bsv_logo_png_data_uri, ActivityIcon, AppsIcon, CancelListingIcon, CopyIcon, FilterIcon,
    FireIcon, LaunchIcon, ListingIcon, MintIcon, PurchaseIcon, ReceiveIcon, SendIcon, SoldIcon,
    WarningIcon,
};
use crate::machines::{
    DisplayCurrency, FiatCode, NavChild, NavSection, PaymentFilters, PaymentKindFilter,
    PaymentStatusFilter, PaymentTimeFilter, ToastNotice,
};
use crate::state::{
    copy_to_clipboard, format_bsv, format_relative_time, now_ms, open_external_url, truncate_mid,
    tx_explorer_url, FxRates, WalletSnapshot,
};
use crate::ui::primitives::LoadingSpinner;
use crate::ui::EmptyState;
use aeon_dioxus::use_aeon_machine_with;
use aeon_ui::button;
use dioxus::prelude::*;
use handcash_machines::pairing_code::{
    PairingCodeEvent, PairingCodeInput, PairingCodeMachine, PairingCodeState,
};
use handcash_storage::ActivityRow;
use std::collections::BTreeSet;

fn is_spent(row: &ActivityRow) -> bool {
    let dir = row.direction.to_ascii_lowercase();
    dir == "out" || dir == "outgoing" || dir == "spent" || row.satoshis < 0
}

fn is_failed(row: &ActivityRow) -> bool {
    let s = row.status.to_ascii_lowercase();
    s.contains("fail") || s.contains("error") || s.contains("reject")
}

/// TS `activityActionMark` (`src/wallet/activityActionMark.ts`).
fn action_mark(row: &ActivityRow) -> Option<&'static str> {
    let kind = row.kind.to_ascii_lowercase();
    let named = match kind.as_str() {
        "market-list" | "direct-offer-list" => Some("list"),
        "market-cancel" | "direct-offer-cancel" => Some("cancel"),
        "market-sale" | "market-sale-proceeds" | "direct-offer-sale" => Some("sale"),
        "market-purchase" | "market-purchase-receive" | "direct-offer-buy" => Some("purchase"),
        _ => None,
    };
    if named.is_none() && is_event(row) {
        return None;
    }
    if is_failed(row) {
        return Some("failed");
    }
    if named.is_some() {
        return named;
    }
    if kind.contains("burn") {
        return Some("burn");
    }
    if kind.contains("mint") {
        return Some("mint");
    }
    Some(if is_spent(row) { "send" } else { "receive" })
}

fn is_pending(row: &ActivityRow) -> bool {
    let s = row.status.to_ascii_lowercase();
    s.contains("pending") || s.contains("unconfirmed") || s.contains("unproven")
}

/// TS `showSending` label in `HistoryIconCluster`.
fn pending_mark_label(row: &ActivityRow, mark: Option<&str>) -> Option<&'static str> {
    if !is_pending(row) || is_failed(row) {
        return None;
    }
    match mark {
        Some("burn") => Some("Burning"),
        Some("list") => Some("Listing"),
        Some("cancel") => Some("Cancelling"),
        _ if is_spent(row) && !is_event(row) => Some("Sending"),
        _ => None,
    }
}

/// A wallet event (connect, approve, …) moves no money.
fn is_event(row: &ActivityRow) -> bool {
    row.satoshis == 0 && !is_spent(row)
}

fn action_mark_label(mark: &str) -> &'static str {
    match mark {
        "failed" => "Failed",
        "list" => "Listing",
        "cancel" => "Cancel listing",
        "sale" => "Sold",
        "purchase" => "Purchase",
        "burn" => "Burn",
        "mint" => "Mint",
        "send" => "Send",
        _ => "Receive",
    }
}

/// TS `HistoryActionMarkBadge` (overlay size: glyph 9px).
#[component]
pub fn HistoryActionMarkBadge(mark: String) -> Element {
    let label = action_mark_label(&mark);
    let glyph = match mark.as_str() {
        "failed" => rsx! { WarningIcon { size: 9 } },
        "list" => rsx! { ListingIcon { size: 8 } },
        "cancel" => rsx! { CancelListingIcon { size: 9 } },
        "sale" => rsx! { SoldIcon { size: 10 } },
        "purchase" => rsx! { PurchaseIcon { size: 9 } },
        "burn" => rsx! { FireIcon { size: 8 } },
        "mint" => rsx! { MintIcon { size: 8 } },
        "send" => rsx! { SendIcon { size: 7 } },
        _ => rsx! { ReceiveIcon { size: 9 } },
    };
    rsx! {
        span {
            class: "history-action-badge is-{mark}",
            aria_label: "{label}",
            title: "{label}",
            {glyph}
        }
    }
}

/// TS `HistoryIconCluster`: subject mark plus the corner subscripts.
#[component]
pub fn HistoryIconCluster(row: ActivityRow) -> Element {
    let event = is_event(&row);
    let mark = action_mark(&row);
    let origin = row
        .app_origin
        .clone()
        .filter(|o| !o.is_empty() && o != "wallet");
    let bsv = bsv_logo_png_data_uri();
    let pending_label = pending_mark_label(&row, mark);
    rsx! {
        div { class: "history-icon-wrap",
            if let Some(label) = pending_label {
                span {
                    class: "history-pending-mark",
                    aria_live: "polite",
                    aria_label: "{label}",
                    title: "{label}",
                    LoadingSpinner { size: "sm" }
                }
            }
            div { class: "history-icon",
                if event {
                    span { class: "history-item-thumb-icon", aria_hidden: true,
                        if origin.is_some() { AppsIcon { size: 18 } } else { ActivityIcon { size: 18 } }
                    }
                } else {
                    img {
                        class: "history-asset-logo",
                        src: "{bsv}",
                        alt: "",
                        width: "32",
                        height: "32",
                        draggable: "false",
                    }
                }
            }
            if !event {
                if let Some(ref name) = origin {
                    span {
                        class: "history-app-badge",
                        aria_label: "App: {name}",
                        title: "{name}",
                        div {
                            class: "app-avatar app-avatar-sm app-avatar-embedded",
                            "data-aeon-part": "avatar",
                            "data-aeon-state": "fallback",
                            title: "{name}",
                            span { class: "app-avatar-fallback", AppsIcon { size: 8 } }
                        }
                    }
                }
            }
            if let Some(m) = mark {
                HistoryActionMarkBadge { mark: m.to_string() }
            }
        }
    }
}

fn signed_amount_label(
    row: &ActivityRow,
    currency: DisplayCurrency,
    fiat_code: FiatCode,
    fx_rates: &FxRates,
) -> String {
    if is_failed(row) {
        return "Failed".into();
    }
    let abs_sats = row.satoshis.unsigned_abs();
    if abs_sats == 0 {
        return row.kind.clone();
    }
    let sign = if is_spent(row) { "−" } else { "+" };
    if currency == DisplayCurrency::Usd {
        if let Some(fiat) = fx_rates.format_sats(abs_sats, fiat_code) {
            return format!("{sign}{fiat}");
        }
    }
    format!("{sign}{abs_sats} sats")
}

/// 1:1 port of `src/components/PaymentFiltersPanel.tsx`.
#[component]
pub fn PaymentFiltersPanel(mut filters: Signal<PaymentFilters>, origins: Vec<String>) -> Element {
    let cur = filters.read().clone();

    rsx! {
        aside {
            class: "payment-filters",
            "data-aeon-scope": "payment-filters",
            aria_label: "Activity filters",

            div { class: "payment-filter-row",
                span { class: "payment-filter-row-label", "Type" }
                div { class: "payment-filter-options", role: "group", aria_label: "Type",
                    for (opt, label) in [
                        (PaymentKindFilter::All, "All"),
                        (PaymentKindFilter::Spent, "Sent"),
                        (PaymentKindFilter::Earned, "Received"),
                        (PaymentKindFilter::Event, "Actions"),
                    ] {
                        button {
                            r#type: "button",
                            class: if cur.kind == opt { "payment-filter-option is-active" } else { "payment-filter-option" },
                            aria_pressed: cur.kind == opt,
                            onclick: move |_| {
                                let mut next = filters.read().clone();
                                next.kind = opt;
                                filters.set(next);
                            },
                            "{label}"
                        }
                    }
                }
            }

            div { class: "payment-filter-row",
                span { class: "payment-filter-row-label", "Status" }
                div { class: "payment-filter-options", role: "group", aria_label: "Status",
                    for (opt, label) in [
                        (PaymentStatusFilter::All, "All"),
                        (PaymentStatusFilter::Success, "Success"),
                        (PaymentStatusFilter::Failed, "Failed"),
                    ] {
                        button {
                            r#type: "button",
                            class: if cur.status == opt { "payment-filter-option is-active" } else { "payment-filter-option" },
                            aria_pressed: cur.status == opt,
                            onclick: move |_| {
                                let mut next = filters.read().clone();
                                next.status = opt;
                                filters.set(next);
                            },
                            "{label}"
                        }
                    }
                }
            }

            if !origins.is_empty() {
                div { class: "payment-filter-row",
                    span { class: "payment-filter-row-label", "App" }
                    div { class: "payment-filter-options", role: "group", aria_label: "App",
                        button {
                            r#type: "button",
                            class: if cur.origin.is_none() { "payment-filter-option is-active" } else { "payment-filter-option" },
                            aria_pressed: cur.origin.is_none(),
                            onclick: move |_| {
                                let mut next = filters.read().clone();
                                next.origin = None;
                                filters.set(next);
                            },
                            "All"
                        }
                        for origin in origins.iter() {
                            {
                                let orig = origin.clone();
                                let orig_click = origin.clone();
                                let active = cur.origin.as_deref() == Some(orig.as_str());
                                let label = if orig == "wallet" { "HandCash".to_string() } else { orig.clone() };
                                rsx! {
                                    button {
                                        key: "{orig}",
                                        r#type: "button",
                                        class: if active { "payment-filter-option is-active" } else { "payment-filter-option" },
                                        aria_pressed: active,
                                        onclick: move |_| {
                                            let mut next = filters.read().clone();
                                            next.origin = Some(orig_click.clone());
                                            filters.set(next);
                                        },
                                        "{label}"
                                    }
                                }
                            }
                        }
                    }
                }
            }

            div { class: "payment-filter-row",
                span { class: "payment-filter-row-label", "When" }
                div { class: "payment-filter-options", role: "group", aria_label: "When",
                    for (opt, label) in [
                        (PaymentTimeFilter::All, "Any time"),
                        (PaymentTimeFilter::H24, "24h"),
                        (PaymentTimeFilter::D7, "7d"),
                        (PaymentTimeFilter::D30, "30d"),
                    ] {
                        button {
                            r#type: "button",
                            class: if cur.time == opt { "payment-filter-option is-active" } else { "payment-filter-option" },
                            aria_pressed: cur.time == opt,
                            onclick: move |_| {
                                let mut next = filters.read().clone();
                                next.time = opt;
                                filters.set(next);
                            },
                            "{label}"
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/RecentActivity.tsx` (`ActivityFeed`, `RecentActivityPanel`, `TransactionsPanel`).
#[component]
pub fn ActivityFeed(
    snap: WalletSnapshot,
    title: String,
    embedded: bool,
    show_view_all: bool,
    #[props(default = false)] show_filters: bool,
    #[props(default)] filters_open_ext: Option<Signal<bool>>,
    #[props(default)] filters_ext: Option<Signal<PaymentFilters>>,
    currency: DisplayCurrency,
    fiat_code: FiatCode,
    fx_rates: FxRates,
    mut nav_section: Signal<NavSection>,
    mut nav_child: Signal<Option<NavChild>>,
) -> Element {
    let local_filters_open = use_signal(|| false);
    let local_filters = use_signal(PaymentFilters::default);
    let mut filters_open = filters_open_ext.unwrap_or(local_filters_open);
    let mut filters = filters_ext.unwrap_or(local_filters);

    let now = now_ms();
    let cur_filters = filters.read().clone();
    let active_filter_count = cur_filters.active_count();
    let limit = if show_view_all { 15 } else { 50 };

    let origins: Vec<String> = {
        let mut set = BTreeSet::new();
        for row in &snap.activity {
            set.insert(row.app_origin.clone().unwrap_or_else(|| "wallet".into()));
        }
        set.into_iter().collect()
    };

    let filtered_rows: Vec<&ActivityRow> = snap
        .activity
        .iter()
        .filter(|r| !show_filters || cur_filters.matches(r, now))
        .take(limit)
        .collect();

    let body = rsx! {
        if show_filters && *filters_open.read() {
            PaymentFiltersPanel { filters, origins }
        }
        if filtered_rows.is_empty() {
            if show_filters && active_filter_count > 0 {
                EmptyState {
                    icon: Some(rsx! { FilterIcon { size: 28 } }),
                    title: "No matching activity",
                    body: Some("Try clearing one of your active filters.".into()),
                    action: Some(rsx! {
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| filters.set(PaymentFilters::default()),
                            button::Label { "Clear filters" }
                        }
                    }),
                }
            } else {
                EmptyState {
                    icon: Some(rsx! { ActivityIcon { size: 28 } }),
                    title: "No activity yet",
                    body: Some("Sends, receives, connections, and other wallet actions show up here.".into()),
                }
            }
        } else {
            ul { class: "history-list",
                for row in filtered_rows.iter() {
                    {
                        let aid = row.activity_id.clone();
                        let failed = is_failed(row);
                        let amount_str = signed_amount_label(row, currency, fiat_code, &fx_rates);
                        let rel_time = format_relative_time(row.sort_ts_ms, now);
                        let when_str = if row.sort_ts_ms > 0 {
                            rel_time
                        } else if !row.status.trim().is_empty() {
                            row.status.clone()
                        } else {
                            "Confirmed".into()
                        };
                        // TS `HistoryRow` subtitle: failure reason, else a non-wallet app origin.
                        let origin = row
                            .app_origin
                            .clone()
                            .filter(|o| !o.is_empty() && o != "wallet");
                        let subtitle: Option<String> = if failed {
                            Some(row.status.clone()).filter(|s| !s.trim().is_empty())
                        } else {
                            origin
                        };
                        let right_sub = when_str;
                        let row_clone = (*row).clone();
                        rsx! {
                            li {
                                key: "{row.activity_id}",
                                "data-aeon-scope": "activity-row",
                                "data-aeon-state": "{row.status}",
                                "data-activity-failed": if failed { Some("") } else { None },
                                button {
                                    r#type: "button",
                                    class: if failed { "history-row history-row-btn is-failed" } else { "history-row history-row-btn" },
                                    onclick: move |_| {
                                        nav_child.set(Some(NavChild::PaymentDetails(aid.clone())));
                                    },
                                    HistoryIconCluster { row: row_clone }
                                    div { class: "history-body history-progress-body",
                                        strong { class: "history-title", "{row.title}" }
                                        if let Some(ref sub) = subtitle {
                                            span { class: "history-when", title: "{sub}", "{sub}" }
                                        }
                                    }
                                    div { class: "history-amount-block",
                                        span {
                                            class: if failed || row.satoshis == 0 {
                                                "history-amount history-amount-item"
                                            } else {
                                                "history-amount"
                                            },
                                            "{amount_str}"
                                        }
                                        span { class: "history-when", "data-aeon-part": "row-state",
                                            "{right_sub}"
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if show_view_all {
                    li { class: "history-view-all-row",
                        button {
                            r#type: "button",
                            class: "history-view-all",
                            onclick: move |_| {
                                nav_section.set(NavSection::Activity);
                                nav_child.set(None);
                            },
                            "View full activity"
                        }
                    }
                }
            }
        }
    };

    let head = rsx! {
        div { class: "connected-panel-head",
            h2 { "{title}" }
            if show_filters {
                button {
                    r#type: "button",
                    class: if *filters_open.read() || active_filter_count > 0 {
                        "btn btn-ghost payment-filter-toggle is-active"
                    } else {
                        "btn btn-ghost payment-filter-toggle"
                    },
                    aria_expanded: *filters_open.read(),
                    onclick: move |_| {
                        let next = !*filters_open.read();
                        filters_open.set(next);
                    },
                    FilterIcon { size: 15 }
                    if active_filter_count > 0 {
                        span { "Filters ({active_filter_count})" }
                    } else {
                        span { "Filters" }
                    }
                }
            }
        }
    };

    if embedded {
        rsx! {
            div {
                class: "history-embedded history-with-filters",
                "data-aeon-scope": "activity-feed",
                {body}
            }
        }
    } else {
        rsx! {
            section {
                class: "history-panel panel",
                "data-aeon-scope": "recent-activity",
                {head}
                {body}
            }
        }
    }
}

/// 1:1 port of `src/components/PaymentDetailsPanel.tsx`.
#[component]
pub fn PaymentDetailsPanel(
    entry_id: String,
    chain: String,
    snap: WalletSnapshot,
    currency: DisplayCurrency,
    fiat_code: FiatCode,
    fx_rates: FxRates,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let Some(row) = snap
        .activity
        .iter()
        .find(|r| r.activity_id == entry_id)
        .cloned()
    else {
        return rsx! {
            p { class: "connected-empty-line", "Transaction not found" }
        };
    };

    let spent = is_spent(&row);
    let failed = is_failed(&row);
    let abs_sats = row.satoshis.unsigned_abs();
    let primary = if abs_sats == 0 {
        row.kind.clone()
    } else if currency == DisplayCurrency::Usd {
        if let Some(fiat) = fx_rates.format_sats(abs_sats, fiat_code) {
            if spent {
                format!("−{fiat}")
            } else {
                format!("+{fiat}")
            }
        } else if spent {
            format!("−{}", format_bsv(abs_sats))
        } else {
            format!("+{}", format_bsv(abs_sats))
        }
    } else if spent {
        format!("−{}", format_bsv(abs_sats))
    } else {
        format!("+{}", format_bsv(abs_sats))
    };
    let secondary = if currency == DisplayCurrency::Usd {
        format!("{} · {abs_sats} sats", format_bsv(abs_sats))
    } else {
        fx_rates
            .format_sats(abs_sats, fiat_code)
            .map(|f| format!("{f} · {abs_sats} sats"))
            .unwrap_or_else(|| format!("{abs_sats} sats"))
    };
    let when_str = format_relative_time(row.sort_ts_ms, now_ms());
    let explorer_url = row
        .txid
        .as_ref()
        .filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(|t| tx_explorer_url(t, &chain));
    let network_label = if chain == "test" {
        "Bitcoin SV Testnet"
    } else {
        "Bitcoin SV Mainnet"
    };

    rsx! {
        div {
            class: "nav-child-panel payment-details",
            "data-aeon-scope": "payment-details",
            "data-aeon-state": if failed { "failed" } else { "{row.status}" },

            div { class: "payment-details-hero",
                HistoryIconCluster { row: row.clone() }
                div { class: "payment-details-copy",
                    div { class: "payment-details-title-row",
                        strong { class: "payment-details-title", "{row.title}" }
                        if let Some(ref url) = explorer_url {
                            {
                                let url_open = url.clone();
                                rsx! {
                                    button {
                                        r#type: "button",
                                        class: "payment-details-woc",
                                        onclick: move |_| match open_external_url(&url_open) {
                                            Ok(()) => {}
                                            Err(e) => toast.set(Some(ToastNotice {
                                                title: "Open explorer".into(),
                                                body: Some(e),
                                                tone: "error",
                                            })),
                                        },
                                        LaunchIcon { size: 14 }
                                        span { "Open in WhatsOnChain" }
                                    }
                                }
                            }
                        }
                    }
                    p { class: "history-when", "{row.status} · {when_str}" }
                }
            }

            div { class: "payment-details-amount",
                strong { "{primary}" }
                span { class: "payment-details-secondary", "{secondary}" }
            }

            dl { class: "payment-details-meta",
                dt { "Type" }
                dd { "{row.kind}" }

                dt { "Direction" }
                dd {
                    if spent { "Sent" } else if row.satoshis > 0 { "Received" } else { "Action" }
                }

                dt { "Status" }
                dd { "{row.status}" }

                dt { "Network" }
                dd { "{network_label}" }

                if let Some(ref cp) = row.counterparty {
                    dt { "Counterparty" }
                    dd { class: "mono", "{cp}" }
                }

                if let Some(ref origin) = row.app_origin {
                    dt { "App" }
                    dd { "{origin}" }
                }

                if let Some(ref txid) = row.txid {
                    {
                        let tx_copy = txid.clone();
                        rsx! {
                            dt { "Transaction" }
                            dd {
                                button {
                                    r#type: "button",
                                    class: "mono payment-tx-id is-link",
                                    title: "Copy TXID",
                                    onclick: move |_| match copy_to_clipboard(&tx_copy) {
                                        Ok(()) => toast.set(Some(ToastNotice {
                                            title: "TXID copied".into(),
                                            body: Some(truncate_mid(&tx_copy, 12)),
                                            tone: "success",
                                        })),
                                        Err(e) => toast.set(Some(ToastNotice {
                                            title: "Copy failed".into(),
                                            body: Some(e),
                                            tone: "error",
                                        })),
                                    },
                                    "{truncate_mid(txid, 14)}"
                                }
                            }
                        }
                    }
                }
            }

            if let Some(ref txid) = row.txid {
                {
                    let tx_copy = txid.clone();
                    rsx! {
                        div { class: "actions",
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| match copy_to_clipboard(&tx_copy) {
                                    Ok(()) => toast.set(Some(ToastNotice {
                                        title: "TXID copied".into(),
                                        body: Some(truncate_mid(&tx_copy, 12)),
                                        tone: "success",
                                    })),
                                    Err(e) => toast.set(Some(ToastNotice {
                                        title: "Copy failed".into(),
                                        body: Some(e),
                                        tone: "error",
                                    })),
                                },
                                CopyIcon { size: 15 }
                                button::Label { "Copy TXID" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// View model for [`WalletJobRow`] (`src/components/activity/ActivityJobRows.tsx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletJobView {
    pub id: String,
    pub kind: &'static str,
    pub face: &'static str,
    pub title: String,
    pub count: Option<String>,
    pub detail: Option<String>,
    pub progress_value: Option<u64>,
    pub progress_max: Option<u64>,
}

/// 1:1 port of `WalletJobRow` in `src/components/activity/ActivityJobRows.tsx`.
#[component]
pub fn WalletJobRow(
    job: WalletJobView,
    #[props(default)] on_open: Option<EventHandler<()>>,
) -> Element {
    let live = job.face == "running" || job.face == "waiting";
    let mut aria_parts = vec![job.title.clone()];
    if let Some(ref c) = job.count {
        aria_parts.push(c.clone());
    }
    if let Some(ref d) = job.detail {
        aria_parts.push(d.clone());
    }
    let aria_label = aria_parts.join(", ");
    let pct = match (job.progress_value, job.progress_max) {
        (Some(v), Some(m)) if m > 0 => ((v.min(m) as f64 / m as f64) * 100.0).round() as u32,
        _ => 0,
    };
    let indeterminate = job.progress_value.is_none();
    let is_heal = job.kind == "balance-heal";

    rsx! {
        li {
            "data-aeon-scope": "wallet-job",
            "data-aeon-state": job.face,
            "data-aeon-part": job.kind,
            "data-activity-key": "{job.id}",
            "data-activity-pending": if live { Some("") } else { None },
            button {
                r#type: "button",
                class: "history-row history-row-btn",
                aria_label: "{aria_label}",
                onclick: move |_| {
                    if let Some(cb) = on_open {
                        cb.call(());
                    }
                },
                div { class: "history-icon-wrap",
                    div { class: "history-icon",
                        span { class: "history-item-thumb-icon", aria_hidden: true,
                            if is_heal {
                                crate::icons::RefreshIcon { size: 18 }
                            } else {
                                crate::icons::CollectablesIcon { size: 18 }
                            }
                        }
                    }
                    if live {
                        span { class: "history-pending-mark", aria_hidden: true,
                            LoadingSpinner { size: "sm".to_string() }
                        }
                    }
                }
                div { class: "history-body history-progress-body",
                    strong { class: "history-title", "{job.title}" }
                    div { class: "history-progress-block",
                        div {
                            class: "history-progress",
                            role: "progressbar",
                            "data-aeon-scope": "progress",
                            "data-aeon-state": if indeterminate { "indeterminate" } else { "determinate" },
                            aria_valuenow: if indeterminate { None } else { Some(pct.to_string()) },
                            aria_valuemin: "0",
                            aria_valuemax: "100",
                            div { class: "history-progress-track",
                                div {
                                    class: "history-progress-range",
                                    style: if indeterminate { "width: 35%;".to_string() } else { format!("width: {pct}%;") },
                                }
                            }
                        }
                    }
                    if let Some(ref detail) = job.detail {
                        span { class: "history-when", title: "{detail}", "{detail}" }
                    }
                }
                if let Some(ref count) = job.count {
                    div { class: "history-amount-block",
                        span { class: "history-amount history-amount-item", "data-aeon-part": "count", "{count}" }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `PendingPhraseImportRow` in `src/components/activity/ActivityJobRows.tsx`.
#[component]
pub fn PendingPhraseImportRow(
    source_address: String,
    moved: u64,
    offset: u64,
    failed: u64,
    skipped: u64,
    stopped_for_funds: bool,
    #[props(default)] on_open: Option<EventHandler<()>>,
) -> Element {
    let mut parts = vec![format!("{moved} imported"), format!("{offset} scanned")];
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }
    if skipped > 0 {
        parts.push(format!("{skipped} skipped"));
    }
    let detail = parts.join(" · ");
    let status = if stopped_for_funds {
        "Paused — add BSV to continue"
    } else {
        "Paused — review details"
    };
    rsx! {
        li {
            "data-aeon-scope": "phrase-import",
            "data-aeon-state": "paused",
            "data-activity-key": "phrase-import:{source_address}",
            "data-activity-pending": "",
            button {
                r#type: "button",
                class: "history-row history-row-btn",
                aria_label: "Review paused collectable import, {detail}",
                onclick: move |_| {
                    if let Some(cb) = on_open {
                        cb.call(());
                    }
                },
                div { class: "history-icon-wrap",
                    div { class: "history-icon",
                        span { class: "history-item-thumb-icon", aria_hidden: true,
                            crate::icons::CollectablesIcon { size: 18 }
                        }
                    }
                    span { class: "history-pending-mark", aria_label: "Import paused", title: "Import paused safely",
                        LoadingSpinner { size: "sm".to_string() }
                    }
                }
                div { class: "history-body history-progress-body",
                    strong { class: "history-title", "Collectable import paused" }
                    span { class: "history-when", title: "{status}. {detail}", "{status} · {detail}" }
                }
                div { class: "history-amount-block",
                    span { class: "history-amount history-amount-item", "Review" }
                }
            }
        }
    }
}

/// Single-digit entry filter mirroring `pairingCodeMachine` (`src/components/activity/PairingCodeEntry.tsx`).
pub fn accept_single_pairing_digit(prev: &str, next: &str, max_len: usize) -> Option<String> {
    if next.len() + 1 == prev.len() && prev.starts_with(next) {
        return Some(next.to_string());
    }
    if next.len() == prev.len() + 1
        && next.len() <= max_len
        && next.starts_with(prev)
        && next.chars().last().is_some_and(|c| c.is_ascii_digit())
    {
        return Some(next.to_string());
    }
    None
}

/// 1:1 port of `src/components/activity/PairingCodeEntry.tsx` (BRC-249).
#[component]
pub fn PairingCodeEntry(
    label: String,
    length: usize,
    attempts_left: usize,
    #[props(default = "idle")] state: &'static str,
    #[props(default)] error: Option<String>,
    #[props(default)] on_complete: Option<EventHandler<String>>,
) -> Element {
    let pairing = use_aeon_machine_with::<PairingCodeMachine>(PairingCodeInput {
        length,
        attempts_left: attempts_left as u32,
    });
    let pairing_state = pairing.state();
    let pairing_ctx = pairing.context();
    let effective_state = if state == "idle" {
        match pairing_state {
            PairingCodeState::Entering => "idle",
            other => other.as_str(),
        }
    } else {
        state
    };
    let busy = effective_state == "verifying" || effective_state == "sending";
    let placeholder = "•".repeat(length);
    let cur_digits = pairing_ctx.digits;
    let shown_attempts = pairing_ctx.attempts_left as usize;
    let attempts_label = if shown_attempts == 1 {
        "1 attempt left".to_string()
    } else {
        format!("{shown_attempts} attempts left")
    };
    let shown_error = error.or(pairing_ctx.error);

    rsx! {
        div { "data-aeon-scope": "pairing-code", "data-aeon-state": effective_state,
            if effective_state == "approved" {
                p { class: "signin-note", role: "status", "{label} is signed in." }
            } else if effective_state == "ended" {
                p { class: "signin-error", role: "alert",
                    {shown_error.unwrap_or_else(|| format!("{label} was not signed in."))}
                }
            } else {
                p { class: "signin-note",
                    if effective_state == "sending" {
                        "Code accepted. Waiting for {label} to install and open its wallet…"
                    } else {
                        "Type the numbers shown on {label} to sign it in."
                    }
                }
                input {
                    class: "signin-code",
                    r#type: "text",
                    inputmode: "numeric",
                    pattern: "[0-9]*",
                    maxlength: "{length}",
                    autocomplete: "off",
                    spellcheck: "false",
                    name: "pairing-code-not-stored",
                    aria_label: "Code shown on {label}",
                    placeholder: "{placeholder}",
                    value: "{cur_digits}",
                    disabled: busy,
                    "data-aeon-part": "digits",
                    oninput: move |e| {
                        let before = pairing.state();
                        pairing.send(PairingCodeEvent::Type { value: e.value() });
                        if before == PairingCodeState::Entering
                            && pairing.state() == PairingCodeState::Verifying
                        {
                            if let Some(cb) = on_complete {
                                cb.call(pairing.context().digits);
                            }
                        }
                    },
                }
                if let Some(ref err) = shown_error {
                    p { class: "signin-error", role: "alert", "{err}" }
                }
                p { class: "signin-note", "data-aeon-part": "attempts", "{attempts_label}" }
            }
        }
    }
}

/// View model for [`SigninApprovalRows`] (`src/components/activity/SigninApprovalRows.tsx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigninApprovalView {
    pub key: String,
    pub face: &'static str,
    pub live: bool,
    pub title: String,
    pub detail: String,
    pub label: String,
    pub location: String,
    pub via_local: bool,
    pub code: Option<String>,
    pub pairing_length: Option<usize>,
    pub pairing_attempts: usize,
    pub requested_at: String,
    pub expires_at: String,
}

/// 1:1 port of `SigninApprovalRowItem` in `src/components/activity/SigninApprovalRows.tsx`.
#[component]
pub fn SigninApprovalRows(
    rows: Vec<SigninApprovalView>,
    #[props(default)] on_approve: Option<EventHandler<String>>,
    #[props(default)] on_refuse: Option<EventHandler<String>>,
) -> Element {
    rsx! {
        for row in rows {
            SigninApprovalRowItem {
                key: "{row.key}",
                row,
                on_approve,
                on_refuse,
            }
        }
    }
}

#[component]
pub fn SigninApprovalRowItem(
    row: SigninApprovalView,
    #[props(default)] on_approve: Option<EventHandler<String>>,
    #[props(default)] on_refuse: Option<EventHandler<String>>,
) -> Element {
    let default_open = row.face == "claimed" || row.face == "comparing";
    let mut expanded = use_signal(move || default_open);
    let is_open = *expanded.read();
    let loc_text = if row.via_local {
        "Your local network".to_string()
    } else if !row.location.is_empty() {
        format!("{} (approximate, from HandCash's server)", row.location)
    } else {
        "Unknown".to_string()
    };
    let key_approve = row.key.clone();
    let key_refuse = row.key.clone();

    rsx! {
        li {
            "data-aeon-scope": "signin-request",
            "data-aeon-state": row.face,
            "data-activity-key": "{row.key}",
            "data-activity-pending": if row.live { Some("") } else { None },
            button {
                r#type: "button",
                class: "history-row history-row-btn",
                aria_expanded: is_open,
                aria_label: "{row.title}, {row.detail}",
                onclick: move |_| expanded.set(!is_open),
                div { class: "history-icon-wrap",
                    div { class: "history-icon",
                        span { class: "history-item-thumb-icon", aria_hidden: true,
                            crate::icons::DevicesIcon { size: 18 }
                        }
                    }
                    if row.live {
                        span { class: "history-pending-mark", aria_hidden: true,
                            LoadingSpinner { size: "sm".to_string() }
                        }
                    }
                }
                div { class: "history-body",
                    strong { class: "history-title", "{row.title}" }
                    span { class: "history-when", "{row.detail}" }
                }
                div { class: "history-amount-block",
                    span { class: "history-when", "{row.requested_at}" }
                }
            }
            if is_open {
                div { class: "signin-detail", "data-aeon-part": "detail",
                    dl { class: "signin-facts",
                        dt { "Device" }
                        dd { "{row.label}" }
                        dt { "Location" }
                        dd { "{loc_text}" }
                        dt { "Requested" }
                        dd { "{row.requested_at}" }
                        if row.live {
                            dt { "Expires" }
                            dd { "{row.expires_at}" }
                        }
                    }
                    if row.face == "comparing" && row.live {
                        if let Some(len) = row.pairing_length {
                            PairingCodeEntry {
                                label: row.label.clone(),
                                length: len,
                                attempts_left: row.pairing_attempts,
                            }
                        } else if let Some(ref code) = row.code {
                            div { class: "signin-code-block",
                                span { class: "signin-code", "{code}" }
                                p { class: "signin-note", "Approve only if {row.label} shows this same code." }
                            }
                        }
                    }
                    if row.face == "claimed" {
                        p { class: "signin-note", "{row.detail}." }
                    }
                    if row.face == "waiting" {
                        p { class: "signin-note", "Getting the code from {row.label}." }
                    }
                    if row.live {
                        div { class: "signin-actions",
                            if row.face == "comparing" && row.pairing_length.is_none() {
                                button {
                                    r#type: "button",
                                    class: "btn btn-primary",
                                    tabindex: "-1",
                                    onclick: move |_| {
                                        if let Some(cb) = on_approve {
                                            cb.call(key_approve.clone());
                                        }
                                    },
                                    "Approve"
                                }
                            }
                            button {
                                r#type: "button",
                                class: "btn btn-ghost",
                                tabindex: "-1",
                                onclick: move |_| {
                                    if let Some(cb) = on_refuse {
                                        cb.call(key_refuse.clone());
                                    }
                                },
                                "Refuse"
                            }
                        }
                    }
                }
            }
        }
    }
}

/// View model for [`SwapActivityRow`] (`src/components/activity/SwapActivityRow.tsx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapActivityView {
    pub id: String,
    pub from_coin: String,
    pub to_coin: String,
    pub title: String,
    pub route_label: String,
    pub status: String,
    pub tone: &'static str,
    pub state: &'static str,
    pub amount: String,
    pub when: Option<String>,
}

/// 1:1 port of `src/components/activity/SwapActivityRow.tsx`.
#[component]
pub fn SwapActivityRow(
    swap: SwapActivityView,
    row_key: String,
    #[props(default)] newest: bool,
    #[props(default)] on_open: Option<EventHandler<String>>,
) -> Element {
    let moving = swap.tone == "moving";
    let refunding = moving && (swap.state == "locktime" || swap.state == "refunding");
    let ended = match swap.tone {
        "returned" => Some("Refunded"),
        "stopped" => Some("Stopped"),
        _ if refunding => Some("Refunding"),
        _ => None,
    };
    let subtitle = format!("{} · {}", swap.route_label, swap.status);
    let id_click = swap.id.clone();
    let amount_display = ended
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("+{}", swap.amount));
    rsx! {
        li {
            "data-activity-key": "{row_key}",
            "data-activity-newest": if newest { Some("") } else { None },
            "data-activity-pending": if moving { Some("") } else { None },
            "data-aeon-scope": "activity-row",
            "data-aeon-part": "swap",
            "data-aeon-state": swap.tone,
            button {
                r#type: "button",
                class: "history-row history-row-btn",
                onclick: move |_| {
                    if let Some(cb) = on_open {
                        cb.call(id_click.clone());
                    }
                },
                div { class: "history-icon-wrap",
                    span { class: "swap-pair-mark",
                        crate::icons::TickerCoinMark { coin: swap.from_coin.clone(), size: 18 }
                        crate::icons::TickerCoinMark { coin: swap.to_coin.clone(), size: 18 }
                    }
                    if moving {
                        span {
                            class: "history-pending-mark",
                            aria_live: "polite",
                            aria_label: "Swapping",
                            title: "Swapping",
                            LoadingSpinner { size: "sm".to_string() }
                        }
                    }
                }
                div { class: "history-body history-progress-body",
                    strong { class: "history-title", "{swap.title}" }
                    span { class: "history-when", title: "{subtitle}", "{subtitle}" }
                }
                div { class: "history-amount-block",
                    span {
                        class: if ended.is_some() { "history-amount history-amount-item" } else { "history-amount" },
                        title: "{swap.amount}",
                        "{amount_display}"
                    }
                    if let Some(ref w) = swap.when {
                        span { class: "history-when", "data-aeon-part": "row-state",
                            if moving && !refunding { "Swapping…" } else { "{w}" }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod activity_subcomponent_tests {
    use super::*;

    #[test]
    fn pairing_code_accepts_only_one_digit_or_backspace() {
        assert_eq!(accept_single_pairing_digit("", "4", 6), Some("4".into()));
        assert_eq!(accept_single_pairing_digit("4", "42", 6), Some("42".into()));
        assert_eq!(accept_single_pairing_digit("42", "4", 6), Some("4".into()));
        // Reject paste of multiple digits or non-digits
        assert_eq!(accept_single_pairing_digit("", "123456", 6), None);
        assert_eq!(accept_single_pairing_digit("4", "4a", 6), None);
        assert_eq!(accept_single_pairing_digit("123456", "1234567", 6), None);
    }
}
