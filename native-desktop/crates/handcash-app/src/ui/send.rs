// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/SendPanel.tsx` (`editing.destination` → `editing.amount` → `confirming` / `failure`),
//! with CTAs baked directly into the `WalletNav` action bar via `WalletActionBarNav`.

use crate::machines::{
    classify_recipient, NavChild, RecipientKind, SendUnit, ToastNotice,
};
use crate::state::{format_bsv, AppServices, WalletSnapshot};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use aeon_dioxus::use_aeon_machine;
use dioxus::prelude::*;
use handcash_machines::send::{
    SendEdit, SendEditingState, SendEvent, SendMachine, SendState,
};
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
    let send_chart = use_aeon_machine::<SendMachine>();
    let initial_rec = initial_recipient.unwrap_or_default();
    use_hook(|| {
        if !initial_rec.is_empty() {
            send_chart.send(SendEvent::Edit(SendEdit {
                to: Some(initial_rec.clone()),
                ..Default::default()
            }));
            if classify_recipient(&initial_rec).is_some() {
                send_chart.send(SendEvent::Next);
            }
        }
    });
    let mut unit = use_signal(|| SendUnit::Sats);
    let mut estimated_fee = use_signal(|| 0u64);
    let mut estimated_total = use_signal(|| 0u64);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let current_state = send_chart.state();
    let current_ctx = send_chart.context();
    let state_attr = send_chart.state_attr();
    let current_unit = *unit.read();
    let raw_recipient = current_ctx.to.clone();
    let parsed_recipient = classify_recipient(&raw_recipient);
    let recipient_non_empty = !raw_recipient.trim().is_empty();
    let recipient_invalid = recipient_non_empty && parsed_recipient.is_none();

    let raw_amount = current_ctx.amount.clone();
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
    let desired_dock = match current_state {
        SendState::Editing(SendEditingState::Destination) => DockSpec {
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
        SendState::Editing(SendEditingState::Amount(_)) => DockSpec {
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
        SendState::Confirming | SendState::Handoff => DockSpec {
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
            )
            .disabled(true),
        },
        SendState::Failure => DockSpec {
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
                    let rec = send_chart.peek_snapshot().context.to;
                    if classify_recipient(&rec).is_some() {
                        send_chart.send(SendEvent::Next);
                    }
                }
                "back" | "edit" => send_chart.send(SendEvent::Back),
                "review" => {
                    let ctx = send_chart.peek_snapshot().context;
                    let cur_u = *unit.read();
                    let Some(sats) = parse_amount_to_sats(&ctx.amount, cur_u) else {
                        return;
                    };
                    match classify_recipient(&ctx.to) {
                        Some(RecipientKind::P2pkhAddress(addr)) => {
                            match svc_review.preview_send(&addr, sats) {
                                Ok((total, fee)) => {
                                    estimated_fee.set(fee);
                                    estimated_total.set(total);
                                    send_chart.send(SendEvent::Review);
                                }
                                Err(error) => {
                                    send_chart.send(SendEvent::Review);
                                    send_chart.send(SendEvent::Fail { error });
                                }
                            }
                        }
                        Some(_) => {
                            estimated_fee.set(1);
                            estimated_total.set(sats.saturating_add(1));
                            send_chart.send(SendEvent::Review);
                        }
                        None => {
                            send_chart.send(SendEvent::Review);
                            send_chart.send(SendEvent::Fail {
                                error: "Invalid recipient.".into(),
                            });
                        }
                    }
                }
                "confirm" => {
                    // Gated until native ARC broadcast + crypto review (Phase 9).
                }
                _ => {}
            }
        });
    }

    rsx! {
        div {
            class: "nav-child-panel send-panel",
            "data-aeon-scope": "send",
            "data-aeon-state": "{state_attr}",
            "data-chain": "bsv",

            match current_state {
                SendState::Editing(SendEditingState::Destination) => rsx! {
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
                                            oninput: move |e| send_chart.send(SendEvent::Edit(SendEdit {
                                                to: Some(e.value()),
                                                ..Default::default()
                                            })),
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

                SendState::Editing(SendEditingState::Amount(_)) => rsx! {
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
                                        oninput: move |e| send_chart.send(SendEvent::Edit(SendEdit {
                                            amount: Some(e.value()),
                                            ..Default::default()
                                        })),
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
                                                let cur_val = send_chart.peek_snapshot().context.amount;
                                                if let Some(s) = parse_amount_to_sats(&cur_val, current_unit) {
                                                    send_chart.send(SendEvent::Edit(SendEdit {
                                                        amount: Some(format_sats_for_unit(s, SendUnit::Bsv)),
                                                        ..Default::default()
                                                    }));
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
                                                let cur_val = send_chart.peek_snapshot().context.amount;
                                                if let Some(s) = parse_amount_to_sats(&cur_val, current_unit) {
                                                    send_chart.send(SendEvent::Edit(SendEdit {
                                                        amount: Some(format_sats_for_unit(s, SendUnit::Sats)),
                                                        ..Default::default()
                                                    }));
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

                SendState::Confirming | SendState::Handoff => {
                    let fee = *estimated_fee.read();
                    let total = *estimated_total.read();
                    let target_raw = parsed_recipient
                        .as_ref()
                        .map(RecipientKind::raw_value)
                        .unwrap_or_else(|| raw_recipient.clone());

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
                                    p {
                                        class: "send-confirm-note",
                                        "data-aeon-state": "unavailable",
                                        "Sending is not available in this build yet."
                                    }
                                }
                            }
                        }
                    }
                }

                SendState::Failure => {
                    let err = current_ctx.error.as_deref().unwrap_or("Couldn't prepare send");
                    rsx! {
                        div { class: "send-stage send-stage-failure",
                            div { class: "send-stage-body send-stage-body-center",
                                p { class: "send-status-title", "Couldn't send" }
                                p { class: "error send-failure-error", "{err}" }
                            }
                        }
                    }
                }
            }
        }
    }
}
