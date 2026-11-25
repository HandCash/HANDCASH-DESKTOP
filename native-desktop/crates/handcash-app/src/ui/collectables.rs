// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop collectables & assets surfaces:
//! - `src/components/InventoryPanel.tsx`
//! - `src/components/CollectionViewToggle.tsx`
//! - `src/components/CollectableVerifyMark.tsx`
//! - `src/components/IssuerIdentityMark.tsx` (+ `AssetIssuers.tsx`)
//! - `src/components/CollectFacepile.tsx`
//! - `src/components/CollectableDetailsPanel.tsx`
//! - `src/components/SendCollectablePanel.tsx`
//! - `src/components/BurnAssetPanel.tsx`

use crate::icons::{
    CheckIcon, CollectablesIcon, ExpandMoreIcon, FireIcon, SendIcon, VerifiedIcon, ViewGridIcon,
    ViewListIcon, WarningIcon,
};
use crate::machines::{classify_recipient, CollectionView, NavChild, RecipientKind, ToastNotice};
use crate::state::{copy_to_clipboard, truncate_mid, AppServices, WalletSnapshot};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use crate::ui::primitives::{
    profile_fingerprint, MiddleEllipsisName, ProfileAvatar, ProfileFingerprint, ProfileIdenticon,
};
use crate::ui::EmptyState;
use aeon_dioxus::use_aeon_machine;
use base64::Engine as _;
use dioxus::prelude::*;
use handcash_machines::asset_burn_ui::{
    AssetBurnUiEvent, AssetBurnUiMachine, AssetBurnUiState,
};
use handcash_machines::asset_send::{AssetSendEvent, AssetSendMachine, AssetSendState};
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

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// `toLocaleString()` for sat counts.
fn group_thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn toast_copy(mut toast: Signal<Option<ToastNotice>>, title: &str, value: &str) {
    match copy_to_clipboard(value) {
        Ok(()) => toast.set(Some(ToastNotice {
            title: title.to_string(),
            body: Some(truncate_mid(value, 12)),
            tone: "success",
        })),
        Err(e) => toast.set(Some(ToastNotice {
            title: "Copy failed".into(),
            body: Some(e),
            tone: "error",
        })),
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

// ---------------------------------------------------------------------------
// Issuer identity (IssuerIdentityMark.tsx / AssetIssuers.tsx)
// ---------------------------------------------------------------------------

/// TS `IssuerView`: who issued an asset — BAP profile, signing key, or unsigned claim.
#[derive(Clone, Debug, PartialEq)]
pub struct IssuerView {
    pub identity_key: String,
    pub label: String,
    /// TS `issuerViewState`: listed | imitation | shared-name | verified | unconfirmed | key | claim.
    pub state: &'static str,
    pub profile_id: Option<String>,
    pub image_url: Option<String>,
    pub issuer_attested: bool,
}

impl IssuerView {
    /// TS `issuerTrustNote` + `issuerViewTitle`.
    fn title(&self) -> String {
        match self.profile_id {
            Some(ref id) => {
                let head = if self.state == "unconfirmed" {
                    format!("Profile ID {id}")
                } else {
                    format!("{} · Profile ID {id}", self.label)
                };
                let note = match self.state {
                    "unconfirmed" => "No identity package on this device proves this signer speaks for the profile ID, so its name and image stay hidden.",
                    "listed" => "Verified by HandCash.",
                    _ => "Its identity package proves the signer. Not on HandCash’s verified list; compare the profile ID.",
                };
                format!("{head} · {note}")
            }
            None if self.issuer_attested => format!("Signed by {}", self.identity_key),
            None => format!("Unsigned issuer claim {}", self.identity_key),
        }
    }
}

/// TS `useIssuerView` for one asset: issuer key (or Sigma signer) resolved against known profiles,
/// BAP packages, identity cards, and HandCash's signed verified-issuer list.
fn issuer_view_for(
    item: &ItemCardRow,
    snap: &WalletSnapshot,
    services: &AppServices,
    chain: &str,
) -> Option<IssuerView> {
    let meta = snap.item_meta.get(&item.outpoint);
    let attested = meta.is_some_and(|m| m.issuer_attested);
    let bap_id = non_empty(meta.and_then(|m| m.bap_id.as_deref()));
    if let Some(key) = non_empty(item.issuer_key.as_deref()) {
        let resolved = services.resolve_issuer_display(chain, key, bap_id, attested);
        return Some(IssuerView {
            identity_key: resolved.identity_key,
            label: resolved.label,
            state: resolved.state,
            profile_id: resolved.profile_id,
            image_url: resolved.image_url,
            issuer_attested: resolved.issuer_attested,
        });
    }
    // Legacy HandCash cloud-minted items carry a Sigma BSM address + MAP app name (no BRC-247 pubkey).
    let signer = non_empty(meta.and_then(|m| m.signer.as_deref()))?;
    let app = non_empty(meta.and_then(|m| m.app.as_deref()));
    Some(IssuerView {
        identity_key: signer.to_string(),
        label: app
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("Signed · {}", truncate_mid(signer, 10))),
        state: if attested { "key" } else { "claim" },
        profile_id: None,
        image_url: None,
        issuer_attested: attested,
    })
}

/// 1:1 port of `IssuerTrustBadge`: the checkmark or caution after an issuer name.
#[component]
pub fn IssuerTrustBadge(state: &'static str) -> Element {
    match state {
        "listed" => rsx! {
            span {
                class: "issuer-trust-badge",
                "data-aeon-part": "issuer-trust",
                "data-aeon-state": state,
                role: "img",
                aria_label: "Verified by HandCash",
                VerifiedIcon { size: 15 }
            }
        },
        "imitation" | "shared-name" => rsx! {
            span {
                class: "issuer-trust-badge",
                "data-aeon-part": "issuer-trust",
                "data-aeon-state": state,
                role: "img",
                aria_label: if state == "imitation" { "Looks like a verified issuer" } else { "Name shared with another identity" },
                WarningIcon { size: 15 }
            }
        },
        _ => rsx! {},
    }
}

/// 1:1 port of `src/components/IssuerIdentityMark.tsx`.
#[component]
pub fn IssuerIdentityMark(view: IssuerView, #[props(default)] class: Option<String>) -> Element {
    let class = match class {
        Some(c) => format!("identity-pill {c}"),
        None => "identity-pill".to_string(),
    };
    let title = view.title();
    let short = view
        .profile_id
        .as_deref()
        .filter(|_| matches!(view.state, "listed" | "imitation" | "shared-name" | "verified"))
        .map(|id| profile_fingerprint(id).short);
    rsx! {
        span {
            class: "{class}",
            "data-aeon-part": "issuer",
            "data-aeon-state": view.state,
            title: "{title}",
            if let Some(ref src) = view.image_url {
                span { class: "identity-pill-lead",
                    img { class: "identity-pill-image", src: "{src}", alt: "", width: 16, height: 16 }
                }
            } else if let Some(ref id) = view.profile_id {
                span { class: "identity-pill-lead",
                    ProfileIdenticon { id: id.clone(), size: 10 }
                }
            }
            span { class: "identity-pill-label", "{view.label}" }
            IssuerTrustBadge { state: view.state }
            if let Some(short) = short {
                span { class: "identity-pill-id mono", "{short}" }
            }
        }
    }
}

const ISSUERS_SHOWN: usize = 3;

/// 1:1 port of `src/components/AssetIssuers.tsx`.
#[component]
fn AssetIssuers(views: Vec<IssuerView>) -> Element {
    let mut seen = BTreeSet::new();
    let views: Vec<IssuerView> = views
        .into_iter()
        .filter(|v| seen.insert(v.identity_key.to_ascii_lowercase()))
        .collect();
    if views.is_empty() {
        return rsx! {};
    }
    let hidden = views.len().saturating_sub(ISSUERS_SHOWN);
    rsx! {
        span {
            class: "asset-issuers",
            "data-aeon-part": "asset-issuers",
            "data-aeon-state": if hidden > 0 { "overflow" } else { "all" },
            for view in views.into_iter().take(ISSUERS_SHOWN) {
                IssuerIdentityMark { key: "{view.identity_key}", view }
            }
            if hidden > 0 {
                span { class: "asset-issuers-more", "+{hidden} more" }
            }
        }
    }
}

const FACE_LIMIT: usize = 4;

/// 1:1 port of `src/components/CollectFacepile.tsx`.
#[component]
fn CollectFacepile(faces: Vec<(String, Option<String>)>) -> Element {
    rsx! {
        span { class: "collect-facepile", "aria-hidden": "true",
            for (outpoint, image) in faces.into_iter().take(FACE_LIMIT) {
                span { key: "{outpoint}", class: "collect-facepile-face",
                    if let Some(src) = image {
                        img { src: "{src}", alt: "", width: 36, height: 36, decoding: "async" }
                    } else {
                        span { class: "collectable-media-fallback", "aria-hidden": "true",
                            CollectablesIcon { size: 16 }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// InventoryPanel.tsx
// ---------------------------------------------------------------------------

/// Collect's select box, 1:1 port of `src/components/SelectionCheckbox.tsx`.
#[component]
fn CollectSelect(
    checked: bool,
    disabled: bool,
    #[props(default)] mixed: bool,
    label: String,
    class: &'static str,
    on_change: EventHandler<bool>,
) -> Element {
    rsx! {
        label {
            class: "collect-select {class}",
            title: "{label}",
            "data-state": if mixed { "indeterminate" } else if checked { "checked" } else { "unchecked" },
            onclick: move |evt| evt.stop_propagation(),
            input {
                r#type: "checkbox",
                checked: checked,
                disabled: disabled,
                aria_label: "{label}",
                aria_checked: if mixed { "mixed" } else if checked { "true" } else { "false" },
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

/// One shelf per issuer identity (verified issuer profile -> signer -> app -> collection -> unverified key).
struct IdentityShelf<'a> {
    key: String,
    rank: u8,
    fingerprint_id: Option<String>,
    avatar_url: Option<String>,
    avatar_key: Option<String>,
    label: String,
    /// TS `issuerViewState` for the trust badge.
    trust_state: &'static str,
    /// Hover title on the shelf name.
    title: String,
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
        let issuer_key = non_empty(item.issuer_key.as_deref());
        let signer = non_empty(meta.and_then(|m| m.signer.as_deref()));
        let app = non_empty(meta.and_then(|m| m.app.as_deref()));
        let collection_id = non_empty(meta.and_then(|m| m.collection_id.as_deref()));
        let attested = meta.is_some_and(|m| m.issuer_attested);

        let bap_id = non_empty(meta.and_then(|m| m.bap_id.as_deref()));

        let shelf = if let Some(key) = issuer_key {
            let resolved = services.resolve_issuer_display(chain, key, bap_id, attested);
            let rank = match resolved.state {
                "listed" => 0u8,
                "verified" | "imitation" | "shared-name" => 1u8,
                "key" => 2u8,
                _ => 3u8,
            };
            let label = if matches!(resolved.state, "key" | "claim") {
                format!("Issuer {}", resolved.label)
            } else {
                resolved.label.clone()
            };
            Some(IdentityShelf {
                key: format!("issuer:pubkey:{}", resolved.identity_key.to_ascii_lowercase()),
                rank,
                fingerprint_id: resolved.profile_id.clone().or_else(|| Some(resolved.identity_key.clone())),
                avatar_url: resolved.image_url,
                avatar_key: Some(resolved.identity_key.clone()),
                title: format!("{label} · issuer attribution: {}", resolved.identity_key),
                label,
                trust_state: resolved.state,
                items: Vec::new(),
            })
        } else if let Some(sig) = signer {
            let label = app
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("Signed · {}", truncate_mid(sig, 10)));
            Some(IdentityShelf {
                key: format!("issuer:signer:{sig}"),
                rank: 2,
                fingerprint_id: Some(sig.to_string()),
                avatar_url: None,
                avatar_key: Some(sig.to_string()),
                title: format!("{label} · signed by {sig}, as the index reports it"),
                label,
                trust_state: if attested { "key" } else { "claim" },
                items: Vec::new(),
            })
        } else if let Some(a) = app {
            Some(IdentityShelf {
                key: format!("issuer:app:{}", a.to_ascii_lowercase()),
                rank: 2,
                fingerprint_id: None,
                avatar_url: None,
                avatar_key: None,
                title: a.to_string(),
                label: a.to_string(),
                trust_state: "claim",
                items: Vec::new(),
            })
        } else if let Some(cid) = collection_id {
            let label = collection_series_stem(&item.name)
                .unwrap_or_else(|| format!("Collection {}", truncate_mid(cid, 10)));
            Some(IdentityShelf {
                key: format!("issuer:collection:{}", cid.to_ascii_lowercase()),
                rank: 2,
                fingerprint_id: None,
                avatar_url: None,
                avatar_key: None,
                title: label.clone(),
                label,
                trust_state: "claim",
                items: Vec::new(),
            })
        } else {
            None
        };

        match shelf {
            Some(shelf) => {
                let entry = buckets.entry(shelf.key.clone()).or_insert(shelf);
                // If an earlier item in the same Sigma signer shelf lacked an app label, adopt it from a later item.
                if entry.label.starts_with("Signed · ") {
                    if let Some(a) = app {
                        entry.label = a.to_string();
                        if let Some(sig) = signer {
                            entry.title = format!("{a} · signed by {sig}, as the index reports it");
                        }
                    }
                }
                entry.items.push(item);
            }
            None => loose.push(item),
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

/// A nested collection: id, display name, and its items.
type NestedCollection<'a> = (String, String, Vec<&'a ItemCardRow>);

/// Splits a shelf into its nested collections (by `collection_id`) and the uncollected rest.
fn nested_collections<'a>(
    items: &[&'a ItemCardRow],
    snap: &WalletSnapshot,
) -> (Vec<NestedCollection<'a>>, Vec<&'a ItemCardRow>) {
    let mut by_id: BTreeMap<String, Vec<&'a ItemCardRow>> = BTreeMap::new();
    let mut loose = Vec::new();
    for &item in items {
        let cid = non_empty(
            snap.item_meta
                .get(&item.outpoint)
                .and_then(|m| m.collection_id.as_deref()),
        );
        match cid {
            Some(cid) => by_id.entry(cid.to_string()).or_default().push(item),
            None => loose.push(item),
        }
    }
    let mut collections: Vec<(String, String, Vec<&'a ItemCardRow>)> = by_id
        .into_iter()
        .map(|(cid, members)| {
            let label = members
                .first()
                .and_then(|first| collection_series_stem(&first.name))
                .unwrap_or_else(|| format!("Collection {}", truncate_mid(&cid, 10)));
            (cid, label, members)
        })
        .collect();
    collections.sort_by_key(|(_, label, _)| label.to_ascii_lowercase());
    (collections, loose)
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

/// The grid or list of items inside one shelf section (or the "No issuer" section).
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

fn item_matches(item: &ItemCardRow, snap: &WalletSnapshot, q: &str) -> bool {
    if q.is_empty() {
        return true;
    }
    let has = |s: &str| s.to_ascii_lowercase().contains(q);
    let meta = snap.item_meta.get(&item.outpoint);
    has(&item.name)
        || has(&item.origin_outpoint)
        || has(&item.outpoint)
        || item.issuer_key.as_deref().is_some_and(has)
        || meta.is_some_and(|m| {
            m.app.as_deref().is_some_and(has)
                || m.collection_id.as_deref().is_some_and(has)
                || m.signer.as_deref().is_some_and(has)
                || m.bap_id.as_deref().is_some_and(has)
                || m.traits.iter().any(|(k, v)| has(k) || has(v))
        })
}

/// 1:1 port of `src/components/InventoryPanel.tsx`: issuer shelves (accordion, one open),
/// nested collections, "No issuer" section, group select and the selection dock.
#[component]
pub fn InventoryPanel(
    #[props(default = "main".to_string())] chain: String,
    snap: WalletSnapshot,
    view: Signal<CollectionView>,
    mut nav_child: Signal<Option<NavChild>>,
    #[props(default)] selected_outpoints_ext: Option<Signal<BTreeSet<String>>>,
    #[props(default)] dock_spec: Option<Signal<Option<DockSpec>>>,
    #[props(default)] dock_trigger: Option<Signal<DockTrigger>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut query = use_signal(String::new);
    let local_selected = use_signal(BTreeSet::<String>::new);
    let mut selected_outpoints = selected_outpoints_ext.unwrap_or(local_selected);
    let mut open_shelf = use_signal(|| Option::<String>::None);
    let mut last_seq = use_signal(|| dock_trigger.map(|t| t.read().seq).unwrap_or_default());

    // Trigger bounded background prefetch for any items missing cached local data: art,
    // origin/signer metadata from GorillaPool (TS `originSigners.ts`), and rate-limited peer sync.
    if !snap.items.is_empty() {
        services.prefetch_missing_item_art(&chain, &snap);
        services.backfill_missing_inscription_metadata(&chain, &snap);
        services.maybe_sync_missing_identities_from_peers(&chain, &snap);
    }

    // Drop selections whose items left the wallet.
    {
        let held: BTreeSet<&str> = snap.items.iter().map(|i| i.outpoint.as_str()).collect();
        let stale = selected_outpoints
            .peek()
            .iter()
            .any(|op| !held.contains(op.as_str()));
        if stale {
            let kept = selected_outpoints
                .peek()
                .iter()
                .filter(|op| held.contains(op.as_str()))
                .cloned()
                .collect();
            selected_outpoints.set(kept);
        }
    }

    let selected_set = selected_outpoints.read().clone();

    // Selection dock: Cancel · Burn (N) · Send (N).
    if let Some(mut dock) = dock_spec {
        let desired = if selected_set.is_empty() {
            None
        } else {
            let n = selected_set.len();
            Some(DockSpec::three(
                "Selected collectables",
                DockActionSpec::new(
                    "cancel-selection",
                    "Cancel",
                    ActionTone::Secondary,
                    ActionIcon::Close,
                ),
                DockActionSpec::new_owned(
                    "burn-selected",
                    format!("Burn ({n})"),
                    ActionTone::Danger,
                    ActionIcon::Fire,
                ),
                DockActionSpec::new_owned(
                    "send-selected",
                    format!("Send ({n})"),
                    ActionTone::Primary,
                    ActionIcon::Send,
                ),
            ))
        };
        if *dock.peek() != desired {
            dock.set(desired);
        }
    }
    use_effect(move || {
        let Some(trigger) = dock_trigger else {
            return;
        };
        let trig = *trigger.read();
        if trig.seq == *last_seq.peek() {
            return;
        }
        last_seq.set(trig.seq);
        let all: Vec<String> = selected_outpoints.peek().iter().cloned().collect();
        match trig.action_id {
            "cancel-selection" => selected_outpoints.set(BTreeSet::new()),
            "burn-selected" if !all.is_empty() => {
                nav_child.set(Some(NavChild::BurnCollectables(all)))
            }
            "send-selected" if !all.is_empty() => {
                nav_child.set(Some(NavChild::SendCollectables(all)))
            }
            _ => {}
        }
    });

    let q = query.read().trim().to_ascii_lowercase();
    let cur_view = *view.read();
    let grid = cur_view == CollectionView::Grid;
    let open_key = open_shelf.read().clone();

    let filtered: Vec<&ItemCardRow> = snap
        .items
        .iter()
        .filter(|item| item_matches(item, &snap, &q))
        .collect();
    let (shelves, ungrouped) = group_by_identity(&filtered, &snap, &services, &chain);

    rsx! {
        div {
            class: "nav-section-body nav-section-with-scroll",
            "data-aeon-scope": "collectables",
            "data-aeon-state": "view",
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
                            div { class: "collect-collections",
                                for shelf in shelves.iter() {
                                    {
                                        let open = open_key.as_deref() == Some(shelf.key.as_str());
                                        let shelf_selected = shelf
                                            .items
                                            .iter()
                                            .filter(|item| selected_set.contains(&item.outpoint))
                                            .count();
                                        let all_selected = shelf_selected == shelf.items.len();
                                        let some_selected = shelf_selected > 0 && !all_selected;
                                        let shelf_outpoints: Vec<String> =
                                            shelf.items.iter().map(|item| item.outpoint.clone()).collect();
                                        let toggle_key = shelf.key.clone();
                                        let faces: Vec<(String, Option<String>)> = shelf
                                            .items
                                            .iter()
                                            .take(FACE_LIMIT)
                                            .map(|item| (item.outpoint.clone(), snap.item_art.get(&item.outpoint).cloned()))
                                            .collect();
                                        let (collections, uncollected) = nested_collections(&shelf.items, &snap);
                                        rsx! {
                                            div {
                                                class: "collect-collection",
                                                key: "{shelf.key}",
                                                "data-state": if open { "open" } else { "closed" },
                                                "data-selected": if all_selected { Some("all") } else if some_selected { Some("some") } else { None },
                                                div { class: "collect-collection-head",
                                                    button {
                                                        r#type: "button",
                                                        class: "collect-collection-trigger",
                                                        "aria-expanded": "{open}",
                                                        onclick: move |_| {
                                                            let next = if open_shelf.peek().as_deref() == Some(toggle_key.as_str()) {
                                                                None
                                                            } else {
                                                                Some(toggle_key.clone())
                                                            };
                                                            open_shelf.set(next);
                                                        },
                                                        if shelf.avatar_url.is_some() {
                                                            ProfileAvatar {
                                                                label: shelf.label.clone(),
                                                                image_url: shelf.avatar_url.clone(),
                                                                identity_key: shelf.avatar_key.clone(),
                                                            }
                                                        } else {
                                                            CollectFacepile { faces }
                                                        }
                                                        span { class: "collect-collection-body",
                                                            strong {
                                                                class: "collect-collection-name",
                                                                "data-aeon-state": shelf.trust_state,
                                                                title: "{shelf.title}",
                                                                span { class: "collect-collection-name-text", "{shelf.label}" }
                                                                IssuerTrustBadge { state: shelf.trust_state }
                                                            }
                                                            span { class: "collect-collection-meta",
                                                                if let Some(ref fp_id) = shelf.fingerprint_id {
                                                                    ProfileFingerprint { id: fp_id.clone(), class: Some("collect-issuer-fingerprint".to_string()) }
                                                                }
                                                                "{shelf_quantity_label(&shelf.items)}"
                                                                if shelf_selected > 0 {
                                                                    " · {shelf_selected} selected"
                                                                }
                                                            }
                                                        }
                                                        span { class: "collect-collection-indicator", "aria-hidden": "true",
                                                            ExpandMoreIcon { size: 20 }
                                                        }
                                                    }
                                                    CollectSelect {
                                                        class: "collect-select--group",
                                                        checked: all_selected,
                                                        mixed: some_selected,
                                                        disabled: shelf.items.is_empty(),
                                                        label: if all_selected { format!("Deselect {}", shelf.label) } else { format!("Select {}", shelf.label) },
                                                        on_change: move |_on: bool| {
                                                            let mut next = selected_outpoints.peek().clone();
                                                            let select = !shelf_outpoints.iter().all(|op| next.contains(op));
                                                            for outpoint in &shelf_outpoints {
                                                                if select {
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
                                                        for (cid, label, members) in collections.iter() {
                                                            section { class: "collect-nested-collection", key: "{cid}",
                                                                h4 { class: "collect-section-title collect-nested-title", "{label}" }
                                                                {collect_items_list(members, &snap, grid, &selected_set, nav_child, selected_outpoints)}
                                                            }
                                                        }
                                                        if !uncollected.is_empty() {
                                                            section { class: "collect-nested-collection",
                                                                if !collections.is_empty() {
                                                                    h4 { class: "collect-section-title collect-nested-title", "Uncollected" }
                                                                }
                                                                {collect_items_list(&uncollected, &snap, grid, &selected_set, nav_child, selected_outpoints)}
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !ungrouped.is_empty() {
                                if !shelves.is_empty() {
                                    h3 { class: "collect-section-title", "No issuer" }
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

// ---------------------------------------------------------------------------
// CollectableDetailsPanel.tsx
// ---------------------------------------------------------------------------

/// Plain-markup port of the Aeon `MetricStrip` used for Traits / Details.
#[component]
fn TraitStrip(title: &'static str, rows: Vec<(String, String)>) -> Element {
    if rows.is_empty() {
        return rsx! {};
    }
    rsx! {
        div { class: "collectable-traits",
            span { class: "field-static-label", "{title}" }
            div { class: "collectable-trait-strip", "data-aeon-part": "root",
                for (i, (label, value)) in rows.into_iter().enumerate() {
                    div { key: "{i}", "data-aeon-part": "chip",
                        span { "data-aeon-part": "value", title: "{value}", "{value}" }
                        span { "data-aeon-part": "label", "{label}" }
                    }
                }
            }
        }
    }
}

/// TS `MetaRow`: label + click-to-copy mono value.
#[component]
fn MetaRow(label: &'static str, value: String, toast: Signal<Option<ToastNotice>>) -> Element {
    let title = format!("Click to copy {}\n{value}", label.to_ascii_lowercase());
    let shown = truncate_mid(&value, 14);
    rsx! {
        dt { "{label}" }
        dd {
            button {
                r#type: "button",
                class: "mono collectable-meta-copy",
                title: "{title}",
                onclick: move |_| toast_copy(toast, &format!("{label} copied"), &value),
                "{shown}"
            }
        }
    }
}

fn data_url_bytes(url: &str) -> Option<(String, Vec<u8>)> {
    let rest = url.strip_prefix("data:")?;
    let (head, body) = rest.split_once(',')?;
    let mime = head.split(';').next().unwrap_or("").to_string();
    if !head.ends_with(";base64") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(body).ok()?;
    Some((mime, bytes))
}

fn image_extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "bin",
    }
}

fn safe_file_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let stem = stem.trim_matches('-');
    if stem.is_empty() {
        "collectable".to_string()
    } else {
        stem.to_string()
    }
}

/// Saves a data-URL image through the native save dialog.
fn save_image(art_url: String, name: String, mut toast: Signal<Option<ToastNotice>>) {
    let Some((mime, bytes)) = data_url_bytes(&art_url) else {
        toast.set(Some(ToastNotice {
            title: "Save failed".into(),
            body: Some("This image is not stored locally yet.".into()),
            tone: "error",
        }));
        return;
    };
    let ext = image_extension(&mime);
    let file_name = format!("{}.{ext}", safe_file_stem(&name));
    spawn(async move {
        let Some(handle) = rfd::AsyncFileDialog::new()
            .add_filter("Image", &[ext])
            .set_file_name(&file_name)
            .save_file()
            .await
        else {
            return;
        };
        match std::fs::write(handle.path(), &bytes) {
            Ok(()) => toast.set(Some(ToastNotice {
                title: "Image saved".into(),
                body: Some(file_name),
                tone: "success",
            })),
            Err(e) => toast.set(Some(ToastNotice {
                title: "Save failed".into(),
                body: Some(e.to_string()),
                tone: "error",
            })),
        }
    });
}

/// 1:1 port of `src/components/CollectableDetailsPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn CollectableDetailsPanel(
    outpoint: String,
    chain: String,
    snap: WalletSnapshot,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let item = snap.items.iter().find(|i| i.outpoint == outpoint).cloned();
    let art_url = item
        .as_ref()
        .and_then(|i| snap.item_art.get(&i.outpoint).cloned());

    let desired_dock = item.as_ref().map(|_| {
        let burn = DockActionSpec::new("burn", "Burn item", ActionTone::Danger, ActionIcon::Fire)
            .short_label("Burn");
        let send = DockActionSpec::new("send", "Send item", ActionTone::Primary, ActionIcon::Send)
            .short_label("Send");
        if art_url.is_some() {
            DockSpec::three(
                "Collectable actions",
                burn,
                DockActionSpec::new(
                    "save-image",
                    "Save image",
                    ActionTone::Secondary,
                    ActionIcon::Download,
                )
                .short_label("Save"),
                send,
            )
        } else {
            DockSpec {
                aria_label: "Collectable actions",
                secondary: Some(burn),
                primary: send,
            }
        }
    });
    if *dock_spec.peek() != desired_dock {
        dock_spec.set(desired_dock);
    }

    {
        let out = outpoint.clone();
        let art = art_url.clone();
        let name = item.as_ref().map(|i| i.name.clone()).unwrap_or_default();
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.peek() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "burn" => nav_child.set(Some(NavChild::BurnAsset(out.clone()))),
                "send" => nav_child.set(Some(NavChild::SendCollectable(out.clone()))),
                "save-image" => {
                    if let Some(ref a) = art {
                        save_image(a.clone(), name.clone(), toast);
                    }
                }
                _ => {}
            }
        });
    }

    let Some(item) = item else {
        return rsx! {
            div {
                class: "nav-child-panel collectable-details",
                "data-aeon-scope": "collectable-details",
                "data-aeon-state": "missing",
                EmptyState {
                    icon: Some(rsx! { CollectablesIcon { size: 28 } }),
                    title: "Item unavailable",
                    body: Some("This collectable is no longer in the wallet or could not be loaded.".into()),
                }
            }
        };
    };

    let meta = snap.item_meta.get(&item.outpoint).cloned().unwrap_or_default();
    let issuer = issuer_view_for(&item, &snap, &services, &chain);
    let (auth_label, auth_tone) = authenticity_display(&item.authenticity_status);
    let reason = non_empty(item.authenticity_reason.as_deref()).map(ToString::to_string);
    let auth_title = match (auth_tone, item.authenticity_status.trim()) {
        ("brc150", _) => "BRC-150 tip-to-origin lineage verified".to_string(),
        (_, "invalid") => format!(
            "BRC-150 lineage {}",
            reason.clone().unwrap_or_else(|| "could not be verified".into())
        ),
        _ => match reason {
            Some(ref r) => format!("Not proven yet — {r}"),
            None => {
                "Identity is a chain/indexer claim and has not been cryptographically proven"
                    .to_string()
            }
        },
    };

    let mut details: Vec<(String, String)> = Vec::new();
    if let Some(app) = non_empty(meta.app.as_deref()) {
        details.push(("App".into(), app.to_string()));
    }
    if let Some(t) = non_empty(meta.item_type.as_deref()) {
        details.push(("Type".into(), t.to_string()));
    }
    if let Some(t) = non_empty(meta.sub_type.as_deref()) {
        details.push(("Subtype".into(), t.to_string()));
    }
    if !item.mime.trim().is_empty() {
        details.push(("MIME".into(), item.mime.clone()));
    }
    details.extend(meta.extras.iter().cloned());

    let issuer_key = non_empty(item.issuer_key.as_deref())
        .or_else(|| non_empty(meta.signer.as_deref()))
        .map(ToString::to_string);
    let issuer_label: &'static str = if meta.issuer_attested {
        "Issuer"
    } else {
        "Issuer claim"
    };
    let bap_id = non_empty(meta.bap_id.as_deref()).map(ToString::to_string);
    let collection_id = non_empty(meta.collection_id.as_deref()).map(ToString::to_string);
    let app_line = non_empty(meta.app.as_deref()).map(ToString::to_string);

    let missing_issuer_profile = (non_empty(item.issuer_key.as_deref()).is_some() || bap_id.is_some())
        && issuer
            .as_ref()
            .is_some_and(|v| matches!(v.state, "key" | "claim" | "unconfirmed"));
    let svc_sync = Arc::clone(&services);
    let mut toast_sync = toast;

    rsx! {
        div {
            class: "nav-child-panel collectable-details",
            "data-aeon-scope": "collectable-details",
            "data-aeon-state": "ready",

            div { class: "collectable-details-hero",
                div { class: "collectable-media collectable-media-md",
                    if let Some(ref art) = art_url {
                        img { class: "collectable-img", src: "{art}", alt: "{item.name}" }
                    } else {
                        span { class: "collectable-media-fallback", "aria-hidden": "true",
                            CollectablesIcon { size: 40 }
                        }
                    }
                }
                div { class: "collectable-details-copy",
                    h3 { class: "collectable-details-name", "{item.name}" }
                    if let Some(view) = issuer {
                        IssuerIdentityMark { view, class: Some("detail-issuer-mark".to_string()) }
                    }
                    if missing_issuer_profile {
                        button {
                            r#type: "button",
                            class: "btn btn-ghost",
                            style: "margin-top: 4px; align-self: flex-start;",
                            onclick: move |_| {
                                let svc = Arc::clone(&svc_sync);
                                spawn(async move {
                                    match crate::device_peer::sync_identities_from_connected_peers_manual(&svc).await {
                                        Ok(stats) => {
                                            let total = stats.profiles_added + stats.bap_packages_added + stats.cards_added;
                                            toast_sync.set(Some(ToastNotice {
                                                title: if total > 0 {
                                                    format!("Synced {total} identity record(s) from device")
                                                } else {
                                                    "No new profiles found on connected devices".into()
                                                },
                                                body: None,
                                                tone: if total > 0 { "success" } else { "info" },
                                            }));
                                        }
                                        Err(e) => toast_sync.set(Some(ToastNotice {
                                            title: "Device sync unavailable".into(),
                                            body: Some(e),
                                            tone: "error",
                                        })),
                                    }
                                });
                            },
                            "Sync profile from device"
                        }
                    }
                    if let Some(ref app) = app_line {
                        p { class: "collectable-details-app", "{app}" }
                    }
                    p {
                        class: "collectable-authenticity collectable-authenticity-{auth_tone}",
                        title: "{auth_title}",
                        "{auth_label}"
                    }
                }
            }

            TraitStrip { title: "Traits", rows: meta.traits.clone() }
            TraitStrip { title: "Details", rows: details }

            dl { class: "collectable-details-meta",
                if let Some(key) = issuer_key {
                    MetaRow { label: issuer_label, value: key, toast }
                }
                if let Some(id) = bap_id {
                    MetaRow { label: "Profile ID", value: id, toast }
                }
                if let Some(cid) = collection_id {
                    MetaRow { label: "Collection", value: cid, toast }
                }
                MetaRow { label: "Origin", value: item.origin_outpoint.clone(), toast }
                MetaRow { label: "Outpoint", value: item.outpoint.clone(), toast }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SendCollectablePanel.tsx
// ---------------------------------------------------------------------------

fn pick_items(snap: &WalletSnapshot, outpoints: &[String]) -> Vec<ItemCardRow> {
    let mut seen = BTreeSet::new();
    outpoints
        .iter()
        .filter(|op| seen.insert(op.as_str()))
        .filter_map(|op| snap.items.iter().find(|i| &i.outpoint == op).cloned())
        .collect()
}

fn preview_media(items: &[ItemCardRow], snap: &WalletSnapshot) -> Element {
    rsx! {
        for item in items.iter().take(3) {
            div { class: "collectable-media collectable-media-sm", key: "{item.outpoint}",
                if let Some(art) = snap.item_art.get(&item.outpoint) {
                    img { class: "collectable-img", src: "{art}", alt: "{item.name}", width: 48, height: 48 }
                } else {
                    span { class: "collectable-media-fallback", "aria-hidden": "true",
                        CollectablesIcon { size: 22 }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/SendCollectablePanel.tsx` (single or batch) with CTAs in the dock.
#[component]
pub fn SendCollectablePanel(
    outpoints: Vec<String>,
    #[props(default = "main".to_string())] chain: String,
    snap: WalletSnapshot,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let send_chart = use_aeon_machine::<AssetSendMachine>();
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let items = pick_items(&snap, &outpoints);
    let batch = items.len() > 1;
    let raw_to = send_chart.context().to.clone();
    let parsed = classify_recipient(&raw_to);
    let is_confirming = matches!(send_chart.state(), AssetSendState::Confirming);
    let state_attr = send_chart.state_attr();

    let desired_dock = (!items.is_empty()).then(|| {
        if is_confirming {
            DockSpec {
                aria_label: "Confirm collectable transfer",
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
            }
        } else {
            DockSpec {
                aria_label: "Collectable send actions",
                secondary: Some(DockActionSpec::new(
                    "cancel",
                    "Cancel",
                    ActionTone::Danger,
                    ActionIcon::Close,
                )),
                primary: DockActionSpec::new(
                    "review",
                    "Review",
                    ActionTone::Primary,
                    ActionIcon::Check,
                )
                .disabled(parsed.is_none()),
            }
        }
    });
    if *dock_spec.peek() != desired_dock {
        dock_spec.set(desired_dock);
    }

    {
        let first = items.first().map(|i| i.outpoint.clone());
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.peek() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "cancel" => match (batch, first.clone()) {
                    (false, Some(op)) => nav_child.set(Some(NavChild::CollectableDetails(op))),
                    _ => nav_child.set(None),
                },
                "review" => send_chart.send(AssetSendEvent::Review),
                "confirm" => {
                    // Gated until native 1Sat broadcast + crypto review (Phase 9).
                }
                _ => {}
            }
        });
    }

    if items.is_empty() {
        return rsx! {
            div {
                class: "nav-child-panel send-panel send-collectable-panel",
                "data-aeon-scope": "send-collectable",
                "data-aeon-state": "missing",
                EmptyState {
                    icon: Some(rsx! { CollectablesIcon { size: 22 } }),
                    title: "Item unavailable",
                    body: Some("This collectable is no longer in the wallet or could not be loaded.".into()),
                }
            }
        };
    }

    let issuers: Vec<IssuerView> = items
        .iter()
        .filter_map(|i| issuer_view_for(i, &snap, &services, &chain))
        .collect();
    let first = &items[0];
    let first_app = non_empty(
        snap.item_meta
            .get(&first.outpoint)
            .and_then(|m| m.app.as_deref()),
    )
    .map(ToString::to_string);
    let recipient_label = parsed
        .as_ref()
        .map(RecipientKind::display_label)
        .unwrap_or_else(|| raw_to.clone());

    rsx! {
        div {
            class: "nav-child-panel send-panel send-collectable-panel",
            "data-aeon-scope": "send-collectable",
            "data-aeon-state": "{state_attr}",

            if !is_confirming {
                div { class: "send-stage send-stage-edit",
                    div { class: "send-layout",
                        div { class: "send-amount-hero send-collectable-hero",
                            div { class: "send-collectable-preview",
                                {preview_media(&items, &snap)}
                                div {
                                    p { class: "send-eyebrow",
                                        if batch { "Send {items.len()} collectables" } else { "Send collectable" }
                                    }
                                    strong { class: "collectable-details-name",
                                        if batch { "{items.len()} selected" } else { "{first.name}" }
                                    }
                                    AssetIssuers { views: issuers.clone() }
                                    if !batch {
                                        if let Some(ref app) = first_app {
                                            p { class: "collectable-details-app", "{app}" }
                                        }
                                    }
                                }
                            }
                        }

                        div { class: "send-side",
                            div { class: "field friend-recipient-field send-to-field",
                                label { r#for: "collectable-to", "To" }
                                div { class: "send-to-input",
                                    input {
                                        id: "collectable-to",
                                        placeholder: "Friend, $handle, address, or wallet key",
                                        autocomplete: "off",
                                        spellcheck: false,
                                        value: "{raw_to}",
                                        oninput: move |e| {
                                            send_chart.send(AssetSendEvent::Edit {
                                                to: Some(e.value()),
                                                quantity: None,
                                                friend_label: None,
                                                payee_identity_key: None,
                                            });
                                        },
                                    }
                                }
                                if let Some(ref kind) = parsed {
                                    p { class: "send-resolved", aria_live: "polite",
                                        "Sending to "
                                        strong { "{kind.display_label()}" }
                                    }
                                } else if !raw_to.trim().is_empty() {
                                    p { class: "error", role: "status",
                                        "Enter a valid BSV address, $handle, or wallet key."
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                div { class: "send-stage send-stage-confirm",
                    div { class: "send-layout send-layout-confirm",
                        div { class: "send-amount-hero send-collectable-hero",
                            div { class: "send-collectable-preview",
                                {preview_media(&items, &snap)}
                                div {
                                    p { class: "send-eyebrow", "You’re sending" }
                                    strong { class: "collectable-details-name",
                                        if batch { "{items.len()} collectables" } else { "{first.name}" }
                                    }
                                    AssetIssuers { views: issuers }
                                }
                            }
                        }
                        div { class: "send-side",
                            p { class: "send-confirm-to",
                                "to "
                                strong { "{recipient_label}" }
                            }
                            if recipient_label != raw_to {
                                p { class: "mono send-confirm-address", "{raw_to}" }
                            }
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
    }
}

// ---------------------------------------------------------------------------
// BurnAssetPanel.tsx
// ---------------------------------------------------------------------------

/// TS `estimateBurnEconomics` (`src/wallet/burnEconomics.ts`) at the default 100 sat/kB.
struct BurnEconomics {
    gross_asset_sats: u64,
    protocol_output_sats: u64,
    recoverable_sats: u64,
    estimated_fee_sats: u64,
}

fn estimate_burn_economics(
    input_count: u64,
    protocol_output_count: u64,
    recovery_output: bool,
    gross_asset_sats: Option<u64>,
) -> BurnEconomics {
    let gross = gross_asset_sats.unwrap_or(input_count);
    let protocol = protocol_output_count;
    let outputs = protocol_output_count + u64::from(recovery_output);
    let bytes = 10 + input_count * 148 + outputs * 180;
    BurnEconomics {
        gross_asset_sats: gross,
        protocol_output_sats: protocol,
        recoverable_sats: gross.saturating_sub(protocol),
        estimated_fee_sats: (bytes * 100).div_ceil(1000),
    }
}

/// 1:1 port of `src/components/BurnAssetPanel.tsx` (`BurnCollectablePanel` /
/// `BurnCollectablesPanel` inside `BurnShell`) with CTAs in the dock.
#[component]
pub fn BurnAssetPanel(
    outpoints: Vec<String>,
    #[props(default = "main".to_string())] chain: String,
    snap: WalletSnapshot,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let burn_chart = use_aeon_machine::<AssetBurnUiMachine>();
    use_hook(move || {
        burn_chart.send(AssetBurnUiEvent::Open { amount: None });
    });
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let wanted: BTreeSet<&str> = outpoints.iter().map(String::as_str).collect();
    let items = pick_items(&snap, &outpoints);
    let batch = wanted.len() > 1;
    let complete = !items.is_empty() && items.len() == wanted.len();
    let is_confirming = matches!(burn_chart.state(), AssetBurnUiState::Confirming);
    let state_attr = burn_chart.state_attr();

    let desired_dock = complete.then(|| {
        if is_confirming {
            DockSpec {
                aria_label: "Confirm permanent burn",
                secondary: Some(DockActionSpec::new(
                    "back",
                    "Back",
                    ActionTone::Danger,
                    ActionIcon::Close,
                )),
                primary: DockActionSpec::new(
                    "confirm-burn",
                    "Confirm burn",
                    ActionTone::Danger,
                    ActionIcon::Fire,
                )
                .disabled(true),
            }
        } else {
            DockSpec {
                aria_label: "Review burn",
                secondary: Some(DockActionSpec::new(
                    "cancel",
                    "Cancel",
                    ActionTone::Danger,
                    ActionIcon::Close,
                )),
                primary: DockActionSpec::new(
                    "review",
                    "Review",
                    ActionTone::Danger,
                    ActionIcon::Check,
                ),
            }
        }
    });
    if *dock_spec.peek() != desired_dock {
        dock_spec.set(desired_dock);
    }

    {
        let first = items.first().map(|i| i.outpoint.clone());
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.peek() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "cancel" => match (batch, first.clone()) {
                    (false, Some(op)) => nav_child.set(Some(NavChild::CollectableDetails(op))),
                    _ => nav_child.set(None),
                },
                "review" => burn_chart.send(AssetBurnUiEvent::Review),
                "back" => burn_chart.send(AssetBurnUiEvent::Back),
                "confirm-burn" => {
                    // Gated until native burn broadcast + crypto review (Phase 9).
                }
                _ => {}
            }
        });
    }

    if !complete {
        let (title, body) = if batch {
            (
                "Some items are no longer available",
                "Return to Collect and choose items still held by this wallet.",
            )
        } else {
            (
                "Item not on this device",
                "This collectable is no longer held by this wallet.",
            )
        };
        return rsx! {
            div {
                class: "nav-child-panel send-panel burn-panel",
                "data-aeon-scope": "asset-burn",
                "data-aeon-state": "missing",
                EmptyState {
                    icon: Some(rsx! { CollectablesIcon { size: 28 } }),
                    title: title,
                    body: Some(body.to_string()),
                }
            }
        };
    }

    let issuers: Vec<IssuerView> = items
        .iter()
        .filter_map(|i| issuer_view_for(i, &snap, &services, &chain))
        .collect();
    let first = &items[0];
    let n = items.len();
    let economics = if batch {
        estimate_burn_economics(n as u64, 0, true, Some(n as u64))
    } else {
        estimate_burn_economics(1, 0, true, None)
    };
    let (eyebrow, title, subtitle, amount_label, confirm_subtitle) = if batch {
        (
            "Burn collectables".to_string(),
            format!("{n} selected items"),
            "One permanent on-chain action".to_string(),
            format!("{n} collectables"),
            "Every selected item and its BRC-150 lineage",
        )
    } else {
        let app = non_empty(
            snap.item_meta
                .get(&first.outpoint)
                .and_then(|m| m.app.as_deref()),
        );
        (
            "Burn collectable".to_string(),
            first.name.clone(),
            match app {
                Some(app) => format!("{app} · one of a kind"),
                None => "One of a kind".to_string(),
            },
            first.name.clone(),
            "This item, and its BRC-150 lineage with it",
        )
    };
    let recovered = economics.recoverable_sats;
    let fee = economics.estimated_fee_sats;
    let net_sign = if recovered >= fee { "+" } else { "−" };
    let net_abs = recovered.abs_diff(fee);
    let first_art = snap.item_art.get(&first.outpoint).cloned();

    rsx! {
        div {
            class: "nav-child-panel send-panel burn-panel",
            "data-aeon-scope": "asset-burn",
            "data-aeon-state": "{state_attr}",

            div { class: if is_confirming { "send-stage send-stage-confirm" } else { "send-stage send-stage-edit" },
                div { class: if is_confirming { "send-layout send-layout-confirm" } else { "send-layout" },
                    div { class: "send-amount-hero send-collectable-hero",
                        div { class: "send-collectable-preview",
                            span { class: "burn-hero-media", "aria-hidden": "true",
                                if batch {
                                    span { class: "burn-batch-preview", "aria-hidden": "true",
                                        for item in items.iter().take(3) {
                                            if let Some(art) = snap.item_art.get(&item.outpoint) {
                                                img { key: "{item.outpoint}", src: "{art}", alt: "", width: 40, height: 40 }
                                            } else {
                                                CollectablesIcon { key: "{item.outpoint}", size: 20 }
                                            }
                                        }
                                    }
                                } else if let Some(ref art) = first_art {
                                    img { class: "burn-hero-image", src: "{art}", alt: "{first.name}", width: 48, height: 48 }
                                } else {
                                    span { class: "burn-hero-model", "aria-hidden": "true",
                                        CollectablesIcon { size: 26 }
                                    }
                                }
                            }
                            div {
                                p { class: "send-eyebrow burn-eyebrow",
                                    FireIcon { size: 12 }
                                    if is_confirming { "You’re burning" } else { "{eyebrow}" }
                                }
                                strong { class: "collectable-details-name",
                                    if is_confirming { "{amount_label}" } else { "{title}" }
                                }
                                AssetIssuers { views: issuers }
                                if !is_confirming {
                                    p { class: "collectable-details-app", "{subtitle}" }
                                }
                            }
                        }
                    }

                    div { class: "send-side",
                        if is_confirming {
                            p { class: "send-confirm-to", "{confirm_subtitle}" }
                        }
                        dl { class: "burn-breakdown",
                            if !is_confirming {
                                div {
                                    dt { "Asset sats selected" }
                                    dd { "{group_thousands(economics.gross_asset_sats)} sats" }
                                }
                                div {
                                    dt { "Protocol outputs" }
                                    dd { "{group_thousands(economics.protocol_output_sats)} sats" }
                                }
                            }
                            div {
                                dt { "Recovered to Pay" }
                                dd { "{group_thousands(recovered)} sats" }
                            }
                            div {
                                dt { "Network fee" }
                                dd { "about {group_thousands(fee)} sats" }
                            }
                            div { class: "burn-breakdown-net",
                                dt { "Effect on Pay" }
                                dd { "{net_sign}{group_thousands(net_abs)} sats" }
                            }
                        }
                        if is_confirming {
                            p {
                                class: "burn-note",
                                "data-aeon-state": "unavailable",
                                "Burning is not available in this build yet."
                            }
                        } else {
                            p { class: "burn-note",
                                "Only eligible physical sats come back as wallet change. The asset itself ends here."
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod burn_economics_ts_port_tests {
    use super::*;

    // Ported 1:1 from `src/wallet/burnEconomics.test.ts`
    #[test]
    fn separates_token_protocol_outputs_from_physical_sats_recovered() {
        let preview = estimate_burn_economics(3, 1, true, None);
        assert_eq!(preview.gross_asset_sats, 3);
        assert_eq!(preview.protocol_output_sats, 1);
        assert_eq!(preview.recoverable_sats, 2);
    }

    #[test]
    fn one_item_burn_costs_more_pay_than_it_recovers() {
        let preview = estimate_burn_economics(1, 0, true, None);
        assert_eq!(preview.recoverable_sats, 1);
        assert!(preview.recoverable_sats < preview.estimated_fee_sats);
    }
}
