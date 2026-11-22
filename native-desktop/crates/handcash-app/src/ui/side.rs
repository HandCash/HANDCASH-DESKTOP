// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/DashboardSideColumn.tsx` and `src/components/WhatIsBsvPanel.tsx`.

use crate::icons::{BsvLogoMark, ExpandMoreIcon};
use crate::machines::{DisplayCurrency, FiatCode, NavChild, NavSection, ToastNotice};
use crate::state::{FxRates, WalletSnapshot};
use crate::ui::activity::ActivityFeed;
use dioxus::prelude::*;

/// 1:1 port of `src/components/DashboardSideColumn.tsx`.
#[component]
pub fn DashboardSideColumn(
    snap: WalletSnapshot,
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
                fiat_code,
                fx_rates: fx_rates.clone(),
                toast,
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

/// 1:1 port of `src/components/WhatIsBsvPanel.tsx`.
#[component]
pub fn WhatIsBsvPanel(
    fiat_code: FiatCode,
    fx_rates: FxRates,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let mut about_open = use_signal(|| false);
    let is_about = *about_open.read();
    let active_toast = toast.read().clone();
    let showing_toast = active_toast.is_some();
    let price_label = fx_rates
        .format_price(fiat_code)
        .unwrap_or_else(|| "BSV".to_string());

    let state_attr = if let Some(ref t) = active_toast {
        if t.tone == "error" {
            "toast-error"
        } else {
            "toast-success"
        }
    } else {
        "idle"
    };

    rsx! {
        aside {
            class: "panel what-is-bsv",
            "data-aeon-scope": "what-is-bsv",
            "data-aeon-shell": "wide",
            "data-aeon-state": state_attr,

            div { class: "bsv-carousel-frame",
                div { class: "bsv-carousel", role: "region", aria_label: "Coin prices",
                    div { class: "bsv-market-body bsv-slide", "data-coin": "bsv",
                        div { class: "bsv-asset-row",
                            span { class: "bsv-logo-btn",
                                span { class: "bsv-logo-stack",
                                    BsvLogoMark { size: 32 }
                                }
                            }
                            div { class: "bsv-asset-text",
                                span { "data-aeon-part": "coin-name",
                                    strong { "Bitcoin SV" }
                                    span { "data-aeon-part": "caret",
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
                            div { class: "bsv-stage-panel bsv-stage-chart",
                                span { class: "bsv-change is-up", "Native · BRC-100" }
                                svg {
                                    class: "bsv-spark bsv-spark-up",
                                    view_box: "0 0 280 72",
                                    preserve_aspect_ratio: "none",
                                    path {
                                        d: "M 0,54 L 35,48 L 70,50 L 105,38 L 140,41 L 175,28 L 210,32 L 245,18 L 280,14",
                                        fill: "none",
                                        stroke: "currentColor",
                                        stroke_width: "2.5",
                                        stroke_linecap: "round",
                                        stroke_linejoin: "round",
                                    }
                                }
                            }
                            div { class: "bsv-stage-panel bsv-stage-about",
                                p { class: "what-is-bsv-lede",
                                    "Bitcoin SV restores the original Bitcoin protocol for instant peer-to-peer electronic cash and on-chain data at scale."
                                }
                            }
                        }

                        div { class: "bsv-about",
                            div { class: if is_about { "bsv-about-item is-open" } else { "bsv-about-item" },
                                button {
                                    r#type: "button",
                                    class: if is_about { "bsv-about-trigger is-open" } else { "bsv-about-trigger" },
                                    onclick: move |_| about_open.set(!is_about),
                                    "What is BSV?"
                                    span { class: "bsv-about-indicator",
                                        ExpandMoreIcon { size: 18 }
                                    }
                                }
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

            if showing_toast {
                // Keeps toast cover interactive above carousel
            }
        }
    }
}
