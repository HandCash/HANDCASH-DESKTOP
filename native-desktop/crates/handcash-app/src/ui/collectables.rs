// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop collectables & assets surfaces:
//! - `src/components/InventoryPanel.tsx`
//! - `src/components/CollectionViewToggle.tsx`
//! - `src/components/CollectableVerifyMark.tsx`
//! - `src/components/CollectableDetailsPanel.tsx`
//! - `src/components/SendCollectablePanel.tsx`
//! - `src/components/BurnAssetPanel.tsx`

use crate::icons::{
    CheckIcon, CollectablesIcon, CopyIcon, ExpandMoreIcon, FireIcon, LaunchIcon, SendIcon,
    ViewGridIcon, ViewListIcon,
};
use crate::machines::{classify_recipient, CollectionView, NavChild, RecipientKind, ToastNotice};
use crate::state::{
    copy_to_clipboard, open_external_url, truncate_mid, tx_explorer_url, AppServices,
    WalletSnapshot,
};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use crate::ui::primitives::{MiddleEllipsisName, ProfileAvatar, ProfileFingerprint};
use crate::ui::EmptyState;
use aeon_ui::button;
use dioxus::prelude::*;
use handcash_storage::ItemCardRow;
use std::collections::{BTreeMap, BTreeSet};
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ItemAuthFilter {
    #[default]
    All,
    Verified,
    Unverified,
}

fn item_group_label(item: &ItemCardRow) -> String {
    if let Some(ref iss) = item.issuer_key {
        let t = iss.trim();
        if !t.is_empty() {
            return format!("Issuer {}", truncate_mid(t, 10));
        }
    }
    if let Some((prefix, _)) = item.name.split_once('#') {
        let clean = prefix.trim();
        if clean.len() >= 3 {
            return clean.to_string();
        }
    }
    "Uncategorized items".into()
}

/// Collect's select box, 1:1 port of `src/components/SelectionCheckbox.tsx`.
#[component]
fn CollectSelect(
    checked: bool,
    disabled: bool,
    label: String,
    class: &'static str,
    on_change: EventHandler<bool>,
) -> Element {
    rsx! {
        label {
            class: "collect-select {class}",
            title: "{label}",
            onclick: move |evt| evt.stop_propagation(),
            input {
                r#type: "checkbox",
                checked: checked,
                disabled: disabled,
                aria_label: "{label}",
                onchange: move |evt| on_change.call(evt.checked()),
            }
            span { "aria-hidden": "true" }
        }
    }
}

fn set_outpoint_selected(mut selected: Signal<BTreeSet<String>>, outpoint: &str, on: bool) {
    let mut next = selected.read().clone();
    if on {
        next.insert(outpoint.to_string());
    } else {
        next.remove(outpoint);
    }
    selected.set(next);
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CollectSortMode {
    #[default]
    Identity,
    Name,
    Recent,
}

impl CollectSortMode {
    pub const ALL: [Self; 3] = [Self::Identity, Self::Name, Self::Recent];
    pub const fn label(self) -> &'static str {
        match self {
            Self::Identity => "By identity",
            Self::Name => "Name",
            Self::Recent => "Recent",
        }
    }
}

/// 1:1 port of `src/components/InventoryPanel.tsx`.
/// One shelf per issuer identity (verified issuer profile -> signer -> app -> collection -> unverified key).
struct IdentityShelf<'a> {
    key: String,
    rank: u8,
    fingerprint_id: Option<String>,
    avatar_url: Option<String>,
    avatar_key: Option<String>,
    label: String,
    items: Vec<&'a ItemCardRow>,
}

fn collection_series_stem(name: &str) -> Option<String> {
    let (prefix, rest) = name.rsplit_once('#')?;
    let digits = rest.trim();
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let clean = prefix.trim();
    if clean.len() >= 3 {
        Some(clean.to_string())
    } else {
        None
    }
}

/// Shelves items by issuer identity (mirroring TS `groupCollectables` + `issuerPublisherRank`).
/// Verified issuer profiles come first, then Sigma signers / apps / collections, then raw issuer keys.
fn group_by_identity<'a>(
    items: &[&'a ItemCardRow],
    snap: &WalletSnapshot,
    services: &AppServices,
    chain: &str,
) -> (Vec<IdentityShelf<'a>>, Vec<&'a ItemCardRow>) {
    let mut buckets: BTreeMap<String, IdentityShelf<'a>> = BTreeMap::new();
    let mut loose = Vec::new();
    for &item in items {
        let meta = snap.item_meta.get(&item.outpoint);
        let issuer_key = item
            .issuer_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty());
        let signer = meta
            .and_then(|m| m.signer.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let app = meta
            .and_then(|m| m.app.as_deref())
            .map(str::trim)
            .filter(|a| !a.is_empty());
        let collection_id = meta
            .and_then(|m| m.collection_id.as_deref())
            .map(str::trim)
            .filter(|c| !c.is_empty());

        let shelf_spec = if let Some(key) = issuer_key {
            let prof = services.peer_identity_for(chain, key);
            let (rank, label, avatar_url) = match prof {
                Some(p) => (0u8, p.name, p.image_data_url),
                None => (3u8, format!("Issuer {}", truncate_mid(key, 10)), None),
            };
            Some((
                format!("issuer:pubkey:{}", key.to_ascii_lowercase()),
                rank,
                Some(key.to_string()),
                avatar_url,
                Some(key.to_string()),
                label,
            ))
        } else if let Some(sig) = signer {
            let label = app
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("Signed · {}", truncate_mid(sig, 10)));
            Some((
                format!("issuer:signer:{sig}"),
                2u8,
                Some(sig.to_string()),
                None,
                Some(sig.to_string()),
                label,
            ))
        } else if let Some(a) = app {
            Some((
                format!("issuer:app:{}", a.to_ascii_lowercase()),
                2u8,
                None,
                None,
                None,
                a.to_string(),
            ))
        } else if let Some(cid) = collection_id {
            let label = collection_series_stem(&item.name)
                .unwrap_or_else(|| format!("Collection {}", truncate_mid(cid, 10)));
            Some((
                format!("issuer:collection:{}", cid.to_ascii_lowercase()),
                2u8,
                None,
                None,
                None,
                label,
            ))
        } else {
            None
        };

        if let Some((key, rank, fingerprint_id, avatar_url, avatar_key, label)) = shelf_spec {
            buckets
                .entry(key.clone())
                .or_insert_with(|| IdentityShelf {
                    key,
                    rank,
                    fingerprint_id,
                    avatar_url,
                    avatar_key,
                    label,
                    items: Vec::new(),
                })
                .items
                .push(item);
        } else {
            loose.push(item);
        }
    }
    let mut shelves: Vec<IdentityShelf<'a>> = buckets.into_values().collect();
    shelves.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.label.to_ascii_lowercase().cmp(&b.label.to_ascii_lowercase()))
    });
    (shelves, loose)
}

/// Mirrors `groupQuantityLabel`: "N items" plus "N verified" when BRC-150 proven.
fn shelf_quantity_label(items: &[&ItemCardRow]) -> String {
    let verified = items
        .iter()
        .filter(|item| authenticity_display(&item.authenticity_status).1 == "brc150")
        .count();
    let count = items.len();
    let noun = if count == 1 { "item" } else { "items" };
    if verified > 0 {
        format!("{count} {noun} · {verified} verified")
    } else {
        format!("{count} {noun}")
    }
}

fn collect_grid_card(
    item: &ItemCardRow,
    art_url: Option<String>,
    is_selected: bool,
    mut nav_child: Signal<Option<NavChild>>,
    selected_outpoints: Signal<BTreeSet<String>>,
) -> Element {
    let outpoint = item.outpoint.clone();
    let outpoint_send = item.outpoint.clone();
    let outpoint_select = item.outpoint.clone();
    rsx! {
        li {
            key: "{item.outpoint}",
            class: if is_selected {
                "collection-grid-card collectable-card is-selected"
            } else {
                "collection-grid-card collectable-card"
            },
            button {
                r#type: "button",
                class: "collection-grid-main collectable-main",
                onclick: move |_| {
                    nav_child.set(Some(NavChild::CollectableDetails(outpoint.clone())));
                },
                div { class: "collectable-media",
                    span { class: "collectable-media-fallback", "aria-hidden": "true",
                        CollectablesIcon { size: 36 }
                    }
                    if let Some(art_url) = art_url {
                        img { class: "collectable-img", src: "{art_url}", alt: "{item.name}" }
                    }
                    CollectableVerifyMark {
                        authenticity_status: item.authenticity_status.clone(),
                    }
                }
                MiddleEllipsisName { class: "collection-grid-name", label: item.name.clone() }
                span { class: "collection-grid-host", "aria-hidden": "true", "\u{a0}" }
            }
            div { class: "collectable-card-actions",
                button {
                    r#type: "button",
                    class: "collectable-send-btn",
                    title: "Send {item.name}",
                    aria_label: "Send {item.name}",
                    onclick: move |_| {
                        nav_child.set(Some(NavChild::SendCollectable(outpoint_send.clone())));
                    },
                    SendIcon { size: 14 }
                    span { class: "collectable-send-label", "Send" }
                }
                CollectSelect {
                    class: "collect-select--inline",
                    checked: is_selected,
                    disabled: false,
                    label: if is_selected { format!("Deselect {}", item.name) } else { format!("Select {}", item.name) },
                    on_change: move |on: bool| set_outpoint_selected(selected_outpoints, &outpoint_select, on),
                }
            }
        }
    }
}

fn collect_list_row(
    item: &ItemCardRow,
    art_url: Option<String>,
    is_selected: bool,
    mut nav_child: Signal<Option<NavChild>>,
    selected_outpoints: Signal<BTreeSet<String>>,
) -> Element {
    let outpoint = item.outpoint.clone();
    let outpoint_send = item.outpoint.clone();
    let outpoint_select = item.outpoint.clone();
    rsx! {
        li {
            key: "{item.outpoint}",
            class: if is_selected {
                "connected-app-row collectable-row is-selected"
            } else {
                "connected-app-row collectable-row"
            },
            button {
                r#type: "button",
                class: "connected-app-main collectable-row-main",
                onclick: move |_| {
                    nav_child.set(Some(NavChild::CollectableDetails(outpoint.clone())));
                },
                div { class: "collectable-media collectable-media-sm",
                    span { class: "collectable-media-fallback", "aria-hidden": "true",
                        CollectablesIcon { size: 22 }
                    }
                    if let Some(art_url) = art_url {
                        img { class: "collectable-img", src: "{art_url}", alt: "{item.name}" }
                    }
                    CollectableVerifyMark {
                        authenticity_status: item.authenticity_status.clone(),
                    }
                }
                div { class: "connected-app-body",
                    MiddleEllipsisName { class: "connected-app-name", label: item.name.clone() }
                    span { class: "connected-app-host", "aria-hidden": "true", "\u{a0}" }
                }
            }
            div { class: "collectable-row-actions",
                button {
                    r#type: "button",
                    class: "collectable-send-btn collectable-send-btn--row",
                    title: "Send {item.name}",
                    aria_label: "Send {item.name}",
                    onclick: move |_| {
                        nav_child.set(Some(NavChild::SendCollectable(outpoint_send.clone())));
                    },
                    SendIcon { size: 14 }
                }
                CollectSelect {
                    class: "collect-select--row",
                    checked: is_selected,
                    disabled: false,
                    label: if is_selected { format!("Deselect {}", item.name) } else { format!("Select {}", item.name) },
                    on_change: move |on: bool| set_outpoint_selected(selected_outpoints, &outpoint_select, on),
                }
            }
        }
    }
}

/// The grid or list of items inside one shelf (or the "No issuer" section).
fn collect_items_list(
    items: &[&ItemCardRow],
    snap: &WalletSnapshot,
    grid: bool,
    selected_set: &BTreeSet<String>,
    nav_child: Signal<Option<NavChild>>,
    selected_outpoints: Signal<BTreeSet<String>>,
) -> Element {
    if grid {
        rsx! {
            ul { class: "collection-grid collectables-grid",
                for item in items.iter().copied() {
                    { collect_grid_card(
                        item,
                        snap.item_art.get(&item.outpoint).cloned(),
                        selected_set.contains(&item.outpoint),
                        nav_child,
                        selected_outpoints,
                    ) }
                }
            }
        }
    } else {
        rsx! {
            ul { class: "connected-app-list collectables-list",
                for item in items.iter().copied() {
                    { collect_list_row(
                        item,
                        snap.item_art.get(&item.outpoint).cloned(),
                        selected_set.contains(&item.outpoint),
                        nav_child,
                        selected_outpoints,
                    ) }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/InventoryPanel.tsx`: issuer shelves, "No issuer" section, group select.
#[component]
pub fn InventoryPanel(
    #[props(default = "main".to_string())] chain: String,
    snap: WalletSnapshot,
    view: Signal<CollectionView>,
    mut nav_child: Signal<Option<NavChild>>,
    #[props(default)] selected_outpoints_ext: Option<Signal<BTreeSet<String>>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut query = use_signal(String::new);
    let mut sort_mode = use_signal(|| CollectSortMode::Identity);
    let local_selected = use_signal(BTreeSet::<String>::new);
    let mut selected_outpoints = selected_outpoints_ext.unwrap_or(local_selected);
    let mut collapsed = use_signal(BTreeSet::<String>::new);

    // Trigger bounded background prefetch for any items missing cached local data: art.
    if !snap.items.is_empty() {
        services.prefetch_missing_item_art(&chain, &snap);
    }

    let q = query.read().trim().to_ascii_lowercase();
    let cur_view = *view.read();
    let cur_sort = *sort_mode.read();
    let selected_set = selected_outpoints.read().clone();
    let collapsed_set = collapsed.read().clone();
    let grid = cur_view == CollectionView::Grid;

    let mut filtered: Vec<&ItemCardRow> = snap
        .items
        .iter()
        .filter(|item| {
            if q.is_empty() {
                return true;
            }
            let meta = snap.item_meta.get(&item.outpoint);
            item.name.to_ascii_lowercase().contains(&q)
                || item.origin_outpoint.to_ascii_lowercase().contains(&q)
                || item.outpoint.to_ascii_lowercase().contains(&q)
                || item
                    .issuer_key
                    .as_deref()
                    .is_some_and(|k| k.to_ascii_lowercase().contains(&q))
                || meta
                    .and_then(|m| m.app.as_deref())
                    .is_some_and(|a| a.to_ascii_lowercase().contains(&q))
                || meta
                    .and_then(|m| m.collection_id.as_deref())
                    .is_some_and(|c| c.to_ascii_lowercase().contains(&q))
                || meta
                    .and_then(|m| m.signer.as_deref())
                    .is_some_and(|s| s.to_ascii_lowercase().contains(&q))
        })
        .collect();
    match cur_sort {
        CollectSortMode::Name => {
            filtered.sort_by_key(|a| a.name.to_ascii_lowercase());
        }
        CollectSortMode::Recent => {
            filtered.sort_by_key(|a| std::cmp::Reverse(a.sort_key));
        }
        CollectSortMode::Identity => {}
    }
    let (shelves, ungrouped) = if cur_sort == CollectSortMode::Identity {
        group_by_identity(&filtered, &snap, &services, &chain)
    } else {
        (Vec::new(), filtered.clone())
    };

    rsx! {
        div {
            class: "nav-section-body nav-section-with-scroll",
            "data-aeon-scope": "collectables",
            "data-aeon-state": cur_view.as_str(),
            "data-view": cur_view.as_str(),

            div { class: "connected-panel-head",
                h2 { "Collect" }
                if !snap.items.is_empty() {
                    div { class: "collectables-toolbar",
                        div { class: "field collectables-search-field",
                            input {
                                id: "collectables-search-input",
                                r#type: "search",
                                aria_label: "Search collectables by name, trait or id",
                                placeholder: "Name, trait or id",
                                value: "{query}",
                                oninput: move |e| query.set(e.value()),
                            }
                        }
                        div {
                            class: "collectables-sort-group",
                            role: "group",
                            aria_label: "Sort collectables",
                            for mode in CollectSortMode::ALL {
                                button {
                                    key: "{mode.label()}",
                                    r#type: "button",
                                    class: "collectables-sort-btn",
                                    aria_pressed: cur_sort == mode,
                                    onclick: move |_| sort_mode.set(mode),
                                    "{mode.label()}"
                                }
                            }
                        }
                        CollectionViewToggle { view }
                    }
                }
            }

            if snap.items.is_empty() {
                EmptyState {
                    icon: Some(rsx! { CollectablesIcon { size: 28 } }),
                    title: "No collectables here",
                    body: Some("Items and tokens sent to this wallet show up here.".into()),
                }
            } else {
                div { class: "nav-section-scroll-body",
                    if filtered.is_empty() {
                        div { class: "friends-empty",
                            strong { "No collectables found" }
                            span { "Try another name, trait, origin, or id." }
                        }
                    } else {
                        section { class: "collect-items-section", aria_label: "Issuers and items",
                            for shelf in shelves.iter() {
                                {
                                    let open = !collapsed_set.contains(&shelf.key);
                                    let shelf_selected = shelf
                                        .items
                                        .iter()
                                        .filter(|item| selected_set.contains(&item.outpoint))
                                        .count();
                                    let all_selected = shelf_selected == shelf.items.len();
                                    let shelf_outpoints: Vec<String> =
                                        shelf.items.iter().map(|item| item.outpoint.clone()).collect();
                                    let toggle_key = shelf.key.clone();
                                    let meta = if shelf_selected > 0 {
                                        format!("{} · {shelf_selected} selected", shelf_quantity_label(&shelf.items))
                                    } else {
                                        shelf_quantity_label(&shelf.items)
                                    };
                                    rsx! {
                                        div { class: "collect-collection", key: "{shelf.key}",
                                            div { class: "collect-collection-head",
                                                button {
                                                    r#type: "button",
                                                    class: "collect-collection-trigger",
                                                    "aria-expanded": "{open}",
                                                    onclick: move |_| {
                                                        let mut next = collapsed.read().clone();
                                                        if !next.remove(&toggle_key) {
                                                            next.insert(toggle_key.clone());
                                                        }
                                                        collapsed.set(next);
                                                    },
                                                    span { class: "collect-collection-body",
                                                        strong { class: "collect-collection-name", style: "display: inline-flex; align-items: center; gap: 6px;",
                                                            if shelf.avatar_url.is_some() || shelf.avatar_key.is_some() {
                                                                ProfileAvatar {
                                                                    label: shelf.label.clone(),
                                                                    image_url: shelf.avatar_url.clone(),
                                                                    identity_key: shelf.avatar_key.clone(),
                                                                }
                                                            }
                                                            span { class: "collect-collection-name-text", "{shelf.label}" }
                                                            if let Some(ref fp_id) = shelf.fingerprint_id {
                                                                ProfileFingerprint { id: fp_id.clone() }
                                                            }
                                                        }
                                                        span { class: "collect-collection-meta", "{meta}" }
                                                    }
                                                    span { class: "collect-collection-indicator", "aria-hidden": "true",
                                                        ExpandMoreIcon { size: 20 }
                                                    }
                                                }
                                                CollectSelect {
                                                    class: "collect-select--group",
                                                    checked: all_selected,
                                                    disabled: false,
                                                    label: if all_selected { format!("Deselect {}", shelf.label) } else { format!("Select {}", shelf.label) },
                                                    on_change: move |on: bool| {
                                                        let mut next = selected_outpoints.read().clone();
                                                        for outpoint in &shelf_outpoints {
                                                            if on {
                                                                next.insert(outpoint.clone());
                                                            } else {
                                                                next.remove(outpoint);
                                                            }
                                                        }
                                                        selected_outpoints.set(next);
                                                    },
                                                }
                                            }
                                            if open {
                                                div { class: "collect-collection-body-content",
                                                    {collect_items_list(&shelf.items, &snap, grid, &selected_set, nav_child, selected_outpoints)}
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !ungrouped.is_empty() {
                                section { class: "collect-nested-collection",
                                    if !shelves.is_empty() {
                                        h3 { class: "collect-section-title", "No identity" }
                                    }
                                    {collect_items_list(&ungrouped, &snap, grid, &selected_set, nav_child, selected_outpoints)}
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
    let current_explorer_url =
        txid_from_outpoint(&item.outpoint).map(|tx| tx_explorer_url(tx, &chain));
    let svc_verify = Arc::clone(&services);
    let origin_copy = item.origin_outpoint.clone();
    let outpoint_copy = item.outpoint.clone();
    let group_label = item_group_label(&item);

    rsx! {
        div {
            class: "nav-child-panel collectable-details",
            "data-aeon-scope": "collectable-details",
            "data-aeon-state": "{auth_tone}",

            div { class: "collectable-details-showcase",
                div { class: "collectable-media collectable-details-media",
                    span { class: "collectable-media-fallback", aria_hidden: true,
                        CollectablesIcon { size: 56 }
                    }
                    if let Some(art_url) = snap.item_art.get(&item.outpoint) {
                        img {
                            class: "collectable-img",
                            src: "{art_url}",
                            alt: "{item.name}",
                        }
                    }
                    CollectableVerifyMark {
                        authenticity_status: item.authenticity_status.clone(),
                    }
                }
            }

            div { class: "payment-details-hero",
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
                    div { class: "collectable-details-subrow",
                        span { class: "collectable-auth-pill", "data-tone": "{auth_tone}", "{auth_label}" }
                        span { class: "history-when", "· {group_label}" }
                    }
                }
            }

            if let Some(ref reason) = item.authenticity_reason {
                p { class: "settings-row-desc", "{reason}" }
            } else if auth_tone == "brc150" {
                p { class: "settings-row-desc",
                    "Verified local BRC-150 v2 ancestry: exact parent spend, 1-sat continuity, AtomicBEEF subject, and origin ord envelope."
                }
            } else {
                p { class: "settings-row-desc",
                    "Indexer or marker-only identity stays unverified until a complete BRC-150 ancestry proof is verified locally."
                }
            }

            dl { class: "payment-details-meta",
                dt { "Collection" }
                dd { "{group_label}" }

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
                    div { style: "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;",
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
                        if let Some(ref cur_url) = current_explorer_url {
                            {
                                let u = cur_url.clone();
                                rsx! {
                                    button {
                                        r#type: "button",
                                        class: "payment-details-woc",
                                        onclick: move |_| {
                                            let _ = open_external_url(&u);
                                        },
                                        LaunchIcon { size: 12 }
                                        span { "Tx" }
                                    }
                                }
                            }
                        }
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
