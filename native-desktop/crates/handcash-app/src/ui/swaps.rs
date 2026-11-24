// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Phase 8 Swaps & Multi-Chain Coins UI components.
//! 1:1 port of:
//! - `src/components/SwapVisuals.tsx`
//! - `src/components/CoinDepositProgress.tsx`
//! - `src/components/CoinDepositDetails.tsx`
//! - `src/components/NetworkPicker.tsx`
//! - `src/components/SwapOffersPanel.tsx`
//! - `src/components/SwapDetailPanel.tsx`

use crate::icons::{CheckIcon, CoinGlyphIcon, FriendsIcon, SwapIcon, TickerCoinMark};
use crate::ui::EmptyState;
use aeon_ui::{button, select, status_banner};
use dioxus::prelude::*;

pub fn swap_asset_ticker(asset: &str) -> &'static str {
    match asset {
        "bsv" => "BSV",
        "ltc" => "LTC",
        "bch" => "BCH",
        "btc" => "BTC",
        "arc-usd" | "usdc" => "USDC",
        _ => "COIN",
    }
}

pub fn swap_asset_label(asset: &str) -> &'static str {
    match asset {
        "bsv" => "Bitcoin SV",
        "ltc" => "Litecoin",
        "bch" => "Bitcoin Cash",
        "btc" => "Bitcoin",
        "arc-usd" | "usdc" => "Arc USD",
        _ => "Coin",
    }
}

pub fn swap_tone_label(tone: &str) -> &'static str {
    match tone {
        "done" => "Swapped",
        "moving" => "In progress",
        "refunded" => "Refunded",
        "stopped" | "failed" => "Stopped",
        _ => "Pending",
    }
}

/// 1:1 port of `SwapPairMark` in `src/components/SwapVisuals.tsx`.
#[component]
pub fn SwapPairMark(
    from: String,
    to: String,
    #[props(default = 26)] size: u32,
) -> Element {
    let style = format!("--swap-pair-size: {size}px;");
    rsx! {
        span { "data-aeon-scope": "swap-pair", style: "{style}", aria_hidden: "true",
            span { "data-aeon-part": "coin", TickerCoinMark { coin: from, size } }
            span { "data-aeon-part": "coin", TickerCoinMark { coin: to, size } }
        }
    }
}

/// One leg for `SwapSummary`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapSummaryLeg {
    pub asset: String,
    pub amount: String,
    pub caption: String,
}

/// 1:1 port of `SwapSummary` in `src/components/SwapVisuals.tsx`.
#[component]
pub fn SwapSummary(pay: SwapSummaryLeg, receive: SwapSummaryLeg) -> Element {
    rsx! {
        div { "data-aeon-scope": "swap-summary",
            div { "data-aeon-part": "leg",
                TickerCoinMark { coin: pay.asset.clone(), size: 36 }
                span { "data-aeon-part": "caption", "{pay.caption}" }
                span { "data-aeon-part": "amount", "{pay.amount}" }
                span { "data-aeon-part": "ticker", "{swap_asset_ticker(&pay.asset)}" }
            }
            span { "data-aeon-part": "arrow", aria_hidden: "true",
                SwapIcon { size: 16 }
            }
            div { "data-aeon-part": "leg",
                TickerCoinMark { coin: receive.asset.clone(), size: 36 }
                span { "data-aeon-part": "caption", "{receive.caption}" }
                span { "data-aeon-part": "amount", "{receive.amount}" }
                span { "data-aeon-part": "ticker", "{swap_asset_ticker(&receive.asset)}" }
            }
        }
    }
}

/// 1:1 port of `SwapRouteBadge` in `src/components/SwapVisuals.tsx`.
#[component]
pub fn SwapRouteBadge(kind: String) -> Element {
    rsx! {
        span { "data-aeon-scope": "swap-route-badge", "data-route": "{kind}", aria_hidden: "true",
            if kind == "direct" {
                FriendsIcon { size: 18 }
            } else {
                SwapIcon { size: 18 }
            }
        }
    }
}

/// 1:1 port of `SwapStatusPill` in `src/components/SwapVisuals.tsx`.
#[component]
pub fn SwapStatusPill(tone: String) -> Element {
    rsx! {
        span { "data-aeon-scope": "swap-status", "data-tone": "{tone}",
            "{swap_tone_label(&tone)}"
        }
    }
}

/// 1:1 port of `depositShortCount` in `src/components/CoinDepositProgress.tsx`.
pub fn deposit_short_count(phase_kind: &str, counted: u32, needed: u32) -> Option<String> {
    if phase_kind == "movable" {
        return None;
    }
    Some(format!("{counted}/{needed}"))
}

/// 1:1 port of `ConfirmationBadge` in `src/components/CoinDepositProgress.tsx`.
#[component]
pub fn ConfirmationBadge(
    chain: String,
    state: String,
    counted: u32,
    needed: u32,
    label: String,
    #[props(default)] title: Option<String>,
) -> Element {
    let tip = title.unwrap_or_else(|| label.clone());
    let many = if needed > 10 { Some("") } else { None };
    rsx! {
        span {
            "data-aeon-scope": "coin-deposit",
            "data-aeon-state": "{state}",
            "data-aeon-part": "badge",
            "data-chain": "{chain}",
            span {
                "data-aeon-part": "pips",
                "data-aeon-state": "{state}",
                "data-many": many,
                role: "img",
                aria_label: "{label}",
                title: "{tip}",
                for i in 0..needed {
                    span {
                        key: "{i}",
                        "data-aeon-part": "pip",
                        "data-aeon-state": if i < counted { "counted" } else { "open" },
                    }
                }
            }
            if counted < needed {
                span { "data-aeon-part": "count", "{counted}/{needed}" }
            }
        }
    }
}

/// 1:1 port of `CoinDepositProgress` in `src/components/CoinDepositProgress.tsx`.
#[component]
pub fn CoinDepositProgress(
    chain: String,
    phase_kind: String,
    counted: u32,
    needed: u32,
    status_copy: String,
    source_copy: String,
    #[props(default)] amount_display: Option<String>,
    #[props(default)] estimate: Option<String>,
    #[props(default = true)] show_amount: bool,
) -> Element {
    rsx! {
        div {
            "data-aeon-scope": "coin-deposit",
            "data-aeon-state": "{phase_kind}",
            "data-aeon-part": "progress",
            "data-chain": "{chain}",
            div { "data-aeon-part": "headline",
                if show_amount {
                    if let Some(amt) = amount_display {
                        strong { "data-aeon-part": "amount", "{amt} {swap_asset_ticker(&chain)}" }
                    }
                }
                ConfirmationBadge {
                    chain: chain.clone(),
                    state: phase_kind.clone(),
                    counted,
                    needed,
                    label: status_copy.clone(),
                    title: Some(format!("{status_copy}\n{source_copy}")),
                }
            }
            p { "data-aeon-part": "status", "{status_copy}" }
            p { "data-aeon-part": "source", "{source_copy}" }
            if let Some(est) = estimate {
                p { "data-aeon-part": "estimate", "{est}" }
            }
        }
    }
}

/// 1:1 port of `src/components/CoinDepositDetails.tsx`.
#[component]
pub fn CoinDepositDetails(
    chain: String,
    title: String,
    when_label: String,
    #[props(default)] txid: Option<String>,
    #[props(default)] vout: Option<u32>,
    #[props(default)] amount_display: Option<String>,
    #[props(default)] block_height: Option<u64>,
    #[props(default)] counted: u32,
    #[props(default = 6)] needed: u32,
) -> Element {
    let net_label = swap_asset_label(&chain);
    let ticker = swap_asset_ticker(&chain);
    let short_tx = txid.as_deref().map(|t| {
        if t.len() > 18 {
            format!("{}…{}", &t[..10], &t[t.len() - 6..])
        } else {
            t.to_string()
        }
    });
    rsx! {
        div {
            class: "nav-child-panel payment-details",
            "data-aeon-scope": "payment-details",
            "data-aeon-state": "coin-deposit",
            "data-chain": "{chain}",
            div { class: "payment-details-hero",
                div { class: "history-icon-wrap",
                    div { class: "history-icon", TickerCoinMark { coin: chain.clone(), size: 20 } }
                }
                div { class: "payment-details-copy",
                    div { class: "payment-details-title-row",
                        strong { class: "payment-details-title", "{title}" }
                    }
                    p { class: "history-when", "{when_label}" }
                }
            }
            if txid.is_some() {
                div { class: "app-details-section",
                    CoinDepositProgress {
                        chain: chain.clone(),
                        phase_kind: (if counted >= needed { "movable" } else { "confirming" }).to_string(),
                        counted,
                        needed,
                        status_copy: format!("{counted} of {needed} confirmations"),
                        source_copy: format!("{net_label} header chain"),
                        show_amount: false,
                    }
                }
            }
            div { class: "app-details-section",
                dl { class: "wallet-details",
                    if txid.is_none() {
                        div { class: "wallet-detail",
                            span { "Status" }
                            span { class: "wallet-detail-value", "Not tracked on this device" }
                        }
                    }
                    if let Some(amt) = amount_display {
                        div { class: "wallet-detail",
                            span { "Amount" }
                            span { class: "wallet-detail-value", "{amt} {ticker}" }
                        }
                    }
                    if let Some(stx) = short_tx {
                        div { class: "wallet-detail",
                            span { "{net_label} transaction" }
                            span { class: "wallet-detail-value mono", "{stx}:{vout.unwrap_or(0)}" }
                        }
                    }
                    div { class: "wallet-detail",
                        span { "Network" }
                        span { class: "wallet-detail-value", "{net_label}" }
                    }
                    if let Some(h) = block_height {
                        div { class: "wallet-detail",
                            span { "{net_label} block" }
                            span { class: "wallet-detail-value", "{h}" }
                        }
                    }
                }
            }
        }
    }
}

/// Network option for `NetworkPicker`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkAssetOption {
    pub value: String,
    pub name: String,
    pub sym: String,
    pub detail: Option<String>,
    pub disabled: bool,
}

pub fn default_network_options() -> Vec<NetworkAssetOption> {
    vec![
        NetworkAssetOption { value: "bsv".into(), name: "Bitcoin SV".into(), sym: "BSV".into(), detail: None, disabled: false },
        NetworkAssetOption { value: "ltc".into(), name: "Litecoin".into(), sym: "LTC".into(), detail: Some("Multi-chain pending".into()), disabled: true },
        NetworkAssetOption { value: "bch".into(), name: "Bitcoin Cash".into(), sym: "BCH".into(), detail: Some("Multi-chain pending".into()), disabled: true },
    ]
}

/// 1:1 port of `src/components/NetworkPicker.tsx`.
#[component]
pub fn NetworkPicker(
    value: String,
    on_change: EventHandler<String>,
    #[props(default)] options: Option<Vec<NetworkAssetOption>>,
    #[props(default = "Network".to_string())] label: String,
    #[props(default)] disabled: bool,
) -> Element {
    let opts = options.unwrap_or_else(default_network_options);
    let current = opts.iter().find(|o| o.value == value).or_else(|| opts.first()).cloned();
    rsx! {
        div { "data-aeon-scope": "network-picker", "data-aeon-state": "{value}",
            span { "data-aeon-part": "label", "{label}" }
            select::Root {
                value: Some(value.clone()),
                on_value_change: move |next: String| on_change.call(next),
                select::Trigger {
                    aria_disabled: if disabled { "true" } else { "false" },
                    if let Some(cur) = current {
                        span { "data-network-part": "mark", aria_hidden: "true", TickerCoinMark { coin: cur.value.clone(), size: 22 } }
                        span { "data-network-part": "name", "{cur.name}" }
                        span { "data-network-part": "sym", "{cur.sym}" }
                    }
                }
                select::Content {
                    for opt in opts {
                        select::Item { key: "{opt.value}", value: opt.value.clone(), disabled: opt.disabled,
                            span { "data-network-part": "mark", aria_hidden: "true", TickerCoinMark { coin: opt.value.clone(), size: 22 } }
                            span { "data-network-part": "name", "{opt.name}" }
                            if let Some(det) = opt.detail {
                                span { "data-network-part": "detail", "{det}" }
                            }
                            span { "data-network-part": "sym", "{opt.sym}" }
                        }
                    }
                }
            }
        }
    }
}

/// Direct swap offer row for `SwapOffersPanel`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapOfferView {
    pub id: String,
    pub from_asset: String,
    pub to_asset: String,
    pub pay_amount: String,
    pub receive_amount: String,
    pub maker_label: String,
}

/// 1:1 port of `src/components/SwapOffersPanel.tsx`.
/// Swap engine is not ported to Rust yet — offers render honestly with `data-aeon-state="unavailable"`.
#[component]
pub fn SwapOffersPanel(
    #[props(default)] offers: Vec<SwapOfferView>,
    #[props(default = true)] swap_gated: bool,
    #[props(default)] on_done: Option<EventHandler<()>>,
) -> Element {
    let mut selected_id = use_signal(|| Option::<String>::None);
    let chosen = selected_id
        .read()
        .as_deref()
        .and_then(|id| offers.iter().find(|o| o.id == id).cloned());

    if let Some(offer) = chosen {
        return rsx! {
            section {
                class: "nav-child-panel",
                "data-aeon-scope": "swap-offers",
                "data-aeon-state": if swap_gated { "unavailable" } else { "confirming" },
                SwapSummary {
                    pay: SwapSummaryLeg { asset: offer.from_asset.clone(), amount: offer.pay_amount.clone(), caption: "You pay".into() },
                    receive: SwapSummaryLeg { asset: offer.to_asset.clone(), amount: offer.receive_amount.clone(), caption: "You get".into() },
                }
                status_banner::Root { tone: status_banner::StatusTone::Info, status: Some("trustless".to_string()),
                    status_banner::Copy {
                        status_banner::Title { "Both sides complete, or both are refunded" }
                        status_banner::Body { "Coins are locked on their own chains, never held by anyone." }
                    }
                }
                if swap_gated {
                    p { class: "settings-row-desc", "Direct swaps are not enabled in this native build yet." }
                }
                div { class: "actions",
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| selected_id.set(None),
                        button::Label { "Back" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        disabled: swap_gated,
                        onclick: move |_| {
                            if let Some(cb) = on_done { cb.call(()); }
                        },
                        button::Label { "Confirm swap" }
                    }
                }
            }
        };
    }

    rsx! {
        section {
            class: "nav-child-panel",
            "data-aeon-scope": "swap-offers",
            "data-aeon-state": if swap_gated { "unavailable" } else { "listing" },
            if offers.is_empty() {
                EmptyState {
                    icon: rsx! { SwapIcon { size: 28 } },
                    title: "No direct swap offers".to_string(),
                    body: Some(if swap_gated {
                        "Direct multi-chain swaps are not enabled in this native build yet."
                    } else {
                        "No open peer offers match right now."
                    }.to_string()),
                }
            } else {
                ul { class: "settings-list",
                    for offer in offers {
                        {
                            let id = offer.id.clone();
                            rsx! {
                                li { key: "{offer.id}",
                                    button {
                                        r#type: "button",
                                        class: "settings-row",
                                        onclick: move |_| selected_id.set(Some(id.clone())),
                                        SwapPairMark { from: offer.from_asset.clone(), to: offer.to_asset.clone(), size: 22 }
                                        div { class: "settings-row-copy",
                                            strong { "{offer.pay_amount} {swap_asset_ticker(&offer.from_asset)} → {offer.receive_amount} {swap_asset_ticker(&offer.to_asset)}" }
                                            span { class: "settings-row-desc", "{offer.maker_label}" }
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

/// Direct swap detail view model for `SwapDetailPanel`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapDetailView {
    pub id: String,
    pub title: String,
    pub route: String,
    pub tone: String,
    pub status: String,
    pub created_label: String,
    pub from_asset: String,
    pub to_asset: String,
    pub pay_amount: String,
    pub receive_amount: String,
    pub steps: Vec<(String, String, String, Option<String>)>,
}

/// 1:1 port of `src/components/SwapDetailPanel.tsx`.
#[component]
pub fn SwapDetailPanel(
    #[props(default)] view: Option<SwapDetailView>,
    #[props(default)] on_swap_again: Option<EventHandler<()>>,
) -> Element {
    let Some(v) = view else {
        return rsx! {
            div { class: "nav-child-panel", "data-aeon-scope": "swap-detail", "data-aeon-state": "missing",
                EmptyState {
                    icon: rsx! { SwapIcon { size: 28 } },
                    title: "Swap not found".to_string(),
                    body: Some("This swap is not recorded on this device.".to_string()),
                }
            }
        };
    };
    let route_label = if v.route == "direct" { "Wallet to wallet" } else { "Exolix" };
    rsx! {
        div {
            class: "nav-child-panel payment-details",
            "data-aeon-scope": "swap-detail",
            "data-aeon-state": "{v.tone}",
            "data-route": "{v.route}",
            div { class: "payment-details-hero",
                div { class: "history-icon-wrap",
                    SwapPairMark { from: v.from_asset.clone(), to: v.to_asset.clone(), size: 22 }
                }
                div { class: "payment-details-copy",
                    div { class: "payment-details-title-row",
                        strong { class: "payment-details-title", "{v.title}" }
                        SwapStatusPill { tone: v.tone.clone() }
                    }
                    p { class: "history-when", "{v.created_label}" }
                }
            }
            div { class: "app-details-section",
                SwapSummary {
                    pay: SwapSummaryLeg { asset: v.from_asset.clone(), amount: v.pay_amount.clone(), caption: "You pay".into() },
                    receive: SwapSummaryLeg { asset: v.to_asset.clone(), amount: v.receive_amount.clone(), caption: "You get".into() },
                }
            }
            if !v.steps.is_empty() {
                ol { class: "app-details-section", "data-aeon-scope": "swap-steps",
                    for (key, label, st, tx) in v.steps.iter() {
                        li { key: "{key}", "data-aeon-state": "{st}",
                            span { "data-aeon-part": "marker", aria_hidden: "true",
                                if st == "done" {
                                    CheckIcon { size: 14 }
                                } else {
                                    CoinGlyphIcon { size: 16 }
                                }
                            }
                            span { "data-aeon-part": "label", "{label}" }
                            if let Some(txid) = tx {
                                span { class: "payment-details-woc mono", "{txid}" }
                            }
                        }
                    }
                }
            }
            div { class: "app-details-section",
                dl { class: "wallet-details",
                    div { class: "wallet-detail",
                        span { "Status" }
                        span { class: "wallet-detail-value", "{v.status}" }
                    }
                    div { class: "wallet-detail",
                        span { "Route" }
                        span { class: "wallet-detail-value", "data-aeon-part": "route",
                            SwapRouteBadge { kind: v.route.clone() }
                            "{route_label}"
                        }
                    }
                }
            }
            button::Root {
                variant: button::ButtonVariant::Ghost,
                class: "btn btn-ghost",
                onclick: move |_| {
                    if let Some(cb) = on_swap_again { cb.call(()); }
                },
                button::Label { "Swap again" }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_helpers_and_deposit_count_match_ts() {
        assert_eq!(swap_asset_ticker("bsv"), "BSV");
        assert_eq!(swap_asset_ticker("ltc"), "LTC");
        assert_eq!(swap_tone_label("done"), "Swapped");
        assert_eq!(swap_tone_label("moving"), "In progress");
        assert_eq!(deposit_short_count("movable", 6, 6), None);
        assert_eq!(deposit_short_count("confirming", 3, 6), Some("3/6".to_string()));
    }
}
