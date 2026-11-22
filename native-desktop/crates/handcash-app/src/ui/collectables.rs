// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop collectables & assets surfaces:
//! - `src/components/InventoryPanel.tsx`
//! - `src/components/CollectionViewToggle.tsx`
//! - `src/components/CollectableVerifyMark.tsx`
//! - `src/components/CollectableDetailsPanel.tsx`
//! - `src/components/SendCollectablePanel.tsx`
//! - `src/components/BurnAssetPanel.tsx`

use crate::icons::{
    CheckIcon, CollectablesIcon, CopyIcon, FireIcon, LaunchIcon, ViewGridIcon, ViewListIcon,
};
use crate::machines::{classify_recipient, CollectionView, NavChild, RecipientKind, ToastNotice};
use crate::state::{
    copy_to_clipboard, open_external_url, truncate_mid, tx_explorer_url, AppServices,
    WalletSnapshot,
};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use crate::ui::EmptyState;
use aeon_ui::button;
use dioxus::prelude::*;
use handcash_storage::ItemCardRow;
use std::sync::Arc;

/// Strictly follows AGENTS.md authenticity order:
/// only complete BRC-150 proofs display as verified; indexer/marker claims stay `unproven`.
pub fn authenticity_display(status: &str) -> (&'static str, &'static str) {
    match status.trim().to_ascii_lowercase().as_str() {
        "brc150" | "proven" | "verified" => ("Verified · BRC-150", "brc150"),
        "verifying" | "pending" => ("Verifying…", "verifying"),
        "invalid" => ("Cannot be verified", "unproven"),
        _ => ("Unverified identity", "unproven"),
    }
}

fn txid_from_outpoint(outpoint: &str) -> Option<&str> {
    let txid = outpoint.split(['_', '.', ':']).next()?;
    if txid.len() == 64 && txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(txid)
    } else {
        None
    }
}

/// 1:1 port of `src/components/CollectionViewToggle.tsx`.
#[component]
pub fn CollectionViewToggle(mut view: Signal<CollectionView>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let cur = *view.read();
    let svc_list = Arc::clone(&services);
    let svc_grid = Arc::clone(&services);

    rsx! {
        div { class: "collection-view-toggle", role: "group", aria_label: "View",
            button {
                r#type: "button",
                class: "wallet-nav-chrome-btn collection-view-btn",
                aria_label: "List view",
                aria_pressed: cur == CollectionView::List,
                title: "List",
                "data-active": if cur == CollectionView::List { Some("true") } else { None },
                onclick: move |_| {
                    view.set(CollectionView::List);
                    svc_list.save_collection_view(CollectionView::List);
                },
                ViewListIcon { size: 16 }
            }
            button {
                r#type: "button",
                class: "wallet-nav-chrome-btn collection-view-btn",
                aria_label: "Grid view",
                aria_pressed: cur == CollectionView::Grid,
                title: "Grid",
                "data-active": if cur == CollectionView::Grid { Some("true") } else { None },
                onclick: move |_| {
                    view.set(CollectionView::Grid);
                    svc_grid.save_collection_view(CollectionView::Grid);
                },
                ViewGridIcon { size: 16 }
            }
        }
    }
}

/// 1:1 port of `src/components/CollectableVerifyMark.tsx`.
#[component]
pub fn CollectableVerifyMark(authenticity_status: String) -> Element {
    let (_, tone) = authenticity_display(&authenticity_status);
    if tone != "brc150" {
        return rsx! {};
    }
    rsx! {
        span {
            class: "collectable-verify-mark collectable-verify-mark--done",
            aria_label: "Verified BRC-150",
            title: "Verified · BRC-150",
            CheckIcon { size: 10 }
        }
    }
}

/// 1:1 port of `src/components/InventoryPanel.tsx`.
#[component]
pub fn InventoryPanel(
    snap: WalletSnapshot,
    view: Signal<CollectionView>,
    mut nav_child: Signal<Option<NavChild>>,
) -> Element {
    let mut query = use_signal(String::new);

    let q = query.read().trim().to_ascii_lowercase();
    let cur_view = *view.read();
    let filtered: Vec<&ItemCardRow> = snap
        .items
        .iter()
        .filter(|item| {
            q.is_empty()
                || item.name.to_ascii_lowercase().contains(&q)
                || item.origin_outpoint.to_ascii_lowercase().contains(&q)
                || item.mime.to_ascii_lowercase().contains(&q)
        })
        .collect();

    rsx! {
        div {
            class: "nav-section-body nav-section-with-scroll",
            "data-aeon-scope": "collectables",
            "data-aeon-state": "list",
            "data-view": cur_view.as_str(),

            if !snap.items.is_empty() {
                div { class: "field", style: "margin-bottom: 10px;",
                    input {
                        placeholder: "Filter collectables by name, origin, or MIME…",
                        value: "{query}",
                        oninput: move |e| query.set(e.value()),
                    }
                }
            }

            if snap.items.is_empty() {
                EmptyState {
                    icon: Some(rsx! { CollectablesIcon { size: 28 } }),
                    title: "No collectables here",
                    body: Some("Items and tokens sent to this wallet show up here.".into()),
                }
            } else if filtered.is_empty() {
                EmptyState {
                    icon: Some(rsx! { CollectablesIcon { size: 28 } }),
                    title: "No matching items",
                    body: Some("Try a different search term.".into()),
                    action: Some(rsx! {
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| query.set(String::new()),
                            button::Label { "Clear search" }
                        }
                    }),
                }
            } else {
                div { class: "nav-section-scroll-body",
                    section { class: "collect-items-section",
                        if cur_view == CollectionView::Grid {
                            ul { class: "collection-grid collectables-grid",
                                for item in filtered.iter() {
                                    {
                                        let outpoint = item.outpoint.clone();
                                        let (auth_label, auth_tone) = authenticity_display(&item.authenticity_status);
                                        rsx! {
                                            li { key: "{item.outpoint}", class: "collection-grid-card collectable-card",
                                                button {
                                                    r#type: "button",
                                                    class: "collection-grid-main collectable-main",
                                                    onclick: move |_| {
                                                        nav_child.set(Some(NavChild::CollectableDetails(outpoint.clone())));
                                                    },
                                                    div { class: "collectable-media",
                                                        if let Some(art_url) = snap.item_art.get(&item.outpoint) {
                                                            img {
                                                                class: "collectable-img",
                                                                src: "{art_url}",
                                                                alt: "{item.name}",
                                                            }
                                                        } else {
                                                            span { class: "collectable-media-fallback", aria_hidden: true,
                                                                CollectablesIcon { size: 32 }
                                                            }
                                                        }
                                                        CollectableVerifyMark {
                                                            authenticity_status: item.authenticity_status.clone(),
                                                        }
                                                    }
                                                    strong { class: "collection-grid-name", "{item.name}" }
                                                    span {
                                                        class: "collection-grid-host",
                                                        "data-tone": "{auth_tone}",
                                                        "{auth_label}"
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            ul { class: "connected-app-list collectables-list",
                                for item in filtered.iter() {
                                    {
                                        let outpoint = item.outpoint.clone();
                                        let (auth_label, auth_tone) = authenticity_display(&item.authenticity_status);
                                        rsx! {
                                            li { key: "{item.outpoint}", class: "connected-app-row collectable-row",
                                                button {
                                                    r#type: "button",
                                                    class: "connected-app-main collectable-row-main",
                                                    onclick: move |_| {
                                                        nav_child.set(Some(NavChild::CollectableDetails(outpoint.clone())));
                                                    },
                                                    div { class: "collectable-media collectable-media-sm",
                                                        if let Some(art_url) = snap.item_art.get(&item.outpoint) {
                                                            img {
                                                                class: "collectable-img",
                                                                src: "{art_url}",
                                                                alt: "{item.name}",
                                                            }
                                                        } else {
                                                            span { class: "collectable-media-fallback", aria_hidden: true,
                                                                CollectablesIcon { size: 20 }
                                                            }
                                                        }
                                                        CollectableVerifyMark {
                                                            authenticity_status: item.authenticity_status.clone(),
                                                        }
                                                    }
                                                    div { class: "connected-app-body",
                                                        strong { class: "connected-app-name", "{item.name}" }
                                                        span { class: "connected-app-host mono",
                                                            "{truncate_mid(&item.origin_outpoint, 12)} · {item.mime}"
                                                        }
                                                    }
                                                    span {
                                                        class: "history-when",
                                                        "data-tone": "{auth_tone}",
                                                        "{auth_label}"
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
}

/// 1:1 port of `src/components/CollectableDetailsPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn CollectableDetailsPanel(
    outpoint: String,
    chain: String,
    snap: WalletSnapshot,
    mut snapshot: Signal<WalletSnapshot>,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let Some(item) = snap.items.iter().find(|i| i.outpoint == outpoint).cloned() else {
        if dock_spec.read().is_some() {
            dock_spec.set(None);
        }
        return rsx! {
            div { class: "nav-child-panel collectable-details", "data-aeon-scope": "collectable-details",
                EmptyState {
                    icon: Some(rsx! { CollectablesIcon { size: 28 } }),
                    title: "Item not found",
                    body: Some("This collectable is no longer in your local inventory.".into()),
                }
            }
        };
    };

    let desired_dock = DockSpec {
        aria_label: "Collectable actions",
        secondary: Some(DockActionSpec::new(
            "burn",
            "Burn",
            ActionTone::Danger,
            ActionIcon::Fire,
        )),
        primary: DockActionSpec::new("send", "Send", ActionTone::Primary, ActionIcon::Send),
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let out_send = item.outpoint.clone();
        let out_burn = item.outpoint.clone();
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "burn" => nav_child.set(Some(NavChild::BurnAsset(out_burn.clone()))),
                "send" => nav_child.set(Some(NavChild::SendCollectable(out_send.clone()))),
                _ => {}
            }
        });
    }

    let (auth_label, auth_tone) = authenticity_display(&item.authenticity_status);
    let explorer_url =
        txid_from_outpoint(&item.origin_outpoint).map(|tx| tx_explorer_url(tx, &chain));
    let svc_verify = Arc::clone(&services);
    let origin_copy = item.origin_outpoint.clone();
    let outpoint_copy = item.outpoint.clone();

    rsx! {
        div {
            class: "nav-child-panel collectable-details",
            "data-aeon-scope": "collectable-details",
            "data-aeon-state": "{auth_tone}",

            div { class: "payment-details-hero",
                div { class: "history-icon-wrap",
                    if let Some(art_url) = snap.item_art.get(&item.outpoint) {
                        div { class: "collectable-media collectable-media-sm",
                            img {
                                class: "collectable-img",
                                src: "{art_url}",
                                alt: "{item.name}",
                            }
                        }
                    } else {
                        div { class: "history-icon",
                            CollectablesIcon { size: 18 }
                        }
                    }
                }
                div { class: "payment-details-copy",
                    div { class: "payment-details-title-row",
                        strong { class: "collectable-details-name payment-details-title", "{item.name}" }
                        if let Some(ref url) = explorer_url {
                            {
                                let u = url.clone();
                                rsx! {
                                    button {
                                        r#type: "button",
                                        class: "payment-details-woc",
                                        onclick: move |_| {
                                            if let Err(e) = open_external_url(&u) {
                                                toast.set(Some(ToastNotice {
                                                    title: "Open explorer".into(),
                                                    body: Some(e),
                                                    tone: "error",
                                                }));
                                            }
                                        },
                                        LaunchIcon { size: 14 }
                                        span { "Open in WhatsOnChain" }
                                    }
                                }
                            }
                        }
                    }
                    p { class: "history-when", "data-tone": "{auth_tone}", "{auth_label}" }
                }
            }

            if let Some(ref reason) = item.authenticity_reason {
                p { class: "settings-row-desc", "{reason}" }
            }

            dl { class: "payment-details-meta",
                dt { "Basket" }
                dd { class: "mono", "{item.basket}" }

                dt { "Media type" }
                dd { class: "mono", "{item.mime}" }

                dt { "Origin" }
                dd {
                    button {
                        r#type: "button",
                        class: "mono collectable-meta-copy",
                        title: "Copy origin",
                        onclick: move |_| match copy_to_clipboard(&origin_copy) {
                            Ok(()) => toast.set(Some(ToastNotice {
                                title: "Origin copied".into(),
                                body: Some(truncate_mid(&origin_copy, 12)),
                                tone: "success",
                            })),
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Copy failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        },
                        "{truncate_mid(&item.origin_outpoint, 14)}"
                    }
                }

                dt { "Outpoint" }
                dd {
                    button {
                        r#type: "button",
                        class: "mono collectable-meta-copy",
                        title: "Copy outpoint",
                        onclick: move |_| match copy_to_clipboard(&outpoint_copy) {
                            Ok(()) => toast.set(Some(ToastNotice {
                                title: "Outpoint copied".into(),
                                body: Some(truncate_mid(&outpoint_copy, 12)),
                                tone: "success",
                            })),
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Copy failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        },
                        "{truncate_mid(&item.outpoint, 14)}"
                    }
                }

                if let Some(ref issuer) = item.issuer_key {
                    {
                        let iss_copy = issuer.clone();
                        rsx! {
                            dt { "Issuer key" }
                            dd {
                                button {
                                    r#type: "button",
                                    class: "mono collectable-meta-copy",
                                    title: "Copy issuer key",
                                    onclick: move |_| {
                                        if copy_to_clipboard(&iss_copy).is_ok() {
                                            toast.set(Some(ToastNotice {
                                                title: "Issuer key copied".into(),
                                                body: Some(truncate_mid(&iss_copy, 12)),
                                                tone: "success",
                                            }));
                                        }
                                    },
                                    "{truncate_mid(issuer, 14)}"
                                }
                            }
                        }
                    }
                }
            }

            if auth_tone != "brc150" {
                div { class: "actions",
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| match svc_verify.verify_brc150_batch() {
                            Ok(n) => {
                                snapshot.set(svc_verify.read_snapshot());
                                toast.set(Some(ToastNotice {
                                    title: "BRC-150 check finished".into(),
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
                        CopyIcon { size: 14 }
                        button::Label { "Verify BRC-150 proof" }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/SendCollectablePanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn SendCollectablePanel(
    outpoint: String,
    snap: WalletSnapshot,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let mut confirming = use_signal(|| false);
    let mut recipient_input = use_signal(String::new);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let Some(item) = snap.items.iter().find(|i| i.outpoint == outpoint).cloned() else {
        if dock_spec.read().is_some() {
            dock_spec.set(None);
        }
        return rsx! {
            div { class: "nav-child-panel",
                p { class: "connected-empty-line", "Collectable not found." }
            }
        };
    };

    let raw_to = recipient_input.read().clone();
    let parsed = classify_recipient(&raw_to);
    let is_confirming = *confirming.read();

    let desired_dock = if !is_confirming {
        DockSpec {
            aria_label: "Send collectable actions",
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
            .disabled(parsed.is_none()),
        }
    } else {
        DockSpec {
            aria_label: "Confirm collectable transfer",
            secondary: Some(DockActionSpec::new(
                "cancel-confirm",
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
        }
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let out_back = item.outpoint.clone();
        let item_name = item.name.clone();
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "back" => nav_child.set(Some(NavChild::CollectableDetails(out_back.clone()))),
                "review" => confirming.set(true),
                "cancel-confirm" => confirming.set(false),
                "confirm" => {
                    toast.set(Some(ToastNotice {
                        title: "Item transfer prepared".into(),
                        body: Some(format!(
                            "{item_name} validated for transfer. Native 1Sat broadcast wiring is next."
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
            "data-aeon-scope": "send-collectable",
            "data-aeon-state": if is_confirming { "confirming" } else { "editing" },

            div { class: "send-stage",
                div { class: "send-layout",
                    div { class: "send-amount-hero send-collectable-hero",
                        div { class: "send-collectable-preview",
                            CollectablesIcon { size: 28 }
                            div {
                                p { class: "send-eyebrow",
                                    if is_confirming { "You're sending" } else { "1Sat Collectable" }
                                }
                                strong { class: "collectable-details-name", "{item.name}" }
                                p { class: "history-when mono", "{truncate_mid(&item.origin_outpoint, 12)}" }
                            }
                        }
                    }

                    div { class: "send-side",
                        if !is_confirming {
                            div { class: "field friend-recipient-field send-to-field",
                                label { r#for: "send-item-to", "To" }
                                div { class: "send-to-input",
                                    input {
                                        id: "send-item-to",
                                        placeholder: "BSV address (1…), peerpay:, $handle, or wallet key",
                                        value: "{raw_to}",
                                        oninput: move |e| recipient_input.set(e.value()),
                                    }
                                }
                                if !raw_to.trim().is_empty() && parsed.is_none() {
                                    p { class: "wallet-sync-note is-error", role: "alert",
                                        "Enter a valid BSV address, peerpay: URI, $handle, or wallet key."
                                    }
                                }
                                if let Some(ref kind) = parsed {
                                    p { class: "send-resolved",
                                        "Sending to "
                                        strong { "{kind.display_label()}" }
                                    }
                                }
                            }
                        } else {
                            p { class: "send-confirm-to",
                                "to "
                                strong {
                                    "{parsed.as_ref().map(RecipientKind::display_label).unwrap_or_else(|| raw_to.clone())}"
                                }
                            }
                            p { class: "mono send-confirm-address", "{raw_to}" }
                            p { class: "send-confirm-note",
                                "Includes BRC-150 provenance remittance when verified. Cannot be undone once broadcast."
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/BurnAssetPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn BurnAssetPanel(
    outpoint: String,
    snap: WalletSnapshot,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let mut confirming = use_signal(|| false);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let Some(item) = snap.items.iter().find(|i| i.outpoint == outpoint).cloned() else {
        if dock_spec.read().is_some() {
            dock_spec.set(None);
        }
        return rsx! {
            div { class: "nav-child-panel",
                p { class: "connected-empty-line", "Collectable not found." }
            }
        };
    };

    let is_confirming = *confirming.read();
    let desired_dock = if !is_confirming {
        DockSpec {
            aria_label: "Burn review actions",
            secondary: Some(DockActionSpec::new(
                "back",
                "Back",
                ActionTone::Secondary,
                ActionIcon::Back,
            )),
            primary: DockActionSpec::new(
                "review-burn",
                "Review burn",
                ActionTone::Danger,
                ActionIcon::Fire,
            ),
        }
    } else {
        DockSpec {
            aria_label: "Confirm burn",
            secondary: Some(DockActionSpec::new(
                "cancel-burn",
                "Cancel",
                ActionTone::Secondary,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "confirm-burn",
                "Burn permanently",
                ActionTone::Danger,
                ActionIcon::Fire,
            ),
        }
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let out_back = item.outpoint.clone();
        let item_name = item.name.clone();
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "back" => nav_child.set(Some(NavChild::CollectableDetails(out_back.clone()))),
                "review-burn" => confirming.set(true),
                "cancel-burn" => confirming.set(false),
                "confirm-burn" => {
                    toast.set(Some(ToastNotice {
                        title: "Burn prepared".into(),
                        body: Some(format!(
                            "Burn intent for {item_name} validated. Native burn broadcast wiring is next."
                        )),
                        tone: "error",
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
            "data-aeon-scope": "burn-asset",
            "data-aeon-state": if is_confirming { "confirming" } else { "editing" },

            div { class: "send-stage",
                div { class: "send-layout",
                    div { class: "send-amount-hero send-collectable-hero",
                        div { class: "send-collectable-preview",
                            span { class: "burn-hero-media", aria_hidden: true,
                                FireIcon { size: 24 }
                            }
                            div {
                                p { class: "send-eyebrow burn-eyebrow",
                                    if is_confirming { "You're burning" } else { "Destroy collectable" }
                                }
                                strong { class: "collectable-details-name", "{item.name}" }
                                p { class: "collectable-details-app mono", "{truncate_mid(&item.origin_outpoint, 12)}" }
                            }
                        }
                    }

                    div { class: "send-side",
                        dl { class: "burn-breakdown",
                            div {
                                dt { "Asset satoshi" }
                                dd { "1 sat" }
                            }
                            div {
                                dt { "Effect" }
                                dd { "Permanently destroys this 1Sat inscription on chain" }
                            }
                        }
                        if is_confirming {
                            p { class: "error",
                                "This cannot be undone. Confirm only if you intend to permanently burn this item."
                            }
                        }
                    }
                }
            }
        }
    }
}
