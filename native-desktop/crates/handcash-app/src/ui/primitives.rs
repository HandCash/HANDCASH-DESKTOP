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

/// TS `ProfileFingerprint` / `SignerFingerprint` (`claim: true`).
#[component]
pub fn ProfileFingerprint(id: String, #[props(default = false)] claim: bool) -> Element {
    let fp = profile_fingerprint(&id);
    rsx! {
        span {
            class: "identity-pill",
            "data-aeon-part": "profile-fingerprint",
            "data-aeon-state": if claim { Some("claim") } else { None },
            title: "{id}",
            span { class: "identity-pill-lead", ProfileIdenticon { id: id.clone(), size: 10 } }
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

#[cfg(test)]
mod tests {
    use super::*;

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
