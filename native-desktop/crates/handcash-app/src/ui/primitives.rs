// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 ports of the small shared TS primitives:
//! `Skeleton.tsx`, `LoadingSpinner.tsx`, `MiddleEllipsisName.tsx` (+ `middleEllipsis.ts`),
//! `ProfileIdenticon.tsx`, and `ProfileAvatar.tsx`.

use dioxus::prelude::*;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// LoadingSpinner
// ---------------------------------------------------------------------------

/// TS `LoadingSpinner` (`size`: "sm" | "md" | "lg").
#[component]
pub fn LoadingSpinner(#[props(default = "md".to_string())] size: String) -> Element {
    rsx! {
        span { class: "loading-spinner loading-spinner--{size}", aria_hidden: true }
    }
}

// ---------------------------------------------------------------------------
// Skeleton family
// ---------------------------------------------------------------------------

fn px_or(v: &str) -> String {
    if v.chars().all(|c| c.is_ascii_digit()) {
        format!("{v}px")
    } else {
        v.to_string()
    }
}

/// TS `Skeleton`: width / height accept numbers (px) or CSS lengths.
#[component]
pub fn Skeleton(
    #[props(default)] width: Option<String>,
    #[props(default)] height: Option<String>,
    #[props(default)] radius: Option<String>,
    #[props(default)] class: Option<String>,
) -> Element {
    let mut style = String::new();
    if let Some(w) = width {
        style.push_str(&format!("width:{};", px_or(&w)));
    }
    if let Some(h) = height {
        style.push_str(&format!("height:{};", px_or(&h)));
    }
    if let Some(r) = radius {
        style.push_str(&format!("border-radius:{};", px_or(&r)));
    }
    let cls = match class {
        Some(c) if !c.is_empty() => format!("skeleton {c}"),
        _ => "skeleton".to_string(),
    };
    rsx! {
        span { class: "{cls}", style: "{style}", aria_hidden: true }
    }
}

/// TS `SkeletonAvatar` (`size`: "sm" | "md" | "lg").
#[component]
pub fn SkeletonAvatar(#[props(default = "md".to_string())] size: String) -> Element {
    rsx! {
        span { class: "skeleton skeleton-avatar skeleton-avatar-{size}", aria_hidden: true }
    }
}

/// TS `SkeletonLine` (defaults: width 70%, height 12).
#[component]
pub fn SkeletonLine(
    #[props(default = "70%".to_string())] width: String,
    #[props(default = "12".to_string())] height: String,
) -> Element {
    rsx! {
        Skeleton { class: "skeleton-line".to_string(), width: Some(width), height: Some(height) }
    }
}

/// TS `SkeletonHistoryRow`.
#[component]
pub fn SkeletonHistoryRow() -> Element {
    rsx! {
        div { class: "skeleton-history-row", aria_hidden: true,
            SkeletonAvatar { size: "sm" }
            div { class: "skeleton-app-row-body",
                SkeletonLine { width: "48%", height: "13" }
                SkeletonLine { width: "28%", height: "10" }
            }
            SkeletonLine { width: "64", height: "14" }
        }
    }
}

/// TS `SkeletonAppRow`.
#[component]
pub fn SkeletonAppRow() -> Element {
    rsx! {
        div { class: "skeleton-app-row", aria_hidden: true,
            SkeletonAvatar { size: "md" }
            div { class: "skeleton-app-row-body",
                SkeletonLine { width: "55%", height: "13" }
                div { class: "skeleton-app-row-meta",
                    SkeletonLine { width: "30%", height: "10" }
                    SkeletonLine { width: "20%", height: "10" }
                }
            }
        }
    }
}

/// TS `SkeletonAppCard`.
#[component]
pub fn SkeletonAppCard() -> Element {
    rsx! {
        div { class: "skeleton-app-card", aria_hidden: true,
            SkeletonAvatar { size: "lg" }
            SkeletonLine { width: "70%", height: "13" }
            SkeletonLine { width: "45%", height: "10" }
        }
    }
}

/// TS `SkeletonQr` (default 180).
#[component]
pub fn SkeletonQr(#[props(default = 180)] size: u32) -> Element {
    rsx! {
        span {
            class: "skeleton skeleton-qr",
            style: "width:{size}px;height:{size}px;",
            aria_hidden: true,
        }
    }
}

// ---------------------------------------------------------------------------
// MiddleEllipsisName
// ---------------------------------------------------------------------------

/// Does `chars[i..]` match `(?:#\s*|\s)[0-9][0-9A-Za-z]*$`?
fn tail_matches(chars: &[char], i: usize) -> bool {
    let mut j = i;
    match chars.get(j) {
        Some('#') => {
            j += 1;
            while chars.get(j).is_some_and(|c| c.is_whitespace()) {
                j += 1;
            }
        }
        Some(c) if c.is_whitespace() => j += 1,
        _ => return false,
    }
    if !chars.get(j).is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    chars[j + 1..].iter().all(|c| c.is_ascii_alphanumeric())
}

/// TS `middleEllipsisParts`: (head, tail). The tail survives truncation.
pub fn middle_ellipsis_parts(label: &str) -> (String, Option<String>) {
    let chars: Vec<char> = label.chars().collect();
    let n = chars.len();
    if let Some(idx) = (0..n).find(|&i| tail_matches(&chars, i)) {
        if idx > 0 && n - idx <= 10 {
            return (
                chars[..idx].iter().collect(),
                Some(chars[idx..].iter().collect()),
            );
        }
    }
    if n <= 12 {
        return (label.to_string(), None);
    }
    (
        chars[..n - 6].iter().collect(),
        Some(chars[n - 6..].iter().collect()),
    )
}

/// TS `MiddleEllipsisName`.
#[component]
pub fn MiddleEllipsisName(label: String, #[props(default)] class: Option<String>) -> Element {
    let (head, tail) = middle_ellipsis_parts(&label);
    let cls = match class {
        Some(c) if !c.is_empty() => format!("{c} middle-ellipsis"),
        _ => "middle-ellipsis".to_string(),
    };
    rsx! {
        strong { class: "{cls}", title: "{label}",
            span { class: "middle-ellipsis-head", "{head}" }
            if let Some(t) = tail {
                span { class: "middle-ellipsis-tail", "{t}" }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Profile identicon / fingerprint / avatar
// ---------------------------------------------------------------------------

/// TS `profileFingerprint` (`src/wallet/issuerTrust.ts`).
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileFingerprintData {
    pub hue: u32,
    pub cells: [bool; 25],
    pub short: String,
}

pub fn profile_fingerprint(id: &str) -> ProfileFingerprintData {
    let digest = Sha256::digest(id.as_bytes());
    let bit = |i: usize| (digest[1 + (i >> 3)] >> (i & 7)) & 1 == 1;
    let mut cells = [false; 25];
    for row in 0..5 {
        for col in 0..5usize {
            cells[row * 5 + col] = bit(row * 3 + col.min(4 - col));
        }
    }
    let hue = ((digest[0] as f64) / 256.0 * 360.0).round() as u32;
    let chars: Vec<char> = id.chars().collect();
    let short = if chars.len() > 12 {
        format!(
            "{}…{}",
            chars[..6].iter().collect::<String>(),
            chars[chars.len() - 4..].iter().collect::<String>()
        )
    } else {
        id.to_string()
    };
    ProfileFingerprintData { hue, cells, short }
}

/// TS `ProfileIdenticon`: 5×5 mirrored grid on a tinted plate.
#[component]
pub fn ProfileIdenticon(id: String, #[props(default = 16)] size: u32) -> Element {
    let fp = profile_fingerprint(&id);
    let plate = format!("hsl({} 48% 91%)", fp.hue);
    let ink = format!("hsl({} 62% 40%)", fp.hue);
    let on: Vec<(usize, usize)> = (0..25)
        .filter(|&i| fp.cells[i])
        .map(|i| (i % 5, i / 5))
        .collect();
    rsx! {
        svg {
            class: "profile-identicon",
            "data-aeon-part": "profile-identicon",
            width: "{size}",
            height: "{size}",
            view_box: "0 0 5 5",
            shape_rendering: "crispEdges",
            "aria-hidden": "true",
            rect { x: "0", y: "0", width: "5", height: "5", fill: "{plate}" }
            for (x, y) in on {
                rect { x: "{x}", y: "{y}", width: "1", height: "1", fill: "{ink}" }
            }
        }
    }
}

/// TS `ProfileFingerprint` (`src/components/ProfileIdenticon.tsx`).
#[component]
pub fn ProfileFingerprint(
    id: String,
    #[props(default = false)] claim: bool,
    #[props(default)] class: Option<String>,
    #[props(default = true)] show_id: bool,
    #[props(default)] state: Option<String>,
) -> Element {
    let fp = profile_fingerprint(&id);
    let cls = match class {
        Some(c) if !c.is_empty() => format!("identity-pill {c}"),
        _ => "identity-pill".to_string(),
    };
    let state_attr = state.or_else(|| if claim { Some("claim".to_string()) } else { None });
    rsx! {
        span {
            class: "{cls}",
            "data-aeon-part": "profile-fingerprint",
            "data-aeon-state": state_attr,
            "data-has-lead": "",
            "data-only-child": if !show_id { Some("") } else { None },
            title: "Profile ID {id}",
            span { class: "identity-pill-lead", ProfileIdenticon { id: id.clone(), size: 10 } }
            if show_id {
                span { class: "identity-pill-id mono", "{fp.short}" }
            }
        }
    }
}

/// TS `SignerFingerprint` (`src/components/ProfileIdenticon.tsx`).
#[component]
pub fn SignerFingerprint(
    address: String,
    #[props(default)] class: Option<String>,
) -> Element {
    let fp = profile_fingerprint(&address);
    let cls = match class {
        Some(c) if !c.is_empty() => format!("identity-pill {c}"),
        _ => "identity-pill".to_string(),
    };
    rsx! {
        span {
            class: "{cls}",
            "data-aeon-part": "signer-fingerprint",
            "data-aeon-state": "claim",
            "data-has-lead": "",
            title: "Signed by {address} · as the index reports it, not checked here",
            span { class: "identity-pill-lead", ProfileIdenticon { id: address.clone(), size: 10 } }
            span { class: "identity-pill-id mono", "{fp.short}" }
        }
    }
}

/// TS `ProfileAvatar`: image, else identicon, else initial.
#[component]
pub fn ProfileAvatar(
    label: String,
    #[props(default)] image_url: Option<String>,
    #[props(default)] identity_key: Option<String>,
) -> Element {
    let image = image_url.filter(|u| !u.trim().is_empty());
    let key = identity_key.filter(|k| !k.trim().is_empty());
    let state = if image.is_some() {
        "image"
    } else if key.is_some() {
        "identicon"
    } else {
        "initial"
    };
    let initial = label
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".into());
    rsx! {
        span { class: "profile-avatar", "data-aeon-part": "avatar", "data-aeon-state": "{state}",
            if let Some(src) = image {
                img { src: "{src}", alt: "", draggable: "false" }
            } else if let Some(k) = key {
                ProfileIdenticon { id: k, size: 32 }
            } else {
                "{initial}"
            }
        }
    }
}

/// TS `PeerAvatar` (`PeerIdentity.tsx`): presented profile image, else the label's initial.
#[component]
pub fn PeerAvatar(
    label: String,
    #[props(default = "friend-avatar".to_string())] class: String,
    #[props(default)] image_url: Option<String>,
) -> Element {
    let image = image_url.filter(|u| !u.trim().is_empty());
    let state = if image.is_some() { "image" } else { "initial" };
    let initial = label
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".into());
    rsx! {
        span {
            class: "{class}",
            "data-aeon-part": "peer-avatar",
            "data-aeon-state": "{state}",
            aria_hidden: true,
            if let Some(src) = image {
                img { class: "peer-avatar-image", src: "{src}", alt: "", draggable: "false" }
            } else {
                "{initial}"
            }
        }
    }
}

/// 1:1 port of Aeon `TextOverflow` (`mode="carousel"`) used by `WalletStatusPill`.
/// Static (`data-aeon-state="fit"`, 0Hz) when `label` fits within `max_fit_chars` (6 = "Synced");
/// smoothly loops horizontally when longer (e.g. "Bridge off", "Syncing", "Catching up").
#[component]
pub fn TextOverflowCarousel(
    label: String,
    #[props(default = "status-pill-label".to_string())] class: String,
    #[props(default = 6)] max_fit_chars: usize,
) -> Element {
    let overflows = label.chars().count() > max_fit_chars;
    let mut paused = use_signal(|| false);
    let mut offset_px = use_signal(|| 0.0_f64);
    let mut active_label = use_signal(|| label.clone());
    if *active_label.read() != label {
        active_label.set(label.clone());
        offset_px.set(0.0);
    }

    // Estimate one track cycle in pixels (uppercase ~8.5px/char + 24px gap) and tick at 20fps
    // only while overflowing; drops to 0Hz when the label fits (e.g. "Synced").
    use_future(move || async move {
        loop {
            let cur = active_label.read().clone();
            let len = cur.chars().count();
            if len <= max_fit_chars {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                continue;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if *paused.read() {
                continue;
            }
            let cycle_px = (len as f64) * 9.5 + 24.0;
            let next = *offset_px.read() + 1.1;
            if next >= cycle_px {
                offset_px.set(0.0);
            } else {
                offset_px.set(next);
            }
        }
    });

    let state_attr = if !overflows {
        "fit"
    } else if *paused.read() {
        "paused"
    } else {
        "carousel"
    };
    let track_style = if overflows {
        format!("transform: translateX(-{:.1}px);", *offset_px.read())
    } else {
        String::new()
    };

    rsx! {
        span {
            class: "{class}",
            "data-aeon-scope": "text-overflow",
            "data-aeon-mode": "carousel",
            "data-aeon-state": "{state_attr}",
            onmouseenter: move |_| paused.set(true),
            onmouseleave: move |_| paused.set(false),
            span { "data-aeon-part": "viewport",
                span {
                    "data-aeon-part": "track",
                    style: "{track_style}",
                    span { "data-aeon-part": "item", "{label}" }
                    if overflows {
                        span { "data-aeon-part": "item", aria_hidden: true, "{label}" }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/CommandConfirmPrompt.tsx` (BRC-218 §4 structured confirmation).
#[component]
pub fn CommandConfirmPrompt(
    open: bool,
    verb: String,
    recipient: String,
    amount_label: String,
    #[props(default)] sats_label: Option<String>,
    effect: String,
    #[props(default)] confirming: bool,
    on_confirm: EventHandler<()>,
    on_cancel: EventHandler<()>,
) -> Element {
    if !open {
        return rsx! {};
    }
    let status = if confirming {
        aeon_ui::prompt::PromptStatus::Confirming
    } else {
        aeon_ui::prompt::PromptStatus::Pending
    };
    rsx! {
        div { class: "permission-backdrop", onclick: move |_| on_cancel.call(()) }
        div { class: "permission-positioner",
            aeon_ui::prompt::Root {
                status,
                class: "panel modal permission-modal",
                aeon_ui::prompt::Eyebrow { "Confirm command" }
                h2 { "data-aeon-part": "title", "Confirm /{verb}" }
                aeon_ui::prompt::Verb { "/{verb}" }
                aeon_ui::prompt::Recipient { "{recipient}" }
                aeon_ui::prompt::Amount {
                    strong { "{amount_label}" }
                    if let Some(ref sats) = sats_label {
                        span { " · {sats}" }
                    }
                }
                aeon_ui::prompt::Effect { "{effect}" }
                aeon_ui::prompt::Actions { class: "actions",
                    aeon_ui::prompt::Secondary {
                        class: "btn btn-ghost",
                        onclick: move |_| on_cancel.call(()),
                        "Cancel"
                    }
                    aeon_ui::prompt::Primary {
                        class: "btn btn-primary",
                        disabled: confirming,
                        onclick: move |_| on_confirm.call(()),
                        if confirming { "Sending…" } else { "Confirm" }
                    }
                }
            }
        }
    }
}

/// Confirmation payload for [`AsyncActionPrompt`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AsyncConfirmSpec {
    pub title: String,
    pub body: String,
    pub confirm_label: String,
    pub cancel_label: Option<String>,
    pub danger: bool,
}

/// 1:1 port of `src/components/AsyncActionPrompt.tsx`.
#[component]
pub fn AsyncActionPrompt(
    confirm: Option<AsyncConfirmSpec>,
    #[props(default = "confirming")] state_attr: &'static str,
    on_confirm: EventHandler<()>,
    on_cancel: EventHandler<()>,
) -> Element {
    let Some(spec) = confirm else {
        return rsx! {};
    };
    let cancel = spec.cancel_label.unwrap_or_else(|| "Cancel".to_string());
    let primary_class = if spec.danger { "btn btn-danger" } else { "btn btn-primary" };
    rsx! {
        div { class: "permission-backdrop", onclick: move |_| on_cancel.call(()) }
        div { class: "permission-positioner",
            aeon_ui::prompt::Root {
                status: aeon_ui::prompt::PromptStatus::Pending,
                class: "panel modal permission-modal",
                div { "data-aeon-part": "async-action-confirm", "data-aeon-state": state_attr,
                    h2 { "data-aeon-part": "title", "{spec.title}" }
                    aeon_ui::prompt::Effect { "{spec.body}" }
                    aeon_ui::prompt::Actions { class: "actions",
                        aeon_ui::prompt::Secondary {
                            class: "btn btn-ghost",
                            onclick: move |_| on_cancel.call(()),
                            "{cancel}"
                        }
                        aeon_ui::prompt::Primary {
                            class: primary_class,
                            onclick: move |_| on_confirm.call(()),
                            "{spec.confirm_label}"
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/CopyableError.tsx`.
#[component]
pub fn CopyableError(
    #[props(default)] text: Option<String>,
    #[props(default = "error".to_string())] class: String,
    #[props(default = "alert")] role: &'static str,
    #[props(default)] inline: bool,
    children: Element,
) -> Element {
    let payload = text.unwrap_or_default();
    let can_copy = !payload.trim().is_empty();
    let full_class = format!("{class} copyable-error").trim().to_string();
    let title_attr = if can_copy { Some("Click to copy") } else { None };
    let tab_attr = if can_copy { Some("0") } else { None };
    let copy_click = payload.clone();
    let copy_key = payload;
    if inline {
        return rsx! {
            span {
                class: "{full_class}",
                role: role,
                title: title_attr,
                tabindex: tab_attr,
                onclick: move |_| {
                    if can_copy {
                        let _ = crate::state::copy_to_clipboard(&copy_click);
                    }
                },
                onkeydown: move |e: KeyboardEvent| {
                    if can_copy && (e.key() == Key::Enter || matches!(e.key(), Key::Character(ref s) if s == " ")) {
                        e.prevent_default();
                        let _ = crate::state::copy_to_clipboard(&copy_key);
                    }
                },
                {children}
            }
        };
    }
    rsx! {
        p {
            class: "{full_class}",
            role: role,
            title: title_attr,
            tabindex: tab_attr,
            onclick: move |_| {
                if can_copy {
                    let _ = crate::state::copy_to_clipboard(&copy_click);
                }
            },
            onkeydown: move |e: KeyboardEvent| {
                if can_copy && (e.key() == Key::Enter || matches!(e.key(), Key::Character(ref s) if s == " ")) {
                    e.prevent_default();
                    let _ = crate::state::copy_to_clipboard(&copy_key);
                }
            },
            {children}
        }
    }
}

/// 1:1 port of `src/components/searchKeyAction.ts`.
pub fn search_key_action(key: &str, value: &str) -> Option<&'static str> {
    if key != "Escape" {
        return None;
    }
    if value.is_empty() {
        Some("leave")
    } else {
        Some("clear")
    }
}

/// 1:1 port of `src/components/SearchField.tsx`.
#[component]
pub fn SearchField(
    id: String,
    label: String,
    value: String,
    on_value_change: EventHandler<String>,
    #[props(default)] placeholder: Option<String>,
    #[props(default)] disabled: bool,
    #[props(default)] role: Option<&'static str>,
    #[props(default)] aria_autocomplete: Option<&'static str>,
    #[props(default)] aria_expanded: Option<bool>,
    #[props(default)] aria_controls: Option<String>,
    #[props(default)] aria_activedescendant: Option<String>,
    #[props(default)] on_key_down: Option<EventHandler<KeyboardEvent>>,
    #[props(default)] on_focus: Option<EventHandler<FocusEvent>>,
    #[props(default)] on_blur: Option<EventHandler<FocusEvent>>,
) -> Element {
    let filled = !value.is_empty();
    let val_for_key = value.clone();
    rsx! {
        div {
            class: "search-field",
            "data-aeon-scope": "search-field",
            "data-aeon-state": if filled { "filled" } else { "empty" },
            label { class: "sr-only", r#for: "{id}", "{label}" }
            crate::icons::SearchIcon { size: 16, data_aeon_part: "mark" }
            input {
                id: "{id}",
                r#type: "search",
                autocomplete: "off",
                spellcheck: "false",
                placeholder: placeholder,
                value: "{value}",
                disabled: disabled,
                role: role,
                aria_autocomplete: aria_autocomplete,
                aria_expanded: aria_expanded.map(|b| if b { "true" } else { "false" }),
                aria_controls: aria_controls,
                aria_activedescendant: aria_activedescendant,
                oninput: move |e| on_value_change.call(e.value()),
                onfocus: move |e| {
                    if let Some(cb) = on_focus {
                        cb.call(e);
                    }
                },
                onblur: move |e| {
                    if let Some(cb) = on_blur {
                        cb.call(e);
                    }
                },
                onkeydown: move |e: KeyboardEvent| {
                    if let Some(cb) = on_key_down {
                        cb.call(e.clone());
                    }
                    if matches!(e.key(), Key::Escape)
                        && search_key_action("Escape", &val_for_key) == Some("clear")
                    {
                        e.prevent_default();
                        e.stop_propagation();
                        on_value_change.call(String::new());
                    }
                },
            }
            if filled {
                button {
                    r#type: "button",
                    "data-aeon-part": "clear",
                    aria_label: "Clear search",
                    title: "Clear search",
                    disabled: disabled,
                    onclick: move |_| on_value_change.call(String::new()),
                    crate::icons::CloseIcon { size: 14 }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/TopBarPopover.tsx` wrapping `aeon_ui::popover`.
#[component]
pub fn TopBarPopover(
    aria_label: String,
    #[props(default)] title: Option<String>,
    trigger: Element,
    children: Element,
    #[props(default)] active: bool,
    #[props(into, default)] class: Option<String>,
    #[props(into, default)] trigger_class: Option<String>,
    #[props(into, default)] content_class: Option<String>,
    #[props(default)] on_trigger: Option<EventHandler<()>>,
) -> Element {
    let mut open = use_signal(|| false);
    let is_open = *open.read();
    rsx! {
        aeon_ui::popover::Root {
            open: is_open,
            on_open_change: move |next| open.set(next),
            class,
            button {
                r#type: "button",
                class: trigger_class,
                aria_label: "{aria_label}",
                title: title,
                aria_expanded: if is_open { "true" } else { "false" },
                aria_haspopup: "dialog",
                "data-aeon-scope": "popover",
                "data-aeon-part": "trigger",
                "data-aeon-state": if is_open { "open" } else { "closed" },
                "data-active": if active { Some("") } else { None },
                onclick: move |_| {
                    let next = !*open.read();
                    open.set(next);
                    if let Some(cb) = on_trigger {
                        cb.call(());
                    }
                },
                {trigger}
            }
            aeon_ui::popover::Positioner {
                aeon_ui::popover::Content { class: content_class,
                    {children}
                }
            }
        }
    }
}

/// Suggestion item for [`PanelFilter`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchSuggestion {
    pub term: String,
    pub label: String,
    pub kind: String,
    pub count: usize,
}

/// 1:1 port of `splitPanelQuery` in `src/components/PanelFilter.tsx`.
pub fn split_panel_query(value: &str) -> (Vec<String>, String) {
    let mut parts: Vec<&str> = value.split(',').collect();
    let draft = parts.pop().unwrap_or_default().trim().to_string();
    let terms = parts
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    (terms, draft)
}

/// 1:1 port of `src/components/PanelFilter.tsx`.
#[component]
pub fn PanelFilter(
    id: String,
    label: String,
    placeholder: String,
    value: String,
    on_value_change: EventHandler<String>,
    #[props(default)] suggestions: Vec<SearchSuggestion>,
    shown: usize,
    total: usize,
) -> Element {
    let (terms, draft) = split_panel_query(&value);
    let mut focused = use_signal(|| false);
    let mut highlight = use_signal(|| 0usize);
    let active_suggestions = if draft.is_empty() {
        Vec::new()
    } else {
        suggestions
    };
    let open = *focused.read() && !active_suggestions.is_empty();
    let current = if open {
        Some((*highlight.read()).min(active_suggestions.len() - 1))
    } else {
        None
    };
    let list_id = format!("{id}-hints");
    let active = !value.trim().is_empty();
    let status_text = if active {
        format!("{shown} of {total}")
    } else {
        String::new()
    };
    let suggs_key = active_suggestions.clone();
    let terms_key = terms.clone();

    rsx! {
        TopBarPopover {
            aria_label: label.clone(),
            title: Some("Search".to_string()),
            class: Some("panel-search-popover".to_string()),
            trigger_class: Some("wallet-nav-chrome-btn".to_string()),
            content_class: Some("panel-search-popover-content".to_string()),
            active,
            trigger: rsx! {
                crate::icons::SearchIcon { size: 16 }
                if active {
                    span { class: "wallet-nav-chrome-dot", aria_hidden: true }
                }
            },
            div { class: "panel-filter", "data-aeon-scope": "panel-filter",
                SearchField {
                    id,
                    label,
                    placeholder: Some(placeholder),
                    value,
                    on_value_change: move |next| {
                        highlight.set(0);
                        on_value_change.call(next);
                    },
                    role: Some("combobox"),
                    aria_autocomplete: Some("list"),
                    aria_expanded: Some(open),
                    aria_controls: Some(list_id.clone()),
                    aria_activedescendant: current.map(|idx| format!("{list_id}-{idx}")),
                    on_focus: move |_| focused.set(true),
                    on_blur: move |_| focused.set(false),
                    on_key_down: move |e: KeyboardEvent| {
                        if !open || suggs_key.is_empty() {
                            return;
                        }
                        let len = suggs_key.len();
                        let cur = (*highlight.read()).min(len - 1);
                        match e.key() {
                            Key::ArrowDown => {
                                e.prevent_default();
                                highlight.set((cur + 1) % len);
                            }
                            Key::ArrowUp => {
                                e.prevent_default();
                                highlight.set((cur + len - 1) % len);
                            }
                            Key::Enter | Key::Tab => {
                                e.prevent_default();
                                let mut joined = terms_key.clone();
                                joined.push(suggs_key[cur].term.clone());
                                highlight.set(0);
                                on_value_change.call(joined.join(", "));
                            }
                            _ => {}
                        }
                    },
                }
                if open {
                    ul {
                        id: "{list_id}",
                        class: "panel-filter-suggestions",
                        role: "listbox",
                        aria_label: "Matches",
                        for (index, s) in active_suggestions.iter().enumerate() {
                            {
                                let term = s.term.clone();
                                let terms_click = terms.clone();
                                let is_cur = current == Some(index);
                                rsx! {
                                    li {
                                        key: "{s.term}",
                                        id: "{list_id}-{index}",
                                        role: "option",
                                        aria_selected: if is_cur { "true" } else { "false" },
                                        "data-highlight": if is_cur { Some("") } else { None },
                                        onmouseenter: move |_| highlight.set(index),
                                        onclick: move |_| {
                                            let mut joined = terms_click.clone();
                                            joined.push(term.clone());
                                            highlight.set(0);
                                            on_value_change.call(joined.join(", "));
                                        },
                                        span { class: "panel-filter-suggestion-label", "{s.label}" }
                                        span { class: "panel-filter-suggestion-kind", "{s.kind}" }
                                        span { class: "panel-filter-suggestion-count", "{s.count}" }
                                    }
                                }
                            }
                        }
                    }
                }
                span { class: "sr-only", role: "status", "{status_text}" }
            }
        }
    }
}

/// Crumb entry for [`NavBreadcrumb`] and [`NavBreadcrumbTrail`].
#[derive(Clone, PartialEq)]
pub struct NavCrumb {
    pub label: String,
    pub on_click: Option<EventHandler<()>>,
}

/// 1:1 port of `navBreadcrumbBack` in `src/components/NavBreadcrumb.tsx`.
pub fn nav_breadcrumb_back(crumbs: &[NavCrumb]) -> Option<EventHandler<()>> {
    if crumbs.len() < 2 {
        return None;
    }
    for crumb in crumbs[..crumbs.len() - 1].iter().rev() {
        if let Some(cb) = crumb.on_click {
            return Some(cb);
        }
    }
    None
}

/// 1:1 port of `NavBreadcrumbTrail` in `src/components/NavBreadcrumb.tsx`.
#[component]
pub fn NavBreadcrumbTrail(
    crumbs: Vec<NavCrumb>,
    #[props(default)] leading_sep: bool,
    #[props(into, default)] class: Option<String>,
) -> Element {
    let cls = class.unwrap_or_else(|| "nav-breadcrumb".to_string());
    let len = crumbs.len();
    rsx! {
        h2 { class: "{cls}", aria_label: "Breadcrumb",
            for (index, crumb) in crumbs.into_iter().enumerate() {
                {
                    let last = index + 1 == len;
                    let show_sep = index > 0 || (leading_sep && index == 0);
                    let sep_cls = if leading_sep && index == 0 {
                        "nav-breadcrumb-sep nav-breadcrumb-sep--leading"
                    } else {
                        "nav-breadcrumb-sep"
                    };
                    rsx! {
                        span { key: "{crumb.label}-{index}", class: "nav-breadcrumb-item",
                            if show_sep {
                                span { class: "{sep_cls}", aria_hidden: true, "/" }
                            }
                            if !last {
                                if let Some(cb) = crumb.on_click {
                                    button {
                                        r#type: "button",
                                        class: "nav-breadcrumb-link",
                                        onclick: move |_| cb.call(()),
                                        "{crumb.label}"
                                    }
                                } else {
                                    span { "{crumb.label}" }
                                }
                            } else {
                                span { class: "nav-breadcrumb-current", "{crumb.label}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/NavBreadcrumb.tsx`.
#[component]
pub fn NavBreadcrumb(
    crumbs: Vec<NavCrumb>,
    #[props(default)] on_back: Option<EventHandler<()>>,
    #[props(default)] leading_sep: bool,
) -> Element {
    let resolved_back = on_back.or_else(|| nav_breadcrumb_back(&crumbs));
    rsx! {
        div { class: "connected-panel-head nav-breadcrumb-head",
            div { class: "wallet-nav-titlebar-pill nav-breadcrumb-path-pill",
                NavBreadcrumbTrail {
                    crumbs,
                    leading_sep,
                    class: "nav-breadcrumb wallet-nav-titlebar-crumbs",
                }
            }
            if let Some(back_cb) = resolved_back {
                div { class: "wallet-nav-actions-pill nav-breadcrumb-back-pill",
                    button {
                        r#type: "button",
                        class: "wallet-nav-chrome-btn",
                        aria_label: "Back",
                        title: "Back",
                        onclick: move |_| back_cb.call(()),
                        crate::icons::BackIcon { size: 18 }
                    }
                }
            }
        }
    }
}

/// Context owned by [`WalletNavChromeProvider`] (`src/components/WalletNavChrome.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WalletNavChromeState {
    pub section: crate::machines::NavSection,
    pub child_active: bool,
    pub render_inline: bool,
}

/// 1:1 port of `WalletNavChromeProvider` in `src/components/WalletNavChrome.tsx`.
#[component]
pub fn WalletNavChromeProvider(
    section: crate::machines::NavSection,
    #[props(default)] child_active: bool,
    #[props(default = true)] render_inline: bool,
    children: Element,
) -> Element {
    let mut state = use_signal(|| WalletNavChromeState {
        section,
        child_active,
        render_inline,
    });
    let desired = WalletNavChromeState {
        section,
        child_active,
        render_inline,
    };
    if *state.peek() != desired {
        state.set(desired);
    }
    use_context_provider(|| state);
    rsx! { {children} }
}

/// 1:1 port of `TitlebarActionsSlot` in `src/components/WalletNavChrome.tsx`.
#[component]
pub fn TitlebarActionsSlot(#[props(default)] children: Option<Element>) -> Element {
    rsx! {
        div { class: "wallet-nav-titlebar-actions-slot",
            if let Some(inner) = children {
                {inner}
            }
        }
    }
}

/// 1:1 port of `TitlebarActions` in `src/components/WalletNavChrome.tsx`.
#[component]
pub fn TitlebarActions(
    section: crate::machines::NavSection,
    #[props(into, default)] class: Option<String>,
    #[props(default)] persist_in_child: bool,
    children: Element,
) -> Element {
    let Some(chrome) = try_use_context::<Signal<WalletNavChromeState>>() else {
        return rsx! {};
    };
    let cur = *chrome.read();
    if cur.section != section || (cur.child_active && !persist_in_child) || !cur.render_inline {
        return rsx! {};
    }
    let mut classes = vec!["wallet-nav-actions-pill"];
    let extra = class.unwrap_or_default();
    if !extra.is_empty() {
        classes.push(&extra);
    }
    if persist_in_child {
        classes.push("wallet-nav-actions-pill--child");
    }
    let pill_class = classes.join(" ");
    rsx! {
        div { class: "{pill_class}", {children} }
    }
}

/// 1:1 port of `src/components/ExclusiveActionRegion.tsx`.
#[component]
pub fn ExclusiveActionRegion(
    scope: &'static str,
    part: &'static str,
    #[props(default = "idle")] state_attr: &'static str,
    #[props(default)] busy: bool,
    #[props(default)] error: Option<String>,
    #[props(into, default)] class: Option<String>,
    #[props(default = "actions".to_string())] actions_class: String,
    idle_label: String,
    pending_label: String,
    #[props(default)] primary_disabled: bool,
    on_submit: EventHandler<FormEvent>,
    #[props(default)] secondary_label: Option<String>,
    #[props(default)] on_secondary: Option<EventHandler<()>>,
    #[props(default)] confirm: Option<AsyncConfirmSpec>,
    #[props(default)] on_confirm: Option<EventHandler<()>>,
    #[props(default)] on_cancel: Option<EventHandler<()>>,
    children: Element,
) -> Element {
    let primary_text = if busy { pending_label } else { idle_label };
    rsx! {
        form {
            class: class,
            "data-aeon-scope": scope,
            "data-aeon-part": part,
            "data-aeon-state": state_attr,
            onsubmit: move |e| on_submit.call(e),
            {children}
            if let Some(ref err) = error {
                p { class: "error", role: "alert", "{err}" }
            }
            div {
                class: "{actions_class}",
                "data-aeon-part": "actions",
                "data-aeon-state": state_attr,
                button {
                    r#type: "submit",
                    class: "btn btn-primary",
                    "data-aeon-part": "primary",
                    disabled: busy || primary_disabled,
                    "{primary_text}"
                }
                if let Some(ref sec_label) = secondary_label {
                    button {
                        r#type: "button",
                        class: "btn btn-ghost",
                        "data-aeon-part": "secondary",
                        disabled: busy,
                        onclick: move |_| {
                            if let Some(cb) = on_secondary {
                                cb.call(());
                            }
                        },
                        "{sec_label}"
                    }
                }
            }
            if confirm.is_some() {
                AsyncActionPrompt {
                    confirm,
                    state_attr,
                    on_confirm: move |_| {
                        if let Some(cb) = on_confirm {
                            cb.call(());
                        }
                    },
                    on_cancel: move |_| {
                        if let Some(cb) = on_cancel {
                            cb.call(());
                        }
                    },
                }
            }
        }
    }
}

/// 1:1 port of `src/components/DeferredImage.tsx`.
#[component]
pub fn DeferredImage(
    #[props(default)] src: Option<String>,
    #[props(default)] alt: String,
    #[props(into, default)] class: Option<String>,
    #[props(default)] width: Option<u32>,
    #[props(default)] height: Option<u32>,
    #[props(default)] ready: bool,
    #[props(default)] fallback: Option<Element>,
    #[props(into, default)] skeleton_class: Option<String>,
) -> Element {
    let Some(img_src) = src.filter(|s| !s.is_empty()) else {
        return rsx! {
            span {
                class: "deferred-image deferred-image--fallback",
                "data-aeon-state": "error",
                if let Some(fb) = fallback {
                    {fb}
                } else {
                    Skeleton { class: skeleton_class.unwrap_or_default() }
                }
            }
        };
    };
    let state = if ready { "ready" } else { "loading" };
    rsx! {
        span {
            class: "deferred-image",
            "data-aeon-state": state,
            if !ready {
                Skeleton { class: skeleton_class.unwrap_or_default() }
            }
            img {
                class: class,
                src: if ready { Some(img_src) } else { None },
                alt: "{alt}",
                width: width.map(|w| w.to_string()),
                height: height.map(|h| h.to_string()),
                hidden: !ready,
            }
        }
    }
}

/// 1:1 port of `src/components/amountPadKey.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AmountPadKey {
    Digit(char),
    Decimal,
    Back,
}

impl AmountPadKey {
    pub const ALL: [Self; 12] = [
        Self::Digit('1'),
        Self::Digit('2'),
        Self::Digit('3'),
        Self::Digit('4'),
        Self::Digit('5'),
        Self::Digit('6'),
        Self::Digit('7'),
        Self::Digit('8'),
        Self::Digit('9'),
        Self::Decimal,
        Self::Digit('0'),
        Self::Back,
    ];

    pub fn aria_label(self) -> String {
        match self {
            Self::Back => "Delete".to_string(),
            Self::Decimal => "Decimal point".to_string(),
            Self::Digit(c) => c.to_string(),
        }
    }
}

pub fn apply_amount_pad_key(value: &str, key: AmountPadKey) -> String {
    match key {
        AmountPadKey::Back => {
            let mut chars = value.chars();
            chars.next_back();
            chars.as_str().to_string()
        }
        AmountPadKey::Decimal => {
            if value.contains('.') {
                value.to_string()
            } else if value.is_empty() {
                "0.".to_string()
            } else {
                format!("{value}.")
            }
        }
        AmountPadKey::Digit(c) => {
            if value == "0" {
                c.to_string()
            } else {
                format!("{value}{c}")
            }
        }
    }
}

/// 1:1 port of `src/components/AmountPad.tsx`.
#[component]
pub fn AmountPad(
    value: String,
    on_change: EventHandler<String>,
    label: String,
    #[props(default)] disabled: bool,
) -> Element {
    rsx! {
        div {
            class: "amount-pad",
            "data-aeon-scope": "amount-pad",
            role: "group",
            aria_label: "{label}",
            for key in AmountPadKey::ALL {
                {
                    let cur = value.clone();
                    let aria = key.aria_label();
                    rsx! {
                        button {
                            key: "{aria}",
                            r#type: "button",
                            "data-aeon-part": "key",
                            aria_label: "{aria}",
                            disabled: disabled,
                            onclick: move |_| on_change.call(apply_amount_pad_key(&cur, key)),
                            match key {
                                AmountPadKey::Back => rsx! { crate::icons::BackspaceIcon { size: 22 } },
                                AmountPadKey::Decimal => rsx! { "." },
                                AmountPadKey::Digit(c) => rsx! { "{c}" },
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/settings/SettingsSection.tsx`.
#[component]
pub fn SettingsSection(
    title: String,
    #[props(into, default)] part: Option<String>,
    #[props(into, default)] group_key: Option<String>,
    #[props(into, default)] class: Option<String>,
    children: Element,
) -> Element {
    let cls = match class {
        Some(c) if !c.is_empty() => format!("settings-group {c}"),
        _ => "settings-group".to_string(),
    };
    let group = group_key.unwrap_or_else(|| title.clone());
    rsx! {
        section {
            class: "{cls}",
            "data-aeon-part": part,
            "data-settings-group": "{group}",
            h3 { class: "settings-group-title", "{title}" }
            {children}
        }
    }
}

/// 1:1 port of `src/components/settings/SettingsControlRow.tsx`.
#[component]
pub fn SettingsControlRow(
    label: String,
    #[props(into, default)] description: Option<String>,
    #[props(default)] icon: Option<Element>,
    #[props(default)] children: Option<Element>,
) -> Element {
    rsx! {
        li {
            aeon_ui::list_row::Root { "data-aeon-layout": "control",
                if let Some(ic) = icon {
                    aeon_ui::list_row::Leading { "aria-hidden": "true",
                        span { class: "settings-row-icon", "aria-hidden": "true", "data-tone": "default",
                            {ic}
                        }
                    }
                }
                aeon_ui::list_row::Label { "{label}" }
                if let Some(ref desc) = description {
                    aeon_ui::list_row::Description { "{desc}" }
                }
                if let Some(trailing) = children {
                    aeon_ui::list_row::Trailing { {trailing} }
                }
            }
        }
    }
}

/// Option for [`SettingsIconToggle`].
#[derive(Clone, PartialEq)]
pub struct SettingsIconToggleOption {
    pub value: String,
    pub label: String,
    pub icon: Element,
}

/// 1:1 port of `src/components/settings/SettingsIconToggle.tsx`.
#[component]
pub fn SettingsIconToggle(
    value: String,
    options: Vec<SettingsIconToggleOption>,
    on_change: EventHandler<String>,
    aria_label: String,
) -> Element {
    rsx! {
        div {
            class: "settings-icon-toggle",
            role: "radiogroup",
            aria_label: "{aria_label}",
            "data-aeon-scope": "radioGroup",
            "data-aeon-part": "root",
            for opt in options {
                {
                    let selected = opt.value == value;
                    let opt_val = opt.value.clone();
                    let cur_val = value.clone();
                    let state = if selected { "selected" } else { "unselected" };
                    rsx! {
                        div {
                            key: "{opt.value}",
                            class: "settings-icon-toggle-item",
                            "data-aeon-part": "item",
                            "data-aeon-state": state,
                            span {
                                role: "radio",
                                aria_checked: if selected { "true" } else { "false" },
                                aria_label: "{opt.label}",
                                title: "{opt.label}",
                                class: "settings-icon-toggle-btn",
                                "data-aeon-part": "itemControl",
                                "data-aeon-state": state,
                                "data-highlighted": if selected { Some("") } else { None },
                                "data-selected": if selected { Some("") } else { None },
                                onclick: move |_| {
                                    if opt_val != cur_val {
                                        on_change.call(opt_val.clone());
                                    }
                                },
                                {opt.icon}
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `screenshotShortcutKeys` in `src/components/settings/ShortcutHint.tsx`.
pub fn screenshot_shortcut_keys(platform: Option<&str>) -> Vec<&'static str> {
    if platform == Some("darwin") {
        vec!["⌘", "⇧", "S"]
    } else {
        vec!["Ctrl", "Shift", "S"]
    }
}

/// 1:1 port of `src/components/settings/ShortcutHint.tsx`.
#[component]
pub fn ShortcutHint(
    keys: Vec<String>,
    #[props(into, default)] class: Option<String>,
) -> Element {
    if keys.is_empty() {
        return rsx! {};
    }
    let cls = match class {
        Some(c) if !c.is_empty() => format!("shortcut-hint {c}"),
        _ => "shortcut-hint".to_string(),
    };
    let aria = keys.join(" + ");
    rsx! {
        span { class: "{cls}", aria_label: "{aria}",
            for (index, key) in keys.into_iter().enumerate() {
                kbd { key: "{key}-{index}", class: "shortcut-key", "{key}" }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_key_action_matches_ts() {
        assert_eq!(search_key_action("Escape", "btc"), Some("clear"));
        assert_eq!(search_key_action("Escape", ""), Some("leave"));
        assert_eq!(search_key_action("Enter", "btc"), None);
    }

    #[test]
    fn split_panel_query_matches_ts() {
        assert_eq!(
            split_panel_query("fox,  rare , bsv "),
            (vec!["fox".into(), "rare".into()], "bsv".into())
        );
        assert_eq!(split_panel_query(""), (vec![], String::new()));
    }

    #[test]
    fn amount_pad_key_rules_match_ts() {
        assert_eq!(apply_amount_pad_key("", AmountPadKey::Decimal), "0.");
        assert_eq!(apply_amount_pad_key("1.2", AmountPadKey::Decimal), "1.2");
        assert_eq!(apply_amount_pad_key("0", AmountPadKey::Digit('5')), "5");
        assert_eq!(apply_amount_pad_key("12.3", AmountPadKey::Back), "12.");
    }

    #[test]
    fn shortcut_hint_keys_match_platform() {
        assert_eq!(screenshot_shortcut_keys(Some("darwin")), vec!["⌘", "⇧", "S"]);
        assert_eq!(screenshot_shortcut_keys(Some("linux")), vec!["Ctrl", "Shift", "S"]);
    }

    #[test]
    fn middle_ellipsis_keeps_numbered_tail() {
        assert_eq!(
            middle_ellipsis_parts("Pixel Foxes #1234"),
            ("Pixel Foxes ".into(), Some("#1234".into()))
        );
        assert_eq!(
            middle_ellipsis_parts("Cool Cats 42"),
            ("Cool Cats".into(), Some(" 42".into()))
        );
    }

    #[test]
    fn middle_ellipsis_short_and_long() {
        assert_eq!(middle_ellipsis_parts("Short"), ("Short".into(), None));
        assert_eq!(
            middle_ellipsis_parts("abcdefghijklmnop"),
            ("abcdefghij".into(), Some("klmnop".into()))
        );
    }

    #[test]
    fn fingerprint_is_mirrored_and_short() {
        let fp = profile_fingerprint("02abcdef0123456789abcdef");
        for row in 0..5 {
            assert_eq!(fp.cells[row * 5], fp.cells[row * 5 + 4]);
            assert_eq!(fp.cells[row * 5 + 1], fp.cells[row * 5 + 3]);
        }
        assert_eq!(fp.short, "02abcd…cdef");
        assert!(fp.hue <= 360);
    }
}
