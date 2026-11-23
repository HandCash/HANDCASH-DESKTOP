// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/DashboardSideColumn.tsx`, `src/components/WhatIsBsvPanel.tsx`,
//! and `src/components/TickerCoinSelector.tsx`.

use crate::icons::{BsvLogoMark, CheckIcon, ExpandMoreIcon, TickerCoinMark};
use crate::machines::{DisplayCurrency, FiatCode, MarketCoin, NavChild, NavSection, ToastNotice};
use crate::state::{
    format_bsv, format_coin_short, format_fiat_value, FxRates, HeldCoins, WalletSnapshot,
};
use crate::ui::activity::ActivityFeed;
use dioxus::prelude::*;

fn coin_about_copy(coin: MarketCoin) -> (&'static str, &'static str) {
    match coin {
        MarketCoin::Bsv => (
            "What is BSV?",
            "Bitcoin SV restores the original Bitcoin protocol for instant peer-to-peer electronic cash and on-chain data at scale.",
        ),
        MarketCoin::Ltc => (
            "What is LTC?",
            "Litecoin is a peer-to-peer cryptocurrency with fast 2.5-minute block confirmation times and low transaction fees.",
        ),
        MarketCoin::Bch => (
            "What is BCH?",
            "Bitcoin Cash scales on-chain block capacity for fast, low-fee peer-to-peer payments worldwide.",
        ),
        MarketCoin::Btc => (
            "What is BTC?",
            "Bitcoin is a decentralized digital currency secured by proof-of-work consensus.",
        ),
        MarketCoin::Doge => (
            "What is DOGE?",
            "Dogecoin is an open-source peer-to-peer digital currency featuring fast blocks and low fees.",
        ),
        MarketCoin::ArcUsd => (
            "What is USDC?",
            "USD Coin (Arc) is a digital dollar token redeemable 1:1 for US dollars.",
        ),
    }
}

fn coin_demo_stats(
    coin: MarketCoin,
    range: &str,
    bsv_usd: f64,
) -> (f64, &'static str, bool, &'static str) {
    match (coin, range) {
        (MarketCoin::Bsv, "7D") => (
            bsv_usd,
            "+6.8%",
            true,
            "M 0,58 L 40,52 L 80,49 L 120,44 L 160,36 L 200,29 L 240,22 L 280,14",
        ),
        (MarketCoin::Bsv, "1M") => (
            bsv_usd,
            "+14.2%",
            true,
            "M 0,62 L 40,56 L 80,51 L 120,46 L 160,39 L 200,31 L 240,20 L 280,12",
        ),
        (MarketCoin::Bsv, _) => (
            bsv_usd,
            "+2.4%",
            true,
            "M 0,54 L 35,48 L 70,50 L 105,38 L 140,41 L 175,28 L 210,32 L 245,18 L 280,14",
        ),
        (MarketCoin::Ltc, _) => (
            84.50,
            "+1.8%",
            true,
            "M 0,50 L 40,46 L 80,48 L 120,40 L 160,35 L 200,32 L 240,24 L 280,20",
        ),
        (MarketCoin::Bch, _) => (
            412.00,
            "+3.1%",
            true,
            "M 0,56 L 40,50 L 80,45 L 120,42 L 160,34 L 200,28 L 240,22 L 280,16",
        ),
        (MarketCoin::Btc, _) => (
            89400.00,
            "+1.2%",
            true,
            "M 0,48 L 40,45 L 80,42 L 120,44 L 160,36 L 200,30 L 240,26 L 280,22",
        ),
        (MarketCoin::Doge, _) => (
            0.28,
            "-0.9%",
            false,
            "M 0,22 L 40,26 L 80,28 L 120,34 L 160,38 L 200,44 L 240,48 L 280,52",
        ),
        (MarketCoin::ArcUsd, _) => (
            1.00,
            "0.0%",
            true,
            "M 0,36 L 40,36 L 80,36 L 120,36 L 160,36 L 200,36 L 240,36 L 280,36",
        ),
    }
}

/// 1:1 port of `src/components/DashboardSideColumn.tsx`.
#[component]
pub fn DashboardSideColumn(
    snap: WalletSnapshot,
    active_coin: Signal<MarketCoin>,
    currency: DisplayCurrency,
    fiat_code: FiatCode,
    fx_rates: FxRates,
    nav_section: Signal<NavSection>,
    nav_child: Signal<Option<NavChild>>,
    toast: Signal<Option<ToastNotice>>,
) -> Element {
    rsx! {
        aside {
            class: "dashboard-side",
            "data-aeon-scope": "dashboard-side",
            "data-aeon-state": "idle",
            WhatIsBsvPanel {
                active_coin,
                bsv_sats: snap.balance.displayed_sats,
                held: snap.held_coins,
                fiat_code,
                fx_rates: fx_rates.clone(),
                toast,
                compact: false,
            }
            ActivityFeed {
                snap,
                title: "Your activity",
                embedded: false,
                show_view_all: true,
                show_filters: false,
                currency,
                fiat_code,
                fx_rates,
                nav_section,
                nav_child,
            }
        }
    }
}

/// 1:1 port of `src/components/WhatIsBsvPanel.tsx` + attached `src/components/TickerCoinSelector.tsx`.
/// Supports both desktop (`compact = false`, `data-aeon-shell="wide"`) and mobile (`compact = true`, `data-aeon-shell="compact"`).
#[component]
pub fn WhatIsBsvPanel(
    mut active_coin: Signal<MarketCoin>,
    bsv_sats: u64,
    #[props(default)] held: HeldCoins,
    fiat_code: FiatCode,
    fx_rates: FxRates,
    mut toast: Signal<Option<ToastNotice>>,
    #[props(default = false)] compact: bool,
) -> Element {
    let mut about_open = use_signal(|| false);
    let mut choosing = use_signal(|| false);
    let mut chart_range = use_signal(|| "24h");

    let is_about = *about_open.read();
    let is_choosing = *choosing.read();
    let cur_range = *chart_range.read();
    let current_coin = *active_coin.read();
    let active_toast = toast.read().clone();

    let bsv_usd = fx_rates.rate_for(FiatCode::Usd).unwrap_or(48.20);
    let (coin_usd, pct_label, is_up, spark_path) =
        coin_demo_stats(current_coin, cur_range, bsv_usd);
    let fiat_mult = fx_rates
        .rate_for(fiat_code)
        .map(|r| r / bsv_usd.max(0.01))
        .unwrap_or(1.0);
    let price_label = if current_coin == MarketCoin::Bsv {
        fx_rates
            .format_price(fiat_code)
            .unwrap_or_else(|| format_fiat_value(coin_usd * fiat_mult, fiat_code))
    } else {
        format_fiat_value(coin_usd * fiat_mult, fiat_code)
    };

    let bsv_text = format_bsv(bsv_sats);
    let bsv_amount = bsv_text.trim_end_matches(" BSV").to_string();
    let bsv_fiat_held = fx_rates
        .format_sats(bsv_sats, fiat_code)
        .unwrap_or_else(|| format_fiat_value(0.0, fiat_code));

    let (about_title, about_body) = coin_about_copy(current_coin);

    let state_attr = if let Some(ref t) = active_toast {
        if t.tone == "error" {
            "toast-error"
        } else {
            "toast-success"
        }
    } else if is_choosing {
        "choosing"
    } else {
        "idle"
    };

    let shell_attr = if compact { "compact" } else { "wide" };

    rsx! {
        aside {
            class: if compact { "panel what-is-bsv what-is-bsv--compact" } else { "panel what-is-bsv" },
            "data-aeon-scope": "what-is-bsv",
            "data-aeon-shell": shell_attr,
            "data-aeon-state": state_attr,

            if is_choosing {
                div {
                    class: "ticker-coins-panel",
                    "data-aeon-scope": "ticker-coins",
                    ul {
                        class: "ticker-coins-list",
                        "data-aeon-part": "list",
                        role: "listbox",
                        aria_label: "Choose coin",
                        for coin in MarketCoin::ALL {
                            {
                                let selected = coin == current_coin;
                                let held_desc = if coin == MarketCoin::Bsv {
                                    format!("{} {} · {}", bsv_amount, coin.code(), bsv_fiat_held)
                                } else {
                                    // No local price feed for other coins: show the held
                                    // amount only (TS `heldIn` omits fiat without a price).
                                    match held.units(coin).filter(|u| *u > 0) {
                                        Some(u) => format!("{} {}", format_coin_short(u, 8), coin.code()),
                                        None => coin.code().to_string(),
                                    }
                                };
                                rsx! {
                                    li { key: "{coin.as_str()}",
                                        button {
                                            r#type: "button",
                                            role: "option",
                                            aria_selected: selected,
                                            "data-aeon-part": "coin",
                                            "data-aeon-state": if selected { "selected" } else { "idle" },
                                            onclick: move |_| {
                                                active_coin.set(coin);
                                                choosing.set(false);
                                            },
                                            span { class: "ticker-coin-option-mark", aria_hidden: true,
                                                if coin == MarketCoin::Bsv {
                                                    BsvLogoMark { size: 28 }
                                                } else {
                                                    TickerCoinMark { coin: coin.as_str(), size: 28 }
                                                }
                                            }
                                            span { "data-aeon-part": "copy",
                                                strong { "data-aeon-part": "label", "{coin.name()}" }
                                                span { "data-aeon-part": "description", "{held_desc}" }
                                            }
                                            if selected {
                                                CheckIcon { size: 16, class: "wallet-account-option-check" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if compact {
                // ── Mobile / Compact horizontal ticker bar (`data-aeon-shell="compact"`) ──
                div { class: "bsv-carousel-frame",
                    div { class: "bsv-carousel", role: "region", aria_label: "Coin prices",
                        div {
                            class: "bsv-market-body bsv-slide bsv-slide--compact",
                            "data-coin": current_coin.as_str(),
                            onclick: move |_| choosing.set(true),

                            div { class: "bsv-asset-row",
                                button {
                                    r#type: "button",
                                    "data-aeon-part": "coin-trigger",
                                    aria_haspopup: "listbox",
                                    title: "Choose the coin shown here",
                                    onclick: move |evt| {
                                        evt.stop_propagation();
                                        choosing.set(true);
                                    },
                                }
                                span { class: "bsv-logo-btn", aria_hidden: true,
                                    if current_coin == MarketCoin::Bsv {
                                        span { class: "bsv-logo-stack",
                                            BsvLogoMark { size: 32 }
                                        }
                                    } else {
                                        TickerCoinMark { coin: current_coin.as_str(), size: 32 }
                                    }
                                }
                                div { class: "bsv-asset-text",
                                    span { "data-aeon-part": "coin-name",
                                        strong { "{current_coin.name()}" }
                                        span { "data-aeon-part": "caret", aria_hidden: true,
                                            ExpandMoreIcon { size: 16 }
                                        }
                                    }
                                }
                            }

                            svg {
                                class: if is_up { "bsv-spark bsv-spark-up bsv-spark--compact" } else { "bsv-spark bsv-spark-down bsv-spark--compact" },
                                view_box: "0 0 280 72",
                                preserve_aspect_ratio: "none",
                                path {
                                    d: "{spark_path}",
                                    fill: "none",
                                    stroke: "currentColor",
                                    stroke_width: "3",
                                    stroke_linecap: "round",
                                    stroke_linejoin: "round",
                                }
                            }

                            div { class: "bsv-compact-quote",
                                strong { class: "bsv-price", "{price_label}" }
                                button {
                                    r#type: "button",
                                    class: if is_up { "bsv-change is-up" } else { "bsv-change is-down" },
                                    title: "Click to cycle 24h → 7D → 1M",
                                    onclick: move |evt| {
                                        evt.stop_propagation();
                                        let next = match *chart_range.read() {
                                            "24h" => "7D",
                                            "7D" => "1M",
                                            _ => "24h",
                                        };
                                        chart_range.set(next);
                                    },
                                    "{pct_label} · {cur_range}"
                                }
                            }
                        }
                    }
                    div { class: "bsv-carousel-dots", "data-aeon-part": "dots",
                        for coin in MarketCoin::ALL {
                            button {
                                key: "{coin.as_str()}",
                                r#type: "button",
                                aria_label: "Show {coin.name()}",
                                aria_current: if coin == current_coin { Some("true") } else { None },
                                onclick: move |evt| {
                                    evt.stop_propagation();
                                    active_coin.set(coin);
                                },
                            }
                        }
                    }
                }
            } else {
                // ── Desktop ticker card (`data-aeon-shell="wide"`) ──
                div { class: "bsv-carousel-frame",
                    div { class: "bsv-carousel", role: "region", aria_label: "Coin prices",
                        div { class: "bsv-market-body bsv-slide", "data-coin": current_coin.as_str(),
                            div { class: "bsv-asset-row",
                                button {
                                    r#type: "button",
                                    "data-aeon-part": "coin-trigger",
                                    aria_haspopup: "listbox",
                                    aria_label: "{current_coin.name()}. Choose the coin shown here",
                                    title: "Choose the coin shown here",
                                    onclick: move |_| choosing.set(true),
                                }
                                span { class: "bsv-logo-btn", aria_hidden: true,
                                    if current_coin == MarketCoin::Bsv {
                                        span { class: "bsv-logo-stack",
                                            BsvLogoMark { size: 32 }
                                        }
                                    } else {
                                        TickerCoinMark { coin: current_coin.as_str(), size: 32 }
                                    }
                                }
                                div { class: "bsv-asset-text",
                                    span { "data-aeon-part": "coin-name",
                                        strong { "{current_coin.name()}" }
                                        span { "data-aeon-part": "caret", aria_hidden: true,
                                            ExpandMoreIcon { size: 16 }
                                        }
                                    }
                                }
                            }

                            strong { class: "bsv-price", "{price_label}" }

                            div {
                                class: "bsv-stage",
                                "data-aeon-part": "stage",
                                "data-aeon-state": if is_about { "about" } else { "chart" },
                                div { class: "bsv-stage-panel bsv-stage-chart", aria_hidden: is_about,
                                    button {
                                        r#type: "button",
                                        class: if is_up { "bsv-change is-up" } else { "bsv-change is-down" },
                                        title: "Click to cycle 24h → 7D → 1M",
                                        onclick: move |_| {
                                            let next = match *chart_range.read() {
                                                "24h" => "7D",
                                                "7D" => "1M",
                                                _ => "24h",
                                            };
                                            chart_range.set(next);
                                        },
                                        "{pct_label} · {cur_range}"
                                    }
                                    svg {
                                        class: if is_up { "bsv-spark bsv-spark-up" } else { "bsv-spark bsv-spark-down" },
                                        view_box: "0 0 280 72",
                                        preserve_aspect_ratio: "none",
                                        path {
                                            d: "{spark_path}",
                                            fill: "none",
                                            stroke: "currentColor",
                                            stroke_width: "2.5",
                                            stroke_linecap: "round",
                                            stroke_linejoin: "round",
                                        }
                                    }
                                }
                                div { class: "bsv-stage-panel bsv-stage-about", aria_hidden: !is_about,
                                    p { class: "what-is-bsv-lede", "{about_body}" }
                                }
                            }

                            div { class: "bsv-about",
                                div { class: if is_about { "bsv-about-item is-open" } else { "bsv-about-item" },
                                    button {
                                        r#type: "button",
                                        class: if is_about { "bsv-about-trigger is-open" } else { "bsv-about-trigger" },
                                        onclick: move |_| about_open.set(!is_about),
                                        "{about_title}"
                                        span { class: "bsv-about-indicator",
                                            ExpandMoreIcon { size: 18 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    div { class: "bsv-carousel-dots", "data-aeon-part": "dots",
                        for coin in MarketCoin::ALL {
                            button {
                                key: "{coin.as_str()}",
                                r#type: "button",
                                aria_label: "Show {coin.name()}",
                                aria_current: if coin == current_coin { Some("true") } else { None },
                                onclick: move |_| active_coin.set(coin),
                            }
                        }
                    }
                }
            }

            if let Some(t) = active_toast {
                button {
                    r#type: "button",
                    class: "bsv-toast-cover",
                    "data-aeon-part": "toast-cover",
                    "data-tone": t.tone,
                    title: "Dismiss",
                    onclick: move |_| toast.set(None),
                    strong { class: "bsv-toast-title", "{t.title}" }
                    if let Some(b) = t.body {
                        span { class: "bsv-toast-body", "{b}" }
                    }
                }
            }
        }
    }
}
