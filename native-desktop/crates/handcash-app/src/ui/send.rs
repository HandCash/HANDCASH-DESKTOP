// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/SendPanel.tsx` (`editing.destination` → `editing.amount` → `confirming` / `failure`),
//! with CTAs baked directly into the `WalletNav` action bar via `WalletActionBarNav`.

use crate::machines::{
    classify_recipient, NavChild, RecipientKind, SendStage, SendUnit, ToastNotice,
};
use crate::state::{format_bsv, AppServices, WalletSnapshot};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use dioxus::prelude::*;
use std::sync::Arc;

fn parse_amount_to_sats(raw: &str, unit: SendUnit) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    match unit {
        SendUnit::Sats => trimmed.parse::<u64>().ok().filter(|&v| v > 0),
        SendUnit::Bsv => {
            let v = trimmed.parse::<f64>().ok()?;
            if !v.is_finite() || v <= 0.0 {
                return None;
            }
            let sats = (v * 100_000_000.0).round();
            if sats < 1.0 || sats > (u64::MAX as f64) {
                return None;
            }
            Some(sats as u64)
        }
    }
}

fn format_sats_for_unit(sats: u64, unit: SendUnit) -> String {
    match unit {
        SendUnit::Sats => sats.to_string(),
        SendUnit::Bsv => {
            let full = format!("{:.8}", (sats as f64) / 100_000_000.0);
            full.trim_end_matches('0').trim_end_matches('.').to_string()
        }
    }
}

/// 1:1 port of `src/components/SendPanel.tsx` with multi-stage statechart & WalletNav-docked CTAs.
#[component]
pub fn SendPanel(
    snap: WalletSnapshot,
    #[props(default = None)] initial_recipient: Option<String>,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let initial_rec = initial_recipient.unwrap_or_default();
    let start_stage = if classify_recipient(&initial_rec).is_some() {
        SendStage::EditingAmount
    } else {
        SendStage::EditingDestination
    };
    let mut stage = use_signal(move || start_stage);
    let mut recipient_input = use_signal(move || initial_rec);
    let mut amount_input = use_signal(String::new);
    let mut unit = use_signal(|| SendUnit::Sats);
    let mut estimated_fee = use_signal(|| 0u64);
    let mut estimated_total = use_signal(|| 0u64);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let current_stage = stage.read().clone();
    let current_unit = *unit.read();
    let raw_recipient = recipient_input.read().clone();
    let parsed_recipient = classify_recipient(&raw_recipient);
    let recipient_non_empty = !raw_recipient.trim().is_empty();
    let recipient_invalid = recipient_non_empty && parsed_recipient.is_none();

    let raw_amount = amount_input.read().clone();
    let parsed_sats = parse_amount_to_sats(&raw_amount, current_unit);
    let over_held = parsed_sats
        .map(|s| s > snap.balance.spendable_sats)
        .unwrap_or(false);

    let avail_bsv = format_bsv(snap.balance.spendable_sats);
    let recipient_label = parsed_recipient
        .as_ref()
        .map(RecipientKind::display_label)
        .unwrap_or_else(|| raw_recipient.trim().to_string());

    let secondary_amount = parsed_sats.map(|sats| match current_unit {
        SendUnit::Sats => format_bsv(sats),
        SendUnit::Bsv => format!("{sats} sats"),
    });

    let primary_amount_label = parsed_sats
        .map(|sats| match current_unit {
            SendUnit::Sats => format!("{sats} sats"),
            SendUnit::Bsv => format_bsv(sats),
        })
        .unwrap_or_else(|| "0 sats".into());

    // Bake CTAs into the WalletNav action bar (`wallet-nav-titlebar-tabs[data-permission=""]`).
    let desired_dock = match &current_stage {
        SendStage::EditingDestination => DockSpec {
            aria_label: "Send actions",
            secondary: Some(DockActionSpec::new(
                "cancel",
                "Cancel",
                ActionTone::Danger,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "continue",
                "Continue",
                ActionTone::Primary,
                ActionIcon::Check,
            )
            .disabled(parsed_recipient.is_none()),
        },
        SendStage::EditingAmount => DockSpec {
            aria_label: "Send actions",
            secondary: Some(DockActionSpec::new(
                "back",
                "Back",
                ActionTone::Secondary,
                ActionIcon::Back,
            )),
            primary: DockActionSpec::new(
                "review",
                "Review",
                ActionTone::Primary,
                ActionIcon::Check,
            )
            .disabled(parsed_sats.is_none() || over_held),
        },
        SendStage::Confirming => DockSpec {
            aria_label: "Confirm transaction",
            secondary: Some(DockActionSpec::new(
                "cancel",
                "Cancel",
                ActionTone::Danger,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "confirm",
                "Confirm",
                ActionTone::Primary,
                ActionIcon::Check,
            ),
        },
        SendStage::Failure(_) => DockSpec {
            aria_label: "Send failure actions",
            secondary: Some(DockActionSpec::new(
                "cancel",
                "Close",
                ActionTone::Danger,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new("edit", "Edit", ActionTone::Secondary, ActionIcon::Back),
        },
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let svc_review = Arc::clone(&services);
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "cancel" => {
                    dock_spec.set(None);
                    nav_child.set(None);
                }
                "continue" => {
                    if classify_recipient(&recipient_input.read()).is_some() {
                        stage.set(SendStage::EditingAmount);
                    }
                }
                "back" => stage.set(SendStage::EditingDestination),
                "edit" => stage.set(SendStage::EditingAmount),
                "review" => {
                    let cur_amt = amount_input.read().clone();
                    let cur_u = *unit.read();
                    let Some(sats) = parse_amount_to_sats(&cur_amt, cur_u) else {
                        return;
                    };
                    let rec_val = recipient_input.read().clone();
                    match classify_recipient(&rec_val) {
                        Some(RecipientKind::P2pkhAddress(addr)) => {
                            match svc_review.preview_send(&addr, sats) {
                                Ok((total, fee)) => {
                                    estimated_fee.set(fee);
                                    estimated_total.set(total);
                                    stage.set(SendStage::Confirming);
                                }
                                Err(e) => stage.set(SendStage::Failure(e)),
                            }
                        }
                        Some(_) => {
                            estimated_fee.set(1);
                            estimated_total.set(sats.saturating_add(1));
                            stage.set(SendStage::Confirming);
                        }
                        None => stage.set(SendStage::Failure("Invalid recipient.".into())),
                    }
                }
                "confirm" => {
                    let fee = *estimated_fee.read();
                    let cur_amt = amount_input.read().clone();
                    let cur_u = *unit.read();
                    let amt_label = parse_amount_to_sats(&cur_amt, cur_u)
                        .map(|s| match cur_u {
                            SendUnit::Sats => format!("{s} sats"),
                            SendUnit::Bsv => format_bsv(s),
                        })
                        .unwrap_or_else(|| "0 sats".into());
                    let rec_val = recipient_input.read().clone();
                    let lbl = classify_recipient(&rec_val)
                        .as_ref()
                        .map(RecipientKind::display_label)
                        .unwrap_or(rec_val);
                    toast.set(Some(ToastNotice {
                        title: "Payment prepared".into(),
                        body: Some(format!(
                            "{amt_label} to {lbl} validated (est. fee {fee} sat). Native ARC broadcast wiring is next."
                        )),
                        tone: "success",
                    }));
                    dock_spec.set(None);
                    nav_child.set(None);
                }
                _ => {}
            }
        });
    }

    rsx! {
        div {
            class: "nav-child-panel send-panel",
            "data-aeon-scope": "send",
            "data-aeon-state": current_stage.as_attr(),
            "data-chain": "bsv",

            match current_stage {
                SendStage::EditingDestination => rsx! {
                    div { class: "send-stage send-stage-edit",
                        div { class: "send-layout",
                            header { class: "send-panel-intro",
                                h3 { class: "send-panel-title", "Send BSV" }
                            }
                            div { class: "send-side",
                                div { class: "field friend-recipient-field send-to-field",
                                    label { r#for: "send-to", "To" }
                                    div { class: "send-to-input",
                                        input {
                                            id: "send-to",
                                            placeholder: "BSV address (1…), peerpay:, $handle, or wallet key",
                                            value: "{raw_recipient}",
                                            oninput: move |e| recipient_input.set(e.value()),
                                        }
                                    }
                                    if recipient_invalid {
                                        p { class: "wallet-sync-note is-error", role: "alert",
                                            "Not a valid BSV address, peerpay: URI, $handle, or wallet key."
                                        }
                                    }
                                    if let Some(ref kind) = parsed_recipient {
                                        p { class: "send-resolved", aria_live: "polite",
                                            "Sending to "
                                            strong { "{kind.display_label()}" }
                                        }
                                    }
                                }
                                p { class: "send-eta-row", "data-ready": "",
                                    span { class: "send-eta-label", "Arrival" }
                                    strong { class: "send-eta-value", "Instant · BSV" }
                                }
                            }
                        }
                    }
                },

                SendStage::EditingAmount => rsx! {
                    div { class: "send-stage send-stage-edit",
                        div { class: "send-layout",
                            header { class: "send-panel-intro",
                                h3 { class: "send-panel-title", "Send BSV" }
                            }
                            div { class: "send-amount-hero",
                                label { r#for: "send-amount", class: "send-amount-label", "Amount" }
                                div { class: "send-amount-row",
                                    span { class: "send-amount-prefix", aria_hidden: true,
                                        if current_unit == SendUnit::Bsv { "BSV" } else { "sats" }
                                    }
                                    input {
                                        id: "send-amount",
                                        class: "send-amount-input",
                                        placeholder: "0",
                                        value: "{raw_amount}",
                                        oninput: move |e| amount_input.set(e.value()),
                                    }
                                }
                                div { class: "send-currency-toggle", role: "group", aria_label: "Amount unit",
                                    button {
                                        r#type: "button",
                                        class: "send-currency-opt",
                                        "data-active": if current_unit == SendUnit::Bsv { Some("") } else { None },
                                        aria_pressed: current_unit == SendUnit::Bsv,
                                        onclick: move |_| {
                                            if current_unit != SendUnit::Bsv {
                                                let cur_val = amount_input.read().clone();
                                                if let Some(s) = parse_amount_to_sats(&cur_val, current_unit) {
                                                    amount_input.set(format_sats_for_unit(s, SendUnit::Bsv));
                                                }
                                                unit.set(SendUnit::Bsv);
                                            }
                                        },
                                        "BSV"
                                    }
                                    button {
                                        r#type: "button",
                                        class: "send-currency-opt",
                                        "data-active": if current_unit == SendUnit::Sats { Some("") } else { None },
                                        aria_pressed: current_unit == SendUnit::Sats,
                                        onclick: move |_| {
                                            if current_unit != SendUnit::Sats {
                                                let cur_val = amount_input.read().clone();
                                                if let Some(s) = parse_amount_to_sats(&cur_val, current_unit) {
                                                    amount_input.set(format_sats_for_unit(s, SendUnit::Sats));
                                                }
                                                unit.set(SendUnit::Sats);
                                            }
                                        },
                                        "SATS"
                                    }
                                }
                                div { class: "send-amount-note", aria_live: "polite",
                                    if over_held {
                                        span { class: "send-amount-warning",
                                            "More than this wallet can send"
                                        }
                                    } else if let Some(ref sec) = secondary_amount {
                                        span { class: "send-amount-secondary", "≈ {sec}" }
                                    }
                                }
                                p { class: "send-available",
                                    "Available {avail_bsv} · {snap.balance.spendable_sats} sats"
                                }
                            }

                            div { class: "send-side",
                                p { class: "send-resolved",
                                    "Sending to "
                                    strong { "{recipient_label}" }
                                }
                                p { class: "send-eta-row", "data-ready": "",
                                    span { class: "send-eta-label", "Arrival" }
                                    strong { class: "send-eta-value", "Instant · BSV" }
                                }
                            }
                        }
                    }
                },

                SendStage::Confirming => {
                    let fee = *estimated_fee.read();
                    let total = *estimated_total.read();
                    let target_raw = parsed_recipient
                        .as_ref()
                        .map(RecipientKind::raw_value)
                        .unwrap_or_else(|| raw_recipient.clone());
                    let is_p2pkh = matches!(parsed_recipient, Some(RecipientKind::P2pkhAddress(_)));

                    rsx! {
                        div { class: "send-stage send-stage-confirm",
                            div { class: "send-layout send-layout-confirm",
                                div { class: "send-amount-hero",
                                    p { class: "send-eyebrow", "You're sending" }
                                    p { class: "send-confirm-amount", "{primary_amount_label}" }
                                    if let Some(ref sec) = secondary_amount {
                                        div { class: "send-amount-note",
                                            span { class: "send-amount-secondary", "≈ {sec}" }
                                        }
                                    }
                                    p { class: "send-eta-row", "data-ready": "",
                                        span { class: "send-eta-label", "BSV" }
                                        strong { class: "send-eta-value", "Est. fee {fee} sat · Total {total} sats" }
                                    }
                                }
                                div { class: "send-side",
                                    p { class: "send-confirm-to",
                                        "to "
                                        strong { "{recipient_label}" }
                                    }
                                    p { class: "mono send-confirm-address", "{target_raw}" }
                                    p { class: "send-confirm-note",
                                        if is_p2pkh {
                                            "Standard BSV P2PKH payment. Cannot be undone once broadcast."
                                        } else {
                                            "BRC-29 PeerPay transfer. Native broadcast lands in the next engine milestone."
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                SendStage::Failure(ref err) => rsx! {
                    div { class: "send-stage send-stage-failure",
                        div { class: "send-stage-body send-stage-body-center",
                            p { class: "send-status-title", "Couldn't send" }
                            p { class: "error send-failure-error", "{err}" }
                        }
                    }
                },
            }
        }
    }
}
