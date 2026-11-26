// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Phase 3 BRC-100 app permission prompts & identity publish review.
//! 1:1 port of:
//! - `src/components/ConnectScopesList.tsx`
//! - `src/components/GrantDurationPicker.tsx`
//! - `src/components/WalletRequestTemplate.tsx`
//! - `src/components/PermissionItemPreview.tsx`
//! - `src/components/IdentityPublishReview.tsx`
//! - `src/components/AutoPayControls.tsx`
//! - `src/components/PermissionDetailsPanel.tsx`
//! - `src/components/PermissionRequestPanel.tsx`
//! - `src/components/ConnectPermissionDialog.tsx`
//! - `src/components/ActionPermissionDialog.tsx`

use crate::icons::{CheckIcon, CloseIcon, CollectablesIcon};
use crate::ui::apps::{AppAvatar, ScopeIcon};
use crate::ui::primitives::DeferredImage;
use aeon_dioxus::use_aeon_machine;
use aeon_ui::{button, prompt, segment_group};
use dioxus::prelude::*;
use handcash_machines::permission_decision::{
    PermissionDecisionEvent, PermissionDecisionMachine, PermissionDecisionState,
};

pub const DEFAULT_AUTO_PAY_MAX_USD: f64 = 1.0;
pub const DEFAULT_AUTO_PAY_WINDOW_HOURS: u32 = 24;

/// Scope metadata matching `CONNECT_GRANTED_SCOPES` in `src/wallet/appIdentity.ts`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionScopeInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub allows: &'static [&'static str],
}

pub const CONNECT_GRANTED_SCOPES: &[PermissionScopeInfo] = &[
    PermissionScopeInfo {
        id: "identity",
        label: "Public identity key & profile",
        description: "Lets this app read your public identity key, display name, and avatar.",
        allows: &[
            "Read your public identity key",
            "Display your chosen handle or profile name",
        ],
    },
    PermissionScopeInfo {
        id: "receive",
        label: "Send you plain BSV",
        description: "Incoming plain BSV from this app is internalized automatically without a prompt.",
        allows: &[
            "Deliver BSV payments directly into your wallet",
        ],
    },
    PermissionScopeInfo {
        id: "sign-data",
        label: "Sign in & verify ownership",
        description: "Lets this app ask your wallet to prove identity and authenticate sessions.",
        allows: &[
            "Sign authentication challenges",
            "Verify signatures with your identity key",
        ],
    },
];

pub fn get_permission_scope(scope_id: &str) -> Option<PermissionScopeInfo> {
    match scope_id {
        "identity" => Some(CONNECT_GRANTED_SCOPES[0].clone()),
        "receive" | "accept-incoming" => Some(CONNECT_GRANTED_SCOPES[1].clone()),
        "sign-data" => Some(CONNECT_GRANTED_SCOPES[2].clone()),
        "auto-pay" => Some(PermissionScopeInfo {
            id: "auto-pay",
            label: "Auto-pay",
            description: "Allows small outgoing coin payments within your configured limit without prompting.",
            allows: &[
                "Sign plain coin payments within the dollar and window limit",
            ],
        }),
        "items-view" => Some(PermissionScopeInfo {
            id: "items-view",
            label: "View collectables",
            description: "Lets this app list matching collectables held in your wallet.",
            allows: &["Read collectable titles, origins, and metadata"],
        }),
        "tokens-view" => Some(PermissionScopeInfo {
            id: "tokens-view",
            label: "View tokens",
            description: "Lets this app list fungible token balances held in your wallet.",
            allows: &["Read token symbols and balances"],
        }),
        "items-receive" => Some(PermissionScopeInfo {
            id: "items-receive",
            label: "Receive items & tokens",
            description: "Lets this app deliver collectables and tokens without a receive prompt.",
            allows: &["Internalize incoming collectables and tokens"],
        }),
        _ => None,
    }
}

/// 1:1 port of `src/components/ConnectScopesList.tsx`.
#[component]
pub fn ConnectScopesList() -> Element {
    rsx! {
        div { class: "scope-list scope-list-compact", aria_label: "Permissions requested",
            for scope in CONNECT_GRANTED_SCOPES.iter() {
                div { key: "{scope.id}", class: "scope-row scope-row-compact",
                    span { class: "scope-icon", aria_hidden: "true",
                        ScopeIcon { scope_id: scope.id.to_string(), size: 14 }
                    }
                    strong { "{scope.label}" }
                }
            }
        }
    }
}

/// BRC-73 grant durations matching `GRANT_DURATIONS` in `src/wallet/permissions.ts`.
pub const GRANT_DURATIONS: &[(&str, &str)] = &[
    ("session", "Session"),
    ("day", "24h"),
    ("week", "7d"),
    ("month", "30d"),
    ("forever", "Until disconnected"),
];

/// 1:1 port of `src/components/GrantDurationPicker.tsx`.
#[component]
pub fn GrantDurationPicker(
    pending_id: u64,
    grant_duration: String,
    #[props(default)] on_change: Option<EventHandler<String>>,
) -> Element {
    let label_id = format!("grant-duration-{pending_id}");
    rsx! {
        div {
            class: "grant-duration",
            "data-aeon-scope": "grant-duration",
            "data-aeon-state": "{grant_duration}",
            span { class: "grant-duration-label", id: "{label_id}", "Connected for" }
            segment_group::Root {
                value: Some(grant_duration.clone()),
                on_value_change: on_change,
                for (id, label) in GRANT_DURATIONS.iter() {
                    segment_group::Item { key: "{id}", value: id.to_string(), "{label}" }
                }
            }
        }
    }
}

/// Action configuration for `WalletRequestTemplate`.
#[derive(Clone, Debug, PartialEq)]
pub struct WalletRequestActions {
    pub aria_label: String,
    pub secondary_label: String,
    pub secondary_disabled: bool,
    pub primary_label: String,
    pub primary_disabled: bool,
}

/// 1:1 port of `src/components/WalletRequestTemplate.tsx`.
#[component]
pub fn WalletRequestTemplate(
    scope: String,
    #[props(default)] state: Option<String>,
    actions: WalletRequestActions,
    #[props(default = "nav".to_string())] placement: String,
    #[props(default)] class: Option<String>,
    #[props(default)] on_secondary: Option<EventHandler<()>>,
    #[props(default)] on_primary: Option<EventHandler<()>>,
    children: Element,
) -> Element {
    let inline = placement == "inline";
    let cls = format!(
        "permission-request-panel {} {}",
        if inline { "permission-request-panel--column" } else { "" },
        class.unwrap_or_default()
    );
    let st = state.unwrap_or_else(|| "pending".to_string());
    rsx! {
        div {
            class: "{cls.trim()}",
            "data-aeon-scope": "{scope}",
            "data-aeon-state": "{st}",
            if inline {
                div { class: "permission-request-scroll", {children} }
                div {
                    class: "wallet-action-bar connect-actions permission-request-actions",
                    role: "group",
                    aria_label: "{actions.aria_label}",
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost btn-danger",
                        disabled: actions.secondary_disabled,
                        onclick: move |_| {
                            if let Some(cb) = on_secondary { cb.call(()); }
                        },
                        CloseIcon { size: 18 }
                        button::Label { "{actions.secondary_label}" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        disabled: actions.primary_disabled,
                        onclick: move |_| {
                            if let Some(cb) = on_primary { cb.call(()); }
                        },
                        CheckIcon { size: 18 }
                        button::Label { "{actions.primary_label}" }
                    }
                }
            } else {
                {children}
            }
        }
    }
}

/// 1:1 port of `src/components/PermissionItemPreview.tsx`.
#[component]
pub fn PermissionItemPreview(
    #[props(default)] outpoint: Option<String>,
    #[props(default)] token_id: Option<String>,
    #[props(default)] item_name: Option<String>,
    #[props(default)] item_image_url: Option<String>,
    #[props(default)] preview_kind: Option<String>,
    #[props(default)] proven: bool,
) -> Element {
    let Some(name) = item_name.filter(|s| !s.trim().is_empty()) else {
        return rsx! {};
    };
    let kind = preview_kind.unwrap_or_else(|| {
        if token_id.as_deref().is_some_and(|s| !s.is_empty()) {
            "token".to_string()
        } else {
            "collectable".to_string()
        }
    });
    let subtitle = if kind == "token" {
        match token_id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => {
                let short = if id.len() > 14 {
                    format!("{}…{}", &id[..8], &id[id.len() - 6..])
                } else {
                    id.to_string()
                };
                format!("tokens · {short}")
            }
            None => "tokens".to_string(),
        }
    } else if proven && outpoint.is_some() {
        "Origin verified".to_string()
    } else {
        "Collectable".to_string()
    };
    rsx! {
        div { class: "permission-item-preview", "data-aeon-part": "item-preview",
            DeferredImage {
                src: item_image_url,
                alt: name.clone(),
                width: Some(56),
                height: Some(56),
                fallback: Some(rsx! {
                    span { class: "permission-item-preview-fallback", aria_hidden: "true",
                        CollectablesIcon { size: 22 }
                    }
                }),
            }
            div { class: "permission-item-preview-copy",
                span { "{subtitle}" }
                strong { title: "{name}", "{name}" }
            }
        }
    }
}

/// 1:1 port of `AutoPayChoice` + `SpendingAuthorizationDeclaration` in `src/components/AutoPayControls.tsx`.
#[derive(Clone, Debug, PartialEq)]
pub struct AutoPayChoice {
    pub enabled: bool,
    pub max_usd: f64,
    pub window_hours: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpendingAuthorizationDeclaration {
    pub amount_sats: u64,
    pub label: String,
}

pub fn connect_permission_note(
    spending_authorization: Option<&SpendingAuthorizationDeclaration>,
    auto_pay_enabled: bool,
) -> String {
    let receive = "Incoming plain BSV is accepted automatically. Disconnect anytime in Apps.";
    if let Some(auth) = spending_authorization {
        let pay = if auto_pay_enabled {
            "Matching outgoing payments stay silent within that monthly cap."
        } else {
            "Outgoing payments still need approval unless you enable Auto-pay."
        };
        return format!("{}. {pay} {receive}", auth.label);
    }
    if auto_pay_enabled {
        format!("Matching outgoing payments stay silent within your Auto-pay limits. Items still need separate approval. {receive}")
    } else {
        format!("Outgoing payments and items still need separate approval. {receive}")
    }
}

pub fn is_auto_payable_action(kind: Option<&str>, method: &str, title: Option<&str>) -> bool {
    if kind == Some("connect") {
        return false;
    }
    if method == "sendCoins" {
        return true;
    }
    if method != "createAction" && method != "signAction" {
        return false;
    }
    !matches!(
        title,
        Some(
            "Send item"
                | "Confirm item send"
                | "Release item"
                | "Send token"
                | "Confirm token send"
                | "Release token"
                | "Mint token"
                | "Mint item"
        )
    )
}

pub fn auto_pay_limits_invalid(enabled: bool, max_usd: &str, window_hours: &str) -> bool {
    if !enabled {
        return false;
    }
    let usd_ok = max_usd.trim().parse::<f64>().is_ok_and(|v| v.is_finite() && v > 0.0);
    let hrs_ok = window_hours.trim().parse::<f64>().is_ok_and(|v| v.is_finite() && v > 0.0);
    !usd_ok || !hrs_ok
}

/// 1:1 port of `src/components/AutoPayControls.tsx`.
#[component]
pub fn AutoPayControls(
    app_name: String,
    enabled: bool,
    max_usd: String,
    window_hours: String,
    #[props(default)] on_enabled_change: Option<EventHandler<bool>>,
    #[props(default)] on_max_usd_change: Option<EventHandler<String>>,
    #[props(default)] on_window_hours_change: Option<EventHandler<String>>,
    #[props(default)] monthly_cap: Option<SpendingAuthorizationDeclaration>,
) -> Element {
    let use_monthly_cap = monthly_cap.is_some();
    rsx! {
        div { class: "auto-pay", "data-aeon-part": "auto-pay",
            label { class: "auto-pay-toggle",
                input {
                    r#type: "checkbox",
                    checked: enabled,
                    onchange: move |e| {
                        if let Some(cb) = on_enabled_change {
                            cb.call(e.checked());
                        }
                    },
                }
                span {
                    "Auto-pay from "
                    strong { "{app_name}" }
                }
            }
            if enabled && !use_monthly_cap {
                div { class: "auto-pay-params", role: "group", aria_label: "Auto-pay limits",
                    label { class: "auto-pay-field",
                        span { class: "auto-pay-prefix", "$" }
                        input {
                            r#type: "number",
                            min: "0.01",
                            step: "0.01",
                            value: "{max_usd}",
                            aria_label: "Maximum dollars",
                            oninput: move |e| {
                                if let Some(cb) = on_max_usd_change { cb.call(e.value()); }
                            },
                        }
                    }
                    span { class: "auto-pay-sep", "every" }
                    span { class: "auto-pay-unit",
                        label { class: "auto-pay-field auto-pay-field-hours",
                            input {
                                r#type: "number",
                                min: "1",
                                step: "1",
                                value: "{window_hours}",
                                aria_label: "Hours",
                                oninput: move |e| {
                                    if let Some(cb) = on_window_hours_change { cb.call(e.value()); }
                                },
                            }
                        }
                        span { class: "auto-pay-sep", "hours" }
                    }
                }
            }
            if enabled {
                if let Some(cap) = monthly_cap {
                    p { class: "permission-note auto-pay-cap-note", "Within {cap.label}." }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/IdentityPublishReview.tsx`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityPublishPlanView {
    pub kind: String,
    pub name: String,
    pub fee_sats: u64,
    pub max_fee_sats: u64,
    pub image_summary: String,
    pub signing_key_label: String,
    pub retired_key_label: Option<String>,
    pub tx_summaries: Vec<(String, String)>,
}

#[component]
pub fn IdentityPublishReview(
    #[props(default)] stage: Option<String>,
    #[props(default)] pending_kind: Option<String>,
    #[props(default)] plan: Option<IdentityPublishPlanView>,
    #[props(default)] error: Option<String>,
    #[props(default = true)] signing_gated: bool,
    #[props(default)] on_approve: Option<EventHandler<()>>,
    #[props(default)] on_cancel: Option<EventHandler<()>>,
    #[props(default)] on_dismiss: Option<EventHandler<()>>,
) -> Element {
    let Some(stage_str) = stage else {
        return rsx! {};
    };
    let kind = plan
        .as_ref()
        .map(|p| p.kind.as_str())
        .or(pending_kind.as_deref())
        .unwrap_or("publish");
    let (title, effect, approve_label) = match kind {
        "update" => (
            "Update BAP profile",
            "Replaces the BAP copy of your profile. The earlier one stays on-chain.",
            "Sign and update",
        ),
        "rotate" => (
            "Rotate BAP signing key",
            "Same BAP profile and ID. A new key signs its changes from now on.",
            "Sign rotation",
        ),
        "link" => (
            "Link BAP profile",
            "Your identity key and the BAP profile both sign that it names the assets you issue. Public and permanent on-chain.",
            "Sign and link",
        ),
        _ => (
            "Publish to BAP",
            "Copies your profile to a BAP identity for wallets that read BAP. Public and permanent on-chain.",
            "Sign and publish",
        ),
    };
    let status = if stage_str == "publishing" {
        prompt::PromptStatus::Confirming
    } else {
        prompt::PromptStatus::Pending
    };
    let effective_state = if signing_gated && stage_str == "reviewing" {
        "unavailable"
    } else {
        stage_str.as_str()
    };
    rsx! {
        div { class: "permission-backdrop",
            prompt::Root {
                status,
                class: "panel modal permission-modal action-permission-modal",
                "data-aeon-part": "identity-publish-review",
                "data-aeon-state": "{effective_state}",
                h2 { class: "permission-request-title", "{title}" }
                if stage_str == "refused" {
                    prompt::Effect { role: "alert", "{error.clone().unwrap_or_default()}" }
                } else {
                    prompt::Effect { "{effect}" }
                }
                if let Some(p) = plan.as_ref().filter(|_| stage_str != "refused") {
                    prompt::Amount { class: "action-amount",
                        span { "Network fee" }
                        strong { "about {p.fee_sats} sats" }
                        em { class: "action-amount-bsv", "at most {p.max_fee_sats} sats" }
                    }
                    prompt::Meta { class: "permission-meta",
                        div { dt { "Name" } dd { "{p.name}" } }
                        div { dt { "Image" } dd { "{p.image_summary}" } }
                        div {
                            dt { if p.retired_key_label.is_some() { "New signing key" } else { "Signing key" } }
                            dd { class: "mono", "{p.signing_key_label}" }
                        }
                        if let Some(ret) = p.retired_key_label.as_ref() {
                            div { dt { "Retires" } dd { class: "mono", "{ret}" } }
                        }
                        for (desc, detail) in p.tx_summaries.iter() {
                            div { key: "{desc}", "data-aeon-part": "identity-record-tx",
                                dt { "{desc}" }
                                dd { "{detail}" }
                            }
                        }
                    }
                } else if stage_str == "quoting" {
                    p { class: "lede", "Preparing…" }
                }
                if signing_gated {
                    p { class: "settings-row-desc", "On-chain BAP signing is not enabled in this build yet." }
                }
                prompt::Actions { class: "actions",
                    if stage_str == "refused" {
                        prompt::Primary {
                            class: "btn btn-primary",
                            onclick: move |_| {
                                if let Some(cb) = on_dismiss { cb.call(()); }
                            },
                            "Back"
                        }
                    } else {
                        prompt::Secondary {
                            class: "btn btn-ghost",
                            disabled: stage_str == "publishing",
                            onclick: move |_| {
                                if let Some(cb) = on_cancel { cb.call(()); }
                            },
                            "Cancel"
                        }
                        prompt::Primary {
                            class: "btn btn-primary",
                            disabled: stage_str != "reviewing" || signing_gated,
                            onclick: move |_| {
                                if let Some(cb) = on_approve { cb.call(()); }
                            },
                            if stage_str == "publishing" { "Signing…" } else { "{approve_label}" }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/PermissionDetailsPanel.tsx`.
#[component]
pub fn PermissionDetailsPanel(
    origin: String,
    scope_id: String,
    #[props(default)] auto_pay: Option<AutoPayChoice>,
    #[props(default)] accepts_incoming: bool,
    #[props(default)] item_grant_copy: Option<String>,
    #[props(default)] on_clear_auto_pay: Option<EventHandler<()>>,
    #[props(default)] on_require_receive_approval: Option<EventHandler<()>>,
) -> Element {
    let Some(scope) = get_permission_scope(&scope_id) else {
        return rsx! { p { class: "connected-empty-line", "Permission not found" } };
    };
    let app_name = origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let show_receive_toggle =
        (scope_id == "receive" || scope_id == "accept-incoming") && accepts_incoming;
    rsx! {
        div {
            class: "nav-child-panel permission-details",
            "data-aeon-scope": "permission-details",
            "data-aeon-state": "{scope.id}",
            div { class: "permission-details-hero",
                span { class: "scope-icon", aria_hidden: "true",
                    ScopeIcon { scope_id: scope.id.to_string(), size: 18 }
                }
                div { class: "permission-details-head",
                    strong { class: "permission-details-title", "{scope.label}" }
                    span { class: "permission-details-sub", "{app_name}" }
                }
            }
            p { class: "permission-details-lede", "{scope.description}" }
            if let Some(copy) = item_grant_copy {
                p { class: "permission-details-lede", "{copy}" }
            }
            ul { class: "permission-details-allows",
                for item in scope.allows.iter() {
                    li { key: "{item}", "{item}" }
                }
            }
            if let Some(ap) = auto_pay.filter(|a| a.enabled) {
                div { class: "permission-details-limits",
                    span {
                        "Limit "
                        strong { "${ap.max_usd}" }
                        " / {ap.window_hours}h"
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost btn-compact",
                        onclick: move |_| {
                            if let Some(cb) = on_clear_auto_pay { cb.call(()); }
                        },
                        button::Label { "Turn off" }
                    }
                }
            }
            if show_receive_toggle {
                div { class: "permission-details-limits",
                    span { "Auto-accepting plain BSV receives" }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost btn-compact",
                        onclick: move |_| {
                            if let Some(cb) = on_require_receive_approval { cb.call(()); }
                        },
                        button::Label { "Require approval" }
                    }
                }
            }
        }
    }
}

/// Pending prompt payload for `ConnectPermissionDialog`, `ActionPermissionDialog`, and `PermissionRequestPanel`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPromptView {
    pub id: u64,
    pub kind: String,
    pub origin: String,
    pub app_name: String,
    pub method: String,
    pub title: String,
    pub summary: String,
    pub details: Vec<String>,
    pub grant_duration: String,
    pub amount_primary: Option<String>,
    pub amount_secondary: Option<String>,
    pub item_outpoint: Option<String>,
    pub token_id: Option<String>,
    pub item_name: Option<String>,
    pub item_image_url: Option<String>,
    pub preview_kind: Option<String>,
    pub monthly_cap: Option<SpendingAuthorizationDeclaration>,
    pub signing_required: bool,
}

/// Auto-pay fields as typed on one prompt; reset together when the prompt changes.
#[derive(Clone, Debug, PartialEq)]
struct AutoPayDraft {
    enabled: bool,
    max_usd: String,
    window_hours: String,
}

impl Default for AutoPayDraft {
    fn default() -> Self {
        Self {
            enabled: false,
            max_usd: DEFAULT_AUTO_PAY_MAX_USD.to_string(),
            window_hours: DEFAULT_AUTO_PAY_WINDOW_HOURS.to_string(),
        }
    }
}

impl AutoPayDraft {
    fn choice(&self) -> AutoPayChoice {
        AutoPayChoice {
            enabled: self.enabled,
            max_usd: self.max_usd.parse().unwrap_or(DEFAULT_AUTO_PAY_MAX_USD),
            window_hours: self.window_hours.parse().unwrap_or(DEFAULT_AUTO_PAY_WINDOW_HOURS),
        }
    }
}

/// 1:1 port of `src/components/PermissionRequestPanel.tsx`.
#[component]
pub fn PermissionRequestPanel(
    pending: PendingPromptView,
    #[props(default = "nav".to_string())] placement: String,
    #[props(default = true)] signing_gated: bool,
    #[props(default)] on_allow: Option<Callback<Option<AutoPayChoice>, bool>>,
    #[props(default)] on_deny: Option<Callback<(), bool>>,
) -> Element {
    let decision = use_aeon_machine::<PermissionDecisionMachine>();
    let mut auto_pay = use_signal(AutoPayDraft::default);
    let mut duration = use_signal(|| pending.grant_duration.clone());
    let mut accept_incoming = use_signal(|| false);
    let mut prompt_owner = use_signal(|| (pending.id, pending.origin.clone()));
    let owner = (pending.id, pending.origin.clone());
    if *prompt_owner.peek() != owner {
        prompt_owner.set(owner.clone());
        decision.send(PermissionDecisionEvent::Reset);
        auto_pay.set(AutoPayDraft::default());
        duration.set(pending.grant_duration.clone());
        accept_incoming.set(false);
    }
    let allow_owner = owner.clone();
    let deny_owner = owner;

    let committing = decision.state() == PermissionDecisionState::Committing;
    let is_connect = pending.kind == "connect";
    let show_auto_pay =
        is_connect || is_auto_payable_action(Some(&pending.kind), &pending.method, Some(&pending.title));
    let show_accept_incoming = !is_connect && pending.title == "Accept incoming funds";
    let draft = auto_pay.read().clone();
    let limits_bad = auto_pay_limits_invalid(draft.enabled, &draft.max_usd, &draft.window_hours);
    let gated = !is_connect && pending.signing_required && signing_gated;
    let allow_disabled =
        committing || gated || (show_auto_pay && pending.monthly_cap.is_none() && limits_bad);

    let actions = WalletRequestActions {
        aria_label: "Permission decision".to_string(),
        secondary_label: "Deny".to_string(),
        secondary_disabled: committing,
        primary_label: if gated { "Signing unavailable".to_string() } else { "Approve".to_string() },
        primary_disabled: allow_disabled,
    };
    let scope = if is_connect {
        "connect-permission-inline"
    } else {
        "action-permission-inline"
    };
    let state = if gated {
        "unavailable".to_string()
    } else {
        decision.state_attr()
    };

    let on_primary = EventHandler::new(move |_| {
        // Re-read the chart synchronously: a rendered boolean is stale for a
        // second tap in the same frame. Claim the edge before calling out.
        if allow_disabled || *prompt_owner.peek() != allow_owner
            || decision.state() != PermissionDecisionState::Pending { return; }
        decision.send(PermissionDecisionEvent::Approve);
        let choice = if show_auto_pay {
            Some(auto_pay.peek().choice())
        } else {
            None
        };
        let accepted = on_allow.is_some_and(|cb| cb.call(choice));
        if !accepted && *prompt_owner.peek() == allow_owner {
            decision.send(PermissionDecisionEvent::Reset);
        }
    });
    let on_secondary = EventHandler::new(move |_| {
        if *prompt_owner.peek() != deny_owner
            || decision.state() != PermissionDecisionState::Pending { return; }
        decision.send(PermissionDecisionEvent::Cancel);
        let accepted = on_deny.is_some_and(|cb| cb.call(()));
        if !accepted && *prompt_owner.peek() == deny_owner {
            decision.send(PermissionDecisionEvent::Reset);
        }
    });

    rsx! {
        WalletRequestTemplate {
            scope: scope.to_string(),
            state: Some(state),
            actions,
            placement,
            on_secondary: Some(on_secondary),
            on_primary: Some(on_primary),
            div { class: "connect-app-hero",
                AppAvatar { origin: pending.origin.clone(), name: pending.app_name.clone(), size: "md" }
                div {
                    p { class: "permission-eyebrow", if is_connect { "Connect" } else { "Wallet action" } }
                    h2 { class: "permission-request-title", if is_connect { "{pending.app_name}" } else { "{pending.title}" } }
                    p { class: "connect-app-host mono", "{pending.origin}" }
                }
            }
            if is_connect {
                p { class: "lede permission-lede-compact", "Wants to connect to your wallet" }
                ConnectScopesList {}
                GrantDurationPicker {
                    pending_id: pending.id,
                    grant_duration: duration.read().clone(),
                    on_change: move |next| duration.set(next),
                }
                AutoPayControls {
                    app_name: pending.app_name.clone(),
                    enabled: draft.enabled,
                    max_usd: draft.max_usd.clone(),
                    window_hours: draft.window_hours.clone(),
                    monthly_cap: pending.monthly_cap.clone(),
                    on_enabled_change: move |v| auto_pay.write().enabled = v,
                    on_max_usd_change: move |v| auto_pay.write().max_usd = v,
                    on_window_hours_change: move |v| auto_pay.write().window_hours = v,
                }
                p { class: "permission-note",
                    "{connect_permission_note(pending.monthly_cap.as_ref(), draft.enabled)}"
                }
            } else {
                if pending.item_outpoint.is_some() || pending.token_id.is_some() || pending.item_name.is_some() {
                    PermissionItemPreview {
                        outpoint: pending.item_outpoint.clone(),
                        token_id: pending.token_id.clone(),
                        item_name: pending.item_name.clone(),
                        item_image_url: pending.item_image_url.clone(),
                        preview_kind: pending.preview_kind.clone(),
                    }
                }
                if let Some(amt) = pending.amount_primary.as_ref() {
                    div { class: "action-amount",
                        span { "Amount" }
                        strong { "{amt}" }
                        if let Some(sec) = pending.amount_secondary.as_ref() {
                            em { class: "action-amount-bsv", "{sec}" }
                        }
                    }
                }
                if show_accept_incoming {
                    div { class: "auto-pay", "data-aeon-part": "accept-incoming",
                        label { class: "auto-pay-toggle",
                            input {
                                r#type: "checkbox",
                                checked: *accept_incoming.read(),
                                onchange: move |e| accept_incoming.set(e.checked()),
                            }
                            span { "Accept funds automatically from " strong { "{pending.app_name}" } }
                        }
                    }
                }
                dl { class: "permission-meta",
                    div { dt { "What for" } dd { "{pending.summary}" } }
                    for line in pending.details.iter().take(4) {
                        div { key: "{line}", dt { "Detail" } dd { "{line}" } }
                    }
                }
                if gated {
                    p { class: "settings-row-desc", "Signing BRC-100 actions is not enabled in this build yet." }
                }
                if show_auto_pay {
                    AutoPayControls {
                        app_name: pending.app_name.clone(),
                        enabled: draft.enabled,
                        max_usd: draft.max_usd.clone(),
                        window_hours: draft.window_hours.clone(),
                        on_enabled_change: move |v| auto_pay.write().enabled = v,
                        on_max_usd_change: move |v| auto_pay.write().max_usd = v,
                        on_window_hours_change: move |v| auto_pay.write().window_hours = v,
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/ConnectPermissionDialog.tsx`.
#[component]
pub fn ConnectPermissionDialog(
    #[props(default)] pending: Option<PendingPromptView>,
    #[props(default)] on_allow: Option<Callback<Option<AutoPayChoice>, bool>>,
    #[props(default)] on_deny: Option<Callback<(), bool>>,
) -> Element {
    let open = pending.is_some();
    rsx! {
        div {
            "data-aeon-scope": "connect-permission",
            "data-aeon-state": if open { "pending" } else { "idle" },
            if let Some(p) = pending {
                div { class: "permission-backdrop",
                    prompt::Root {
                        status: prompt::PromptStatus::Pending,
                        class: "panel modal permission-modal connect-permission-modal",
                        PermissionRequestPanel {
                            pending: p,
                            placement: "inline".to_string(),
                            signing_gated: false,
                            on_allow,
                            on_deny,
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/ActionPermissionDialog.tsx`.
#[component]
pub fn ActionPermissionDialog(
    #[props(default)] pending: Option<PendingPromptView>,
    #[props(default = true)] signing_gated: bool,
    #[props(default)] on_allow: Option<Callback<Option<AutoPayChoice>, bool>>,
    #[props(default)] on_deny: Option<Callback<(), bool>>,
) -> Element {
    let open = pending.is_some();
    let gated = pending.as_ref().is_some_and(|p| p.signing_required && signing_gated);
    let state = if !open {
        "idle"
    } else if gated {
        "unavailable"
    } else {
        "pending"
    };
    rsx! {
        div {
            "data-aeon-scope": "action-permission",
            "data-aeon-state": "{state}",
            if let Some(p) = pending {
                div { class: "permission-backdrop",
                    prompt::Root {
                        status: prompt::PromptStatus::Pending,
                        class: "panel modal permission-modal action-permission-modal",
                        PermissionRequestPanel {
                            pending: p,
                            placement: "inline".to_string(),
                            signing_gated,
                            on_allow,
                            on_deny,
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_pay_classification_and_validation_match_ts() {
        assert!(!is_auto_payable_action(Some("connect"), "createAction", None));
        assert!(is_auto_payable_action(Some("action"), "sendCoins", Some("Pay")));
        assert!(is_auto_payable_action(Some("action"), "createAction", Some("Pay app")));
        assert!(!is_auto_payable_action(Some("action"), "createAction", Some("Send item")));
        assert!(!is_auto_payable_action(Some("action"), "signAction", Some("Mint token")));
        assert!(!auto_pay_limits_invalid(false, "", ""));
        assert!(auto_pay_limits_invalid(true, "0", "24"));
        assert!(!auto_pay_limits_invalid(true, "2.5", "24"));
    }

    #[test]
    fn connect_note_reflects_monthly_cap_and_auto_pay() {
        let note_off = connect_permission_note(None, false);
        assert!(note_off.contains("separate approval"));
        let note_on = connect_permission_note(None, true);
        assert!(note_on.contains("Auto-pay limits"));
        let cap = SpendingAuthorizationDeclaration {
            amount_sats: 100_000,
            label: "Up to $5/month".to_string(),
        };
        let note_cap = connect_permission_note(Some(&cap), true);
        assert!(note_cap.contains("Up to $5/month"));
        assert!(note_cap.contains("monthly cap"));
    }
}
