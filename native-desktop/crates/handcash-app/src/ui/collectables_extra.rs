// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Phase 6 Collectables & Tokens extended components.
//! 1:1 port of:
//! - `src/components/FungibleTokenFace.tsx`
//! - `src/components/DeferredModelViewer.tsx`
//! - `src/components/AssetHistoryList.tsx`
//! - `src/components/CollectableSendingMark.tsx`
//! - `src/components/BntShelf.tsx`

use crate::icons::{CloseIcon, CollectablesIcon, FireIcon, ListingIcon, PayIcon, SendIcon};
use crate::ui::primitives::{DeferredImage, LoadingSpinner};
use aeon_ui::{button, field};
use dioxus::prelude::*;

/// 1:1 port of `src/components/FungibleTokenFace.tsx`.
#[component]
pub fn FungibleTokenFace(
    token_id: String,
    sym: String,
    #[props(default)] icon_url: Option<String>,
    size: u32,
    #[props(default)] class: Option<String>,
) -> Element {
    let _ = token_id;
    let icon_size = if size >= 120 { 36 } else if size <= 56 { 22 } else { 28 };
    let radius = if size >= 120 { 12 } else if size <= 56 { 6 } else { 10 };
    let cls = match class.as_deref() {
        Some(c) if !c.is_empty() => format!("fungible-avatar {c}"),
        _ => "fungible-avatar".to_string(),
    };
    let style = format!("--fungible-face: {size}px; --art-radius: {radius}px;");
    let state = if icon_url.is_some() { "icon" } else { "placeholder" };
    let is_local = icon_url
        .as_deref()
        .is_some_and(|u| u.starts_with("data:") || u.starts_with("blob:"));
    let fallback = rsx! {
        span { class: "collectable-media-fallback", aria_hidden: "true",
            CollectablesIcon { size: icon_size }
        }
    };
    rsx! {
        span { class: "{cls}", "data-aeon-state": "{state}", style: "{style}",
            if let Some(url) = icon_url {
                if is_local {
                    img {
                        class: "fungible-avatar-image",
                        src: "{url}",
                        alt: "{sym}",
                        width: "{size}",
                        height: "{size}",
                    }
                } else {
                    DeferredImage {
                        class: Some("fungible-avatar-image".to_string()),
                        src: Some(url),
                        alt: sym,
                        width: Some(size),
                        height: Some(size),
                        fallback: Some(fallback),
                    }
                }
            } else {
                {fallback}
            }
        }
    }
}

/// 1:1 port of `src/components/DeferredModelViewer.tsx`.
/// Blitz has no WebGL runtime — renders honest `data-aeon-state="unavailable"` fallback.
#[component]
pub fn DeferredModelViewer(
    src: String,
    alt: String,
    #[props(default)] on_open_external: Option<EventHandler<String>>,
) -> Element {
    let open_src = src.clone();
    rsx! {
        div {
            class: "collectable-model-viewer",
            "data-aeon-scope": "model-viewer",
            "data-aeon-state": "unavailable",
            div { class: "collectable-model-fallback", role: "status",
                strong { "3D preview unavailable" }
                span { "{alt} — interactive WebGL models are not supported in native Blitz yet." }
                if let Some(cb) = on_open_external {
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| cb.call(open_src.clone()),
                        button::Label { "Open externally" }
                    }
                }
            }
        }
    }
}

/// Timeline entry for `AssetHistoryList`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemHistoryEventView {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub when_label: Option<String>,
    pub contact_label: Option<String>,
    pub asset_name: Option<String>,
}

/// 1:1 port of `src/components/AssetHistoryList.tsx`.
#[component]
pub fn AssetHistoryList(
    events: Vec<ItemHistoryEventView>,
    #[props(default)] on_open_contact: Option<EventHandler<String>>,
    #[props(default)] on_open_asset: Option<EventHandler<String>>,
) -> Element {
    if events.is_empty() {
        return rsx! {};
    }
    rsx! {
        section {
            class: "item-history",
            "data-aeon-part": "history",
            "data-aeon-scope": "item-history",
            h4 { class: "field-static-label", "History" }
            ol { class: "item-history-list",
                for ev in events {
                    li { key: "{ev.id}", "data-aeon-state": "{ev.kind}",
                        span { class: "item-history-node",
                            span { class: "history-action-mark", aria_label: "{ev.title}", "•" }
                        }
                        div { class: "item-history-copy",
                            strong { "{ev.title}" }
                            span { "{ev.detail}" }
                            if ev.contact_label.is_some() || ev.asset_name.is_some() {
                                div { class: "item-history-links",
                                    if let Some(contact) = ev.contact_label.clone() {
                                        button {
                                            r#type: "button",
                                            class: "item-history-chip",
                                            title: "Open contact",
                                            onclick: move |_| {
                                                if let Some(cb) = on_open_contact {
                                                    cb.call(contact.clone());
                                                }
                                            },
                                            "{contact}"
                                        }
                                    }
                                    if let Some(asset) = ev.asset_name.clone() {
                                        button {
                                            r#type: "button",
                                            class: "item-history-chip",
                                            title: "Open asset",
                                            onclick: move |_| {
                                                if let Some(cb) = on_open_asset {
                                                    cb.call(asset.clone());
                                                }
                                            },
                                            "{asset}"
                                        }
                                    }
                                }
                            }
                            if let Some(when) = ev.when_label {
                                time { "{when}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

pub fn in_flight_action_for_verb(verb: &str) -> &'static str {
    let lower = verb.to_ascii_lowercase();
    if lower.starts_with("burn") {
        "burn"
    } else if lower.starts_with("list") {
        "list"
    } else if lower.starts_with("cancel") {
        "cancel"
    } else if lower.starts_with("buy") {
        "buy"
    } else {
        "send"
    }
}

/// 1:1 port of `src/components/CollectableSendingMark.tsx`.
#[component]
pub fn CollectableSendingMark(
    sending: bool,
    #[props(default = "Sending".to_string())] verb: String,
) -> Element {
    if !sending {
        return rsx! {};
    }
    let action = in_flight_action_for_verb(&verb);
    rsx! {
        span {
            class: "collectable-sending-mark",
            "data-action": "{action}",
            aria_live: "polite",
            aria_label: "{verb}",
            title: "{verb}",
            LoadingSpinner { size: "sm".to_string() }
            if action == "burn" {
                FireIcon { size: 14 }
            } else if action == "list" {
                ListingIcon { size: 14 }
            } else if action == "cancel" {
                CloseIcon { size: 14 }
            } else if action == "buy" {
                PayIcon { size: 14 }
            } else {
                SendIcon { size: 14 }
            }
        }
    }
}

/// 1:1 port of `CollectableListedMark` in `src/components/CollectableSendingMark.tsx`.
#[component]
pub fn CollectableListedMark(
    label: String,
    #[props(default = "listed".to_string())] mark: String,
) -> Element {
    rsx! {
        span {
            class: "collectable-listed-mark",
            "data-aeon-state": "{mark}",
            aria_label: "{label}",
            title: "{label}",
            "{label}"
        }
    }
}

/// BNT asset summary for `BntShelf`, `TokenShelf`, and `BntChip`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BntAssetView {
    pub asset_id: String,
    pub sym: String,
    pub name: String,
    pub kind: String,
    pub amount_display: String,
    pub supply_label: Option<String>,
    pub image_url: Option<String>,
}

impl BntAssetView {
    pub fn display_label(&self) -> String {
        if !self.sym.is_empty() {
            self.sym.clone()
        } else if !self.name.is_empty() {
            self.name.clone()
        } else if self.asset_id.len() > 8 {
            format!("{}…", &self.asset_id[..8])
        } else {
            self.asset_id.clone()
        }
    }
}

/// 1:1 port of `BntChip` in `src/components/BntShelf.tsx`.
#[component]
pub fn BntChip(
    asset: BntAssetView,
    #[props(default = "grid".to_string())] view: String,
    #[props(default)] composing: bool,
    on_open: EventHandler<String>,
) -> Element {
    let lbl = asset.display_label();
    let face_size = if view == "grid" { 72 } else { 56 };
    let title = match asset.supply_label.as_deref() {
        Some(s) => format!("{lbl} · BNT · {s}"),
        None => format!("{lbl} · BNT"),
    };
    let id = asset.asset_id.clone();
    rsx! {
        li {
            class: "token-chip",
            "data-aeon-part": "token",
            "data-aeon-state": if composing { "composing" } else { "idle" },
            button {
                r#type: "button",
                class: "token-chip-main",
                title: "{title}",
                aria_label: "{lbl}, {asset.amount_display}, BNT. Send",
                onclick: move |_| on_open.call(id.clone()),
                span { class: "collectable-media collectable-media-sm collectable-media-token token-chip-face",
                    FungibleTokenFace {
                        token_id: asset.asset_id.clone(),
                        sym: lbl.clone(),
                        icon_url: asset.image_url.clone(),
                        size: face_size,
                    }
                }
                strong { class: "token-chip-sym", title: "{lbl}", "{lbl}" }
                span { class: "fungible-card-amount token-chip-amount", "{asset.amount_display}" }
            }
        }
    }
}

/// 1:1 port of `TokenShelf` in `src/components/BntShelf.tsx`.
#[component]
pub fn TokenShelf(
    assets: Vec<BntAssetView>,
    #[props(default = "grid".to_string())] view: String,
    #[props(default)] composing_id: Option<String>,
    #[props(default)] label: Option<String>,
    on_open: EventHandler<String>,
) -> Element {
    rsx! {
        ul {
            class: "token-strip",
            role: "list",
            aria_label: label.unwrap_or_default(),
            "data-aeon-part": "token-strip",
            "data-aeon-state": "{view}",
            for asset in assets {
                BntChip {
                    key: "{asset.asset_id}",
                    composing: composing_id.as_deref() == Some(asset.asset_id.as_str()),
                    asset,
                    view: view.clone(),
                    on_open,
                }
            }
        }
    }
}

/// 1:1 port of `src/components/BntShelf.tsx`.
#[component]
pub fn BntShelf(
    assets: Vec<BntAssetView>,
    #[props(default = "grid".to_string())] view: String,
    #[props(default)] error: Option<String>,
    #[props(default = true)] send_gated: bool,
) -> Element {
    let mut composing = use_signal(|| Option::<String>::None);
    let mut recipient = use_signal(String::new);
    let mut amount = use_signal(String::new);
    let open_asset = composing
        .read()
        .as_deref()
        .and_then(|id| assets.iter().find(|a| a.asset_id == id).cloned());
    if error.is_none() && open_asset.is_none() && assets.is_empty() {
        return rsx! {};
    }
    let state = if error.is_some() { "failed" } else if send_gated { "unavailable" } else { "ready" };
    rsx! {
        div { "data-aeon-scope": "bnt-holdings", "data-aeon-state": "{state}",
            if let Some(err) = error {
                div { class: "settings-row", "data-aeon-part": "failed",
                    span { class: "settings-row-desc", "BNT holdings could not be read: {err}" }
                }
            }
            if !assets.is_empty() {
                section {
                    class: "collect-tokens-section",
                    aria_label: "BNT assets without an issuer",
                    "data-aeon-part": "holdings",
                    h3 { class: "collect-section-title", "BNT assets without an issuer" }
                    TokenShelf {
                        assets,
                        view,
                        composing_id: composing.read().clone(),
                        on_open: move |id| composing.set(Some(id)),
                    }
                }
            }
            if let Some(asset) = open_asset {
                div { class: "settings-form", "data-aeon-part": "bnt-send", "data-aeon-state": if send_gated { "unavailable" } else { "composing" },
                    h4 { "Send {asset.display_label()}" }
                    field::Root { class: "field",
                        field::Label { r#for: "bnt-recipient", "Recipient" }
                        input {
                            id: "bnt-recipient",
                            class: "input",
                            value: "{recipient}",
                            placeholder: "$handle or identity key",
                            oninput: move |e| recipient.set(e.value()),
                        }
                    }
                    if asset.kind != "item" {
                        field::Root { class: "field",
                            field::Label { r#for: "bnt-amount", "Amount" }
                            input {
                                id: "bnt-amount",
                                class: "input",
                                value: "{amount}",
                                placeholder: "0",
                                oninput: move |e| amount.set(e.value()),
                            }
                        }
                    }
                    if send_gated {
                        p { class: "settings-row-desc", "BNT transfers and burns are not enabled in this build yet." }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| composing.set(None),
                            button::Label { "Cancel" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            disabled: send_gated,
                            button::Label { "Burn" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            disabled: send_gated,
                            button::Label { "Send" }
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
    fn sending_mark_action_classification_matches_ts() {
        assert_eq!(in_flight_action_for_verb("Sending"), "send");
        assert_eq!(in_flight_action_for_verb("Burning item"), "burn");
        assert_eq!(in_flight_action_for_verb("Listing on market"), "list");
        assert_eq!(in_flight_action_for_verb("Cancelling listing"), "cancel");
        assert_eq!(in_flight_action_for_verb("Buying item"), "buy");
    }
}
