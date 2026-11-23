// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Makes the shared TS stylesheets match inside Blitz.
//!
//! The TS app tags `<html>` (`data-aeon-mode`, `data-aeon-platform`,
//! `layout-compact`, `platform-darwin`) and ~480 rules in `handcash.css`,
//! `layout-compact.css` and `electron.css` start with `html…`. Dioxus Native
//! cannot tag `<html>`, so none of those rules matched: light mode, the Linux
//! and Windows title bar, and the whole compact (phone) layout were missing.
//!
//! This rewrites each `html` prefix onto the app root div ([`ROOT_CLASS`]),
//! and turns the window-size classes into media queries matching
//! `src/wallet/layoutViewport.ts` (compact = portrait or width <= 900px):
//! - `html:is(.platform-mobile, .layout-compact) X` -> `@media compact { .hc-root[data-hc] X }`
//! - `html:not(.platform-mobile):not(.layout-compact) X` -> `@media wide { … }`
//! - `html.platform-mobile X` (phone shell only) -> dropped
//!
//! Each removed class test is replaced by one `[data-hc]` (always present on
//! the root) so rules keep their relative specificity.

use std::sync::LazyLock;

use crate::theme::{AEON_ELECTRON_CSS, HANDCASH_CSS, LAYOUT_COMPACT_CSS};

/// Class carried by the app root div that stands in for `<html>`.
pub const ROOT_CLASS: &str = "hc-root";
/// Width-based compact/wide split so tiled desktop windows (where height > width)
/// stay in desktop mode and only narrow/mobile viewports enter compact mode.
pub const COMPACT_MEDIA: &str = "(max-width: 820px)";
pub const WIDE_MEDIA: &str = "(min-width: 821px)";

/// `data-aeon-platform` value the TS shell puts on `<html>` (`src/main.tsx`).
pub const PLATFORM: &str = if cfg!(target_os = "windows") {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    "linux"
};

/// Root div classes: macOS also gets `platform-darwin` like `main.tsx`.
pub const ROOT_CLASSES: &str = if cfg!(target_os = "macos") {
    "hc-root platform-darwin"
} else {
    "hc-root"
};

/// `electron.css` + `handcash.css` + `layout-compact.css`, in `main.tsx` order, scoped once.
pub static SCOPED_SHEETS: LazyLock<String> = LazyLock::new(|| {
    let mut all = String::with_capacity(
        AEON_ELECTRON_CSS.len() + HANDCASH_CSS.len() + LAYOUT_COMPACT_CSS.len() + 2,
    );
    all.push_str(AEON_ELECTRON_CSS);
    all.push('\n');
    all.push_str(HANDCASH_CSS);
    all.push('\n');
    all.push_str(LAYOUT_COMPACT_CSS);
    scope_html_css(&strip_alpha_sheens(&all))
});

/// Embossed sheen gradients with translucent stops (white 9-12% -> transparent -> black 12-16%).
/// Blitz/Vello paints them as an opaque mid-gray wash, so they become `none` (solid `--hc-bg`).
const ALPHA_SHEENS: [&str; 2] = [
    "linear-gradient(180deg, rgb(255 255 255 / 9%), transparent 45%, rgb(0 0 0 / 12%))",
    "linear-gradient(180deg, rgb(255 255 255 / 12%), transparent 45%, rgb(0 0 0 / 16%))",
];

/// White inset emboss shadows, which Blitz fills across the whole box (black becomes ~#424242).
const INSET_HIGHLIGHTS: [&str; 2] = [
    "inset 0 1px 1px rgb(255 255 255 / 26%),",
    "inset 0 1px 1px rgb(255 255 255 / 30%),",
];

fn strip_alpha_sheens(css: &str) -> String {
    let css = ALPHA_SHEENS
        .iter()
        .fold(css.to_string(), |acc, sheen| acc.replace(sheen, "none"));
    INSET_HIGHLIGHTS
        .iter()
        .fold(css, |acc, inset| acc.replace(inset, ""))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cond {
    Always,
    Compact,
    Wide,
    Never,
}

impl Cond {
    /// `t` = whether the selector matches in `[wide, compact]` windows.
    fn from_truth(t: [bool; 2]) -> Self {
        match t {
            [true, true] => Self::Always,
            [false, true] => Self::Compact,
            [true, false] => Self::Wide,
            [false, false] => Self::Never,
        }
    }
}

pub fn scope_html_css(css: &str) -> String {
    let src = strip_comments(css);
    let mut out = String::with_capacity(src.len() + src.len() / 8);
    process_block(&src, &mut out);
    out
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

fn strip_comments(css: &str) -> String {
    let b = css.as_bytes();
    let mut out = String::with_capacity(css.len());
    let (mut i, mut start) = (0usize, 0usize);
    let mut quote: Option<u8> = None;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == b'"' || c == b'\'' {
            quote = Some(c);
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            out.push_str(&css[start..i]);
            let end = css[i + 2..].find("*/").map_or(b.len(), |p| i + 2 + p + 2);
            i = end;
            start = end;
            continue;
        }
        i += 1;
    }
    if start < css.len() {
        out.push_str(&css[start..]);
    }
    out
}

/// First byte in `targets` at bracket depth 0, outside strings.
fn scan_until(b: &[u8], mut i: usize, targets: &[u8]) -> Option<(usize, u8)> {
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
        } else {
            match c {
                _ if depth <= 0 && targets.contains(&c) => return Some((i, c)),
                b'"' | b'\'' => quote = Some(c),
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                _ => {}
            }
        }
        i += 1;
    }
    None
}

fn match_brace(b: &[u8], open: usize) -> usize {
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
        } else {
            match c {
                b'"' | b'\'' => quote = Some(c),
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return i;
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    b.len()
}

fn split_top_level(s: &str, sep: u8) -> Vec<&str> {
    let b = s.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0;
    while let Some((at, _)) = scan_until(b, start, &[sep]) {
        parts.push(&s[start..at]);
        start = at + 1;
    }
    parts.push(&s[start..]);
    parts
}

fn process_block(src: &str, out: &mut String) {
    let b = src.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let Some((stop, kind)) = scan_until(b, i, b"{;") else {
            out.push_str(&src[i..]);
            break;
        };
        let prelude = src[i..stop].trim();
        if kind == b';' {
            out.push_str(prelude);
            out.push_str(";\n");
            i = stop + 1;
            continue;
        }
        let close = match_brace(b, stop);
        let body = &src[stop + 1..close.min(b.len())];
        i = (close + 1).min(b.len());
        if let Some(at) = prelude.strip_prefix('@') {
            let name = at.split(|c: char| !is_ident_char(c)).next().unwrap_or("");
            out.push_str(prelude);
            if matches!(
                name,
                "media" | "supports" | "layer" | "container" | "document"
            ) {
                out.push_str(" {\n");
                process_block(body, out);
                out.push_str("}\n");
            } else {
                out.push_str(" {");
                out.push_str(body);
                out.push_str("}\n");
            }
            continue;
        }
        emit_style_rule(prelude, body, out);
    }
}

fn emit_style_rule(prelude: &str, body: &str, out: &mut String) {
    let mut groups: [Vec<String>; 3] = Default::default();
    let mut touched = false;
    for sel in split_top_level(prelude, b',') {
        let sel = sel.trim();
        if sel.is_empty() {
            continue;
        }
        let (cond, s) = rewrite_selector(sel);
        touched |= cond != Cond::Always || s != sel;
        match cond {
            Cond::Always => groups[0].push(s),
            Cond::Compact => groups[1].push(s),
            Cond::Wide => groups[2].push(s),
            Cond::Never => {}
        }
    }
    if !touched {
        out.push_str(prelude);
        out.push_str(" {");
        out.push_str(body);
        out.push_str("}\n");
        return;
    }
    for (sels, media) in groups
        .iter()
        .zip([None, Some(COMPACT_MEDIA), Some(WIDE_MEDIA)])
    {
        if sels.is_empty() {
            continue;
        }
        if let Some(m) = media {
            out.push_str("@media ");
            out.push_str(m);
            out.push_str(" {\n");
        }
        out.push_str(&sels.join(",\n"));
        out.push_str(" {");
        out.push_str(body);
        out.push_str("}\n");
        if media.is_some() {
            out.push_str("}\n");
        }
    }
}

/// Splits leading simple selectors (`.a`, `[x]`, `:is(…)`) off a compound.
fn split_compound(s: &str) -> (Vec<&str>, &str) {
    let b = s.as_bytes();
    let mut parts = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        match b[i] {
            b'.' => {
                i += 1;
                while i < b.len() && is_ident_char(b[i] as char) {
                    i += 1;
                }
            }
            b'[' => match scan_until(b, i + 1, b"]") {
                Some((end, _)) => i = end + 1,
                None => break,
            },
            b':' if b.get(i + 1) != Some(&b':') => {
                i += 1;
                while i < b.len() && is_ident_char(b[i] as char) {
                    i += 1;
                }
                if b.get(i) == Some(&b'(') {
                    match scan_until(b, i + 1, b")") {
                        Some((end, _)) => i = end + 1,
                        None => break,
                    }
                }
            }
            _ => break,
        }
        if i == start + 1 && b[start] != b'[' {
            i = start;
            break;
        }
        parts.push(&s[start..i]);
    }
    (parts, &s[i..])
}

/// Window-size truth `[wide, compact]` of a root class test, or `None` to keep it.
fn predicate(s: &str) -> Option<[bool; 2]> {
    match s {
        ".layout-compact" => return Some([false, true]),
        ".platform-mobile" => return Some([false, false]),
        _ => {}
    }
    let (neg, inner) = if let Some(a) = s.strip_prefix(":not(") {
        (true, a.strip_suffix(')')?)
    } else {
        let a = s
            .strip_prefix(":is(")
            .or_else(|| s.strip_prefix(":where("))?;
        (false, a.strip_suffix(')')?)
    };
    let mut any = [false, false];
    for arg in split_top_level(inner, b',') {
        let (parts, tail) = split_compound(arg.trim());
        if parts.is_empty() || !tail.trim().is_empty() {
            return None;
        }
        let mut t = [true, true];
        for p in parts {
            let pt = predicate(p)?;
            t = [t[0] && pt[0], t[1] && pt[1]];
        }
        any = [any[0] || t[0], any[1] || t[1]];
    }
    Some(if neg { [!any[0], !any[1]] } else { any })
}

/// Normalizes runs of whitespace in a selector and trims spaces inside `(...)`.
fn normalize_selector_ws(sel: &str) -> String {
    let mut compact = String::with_capacity(sel.len());
    let mut prev_ws = false;
    for ch in sel.chars() {
        if ch.is_ascii_whitespace() {
            if !prev_ws {
                compact.push(' ');
                prev_ws = true;
            }
        } else {
            if ch == ')' && compact.ends_with(' ') {
                compact.pop();
            }
            compact.push(ch);
            prev_ws = ch == '(';
        }
    }
    compact.trim().to_string()
}

/// Rewrites `:has(...)` selectors (unsupported by Stylo 0.8.0 in Blitz) into
/// equivalent descendant, state-attribute, or structural selectors.
fn rewrite_has_clauses(sel: &str) -> Option<String> {
    if !sel.contains(":has(") {
        return Some(sel.to_string());
    }
    let mut s = sel.to_string();
    const HAS_REWRITES: &[(&str, &str)] = &[
        (".stage:has(.dashboard) > .dashboard", ".stage > .dashboard"),
        (
            ".stage:has(.dashboard)",
            ".app-shell[data-aeon-state='ready'] > .stage",
        ),
        (
            ".app-shell:has(.auth-shell)",
            ".app-shell:not([data-aeon-state='ready'])",
        ),
        (".stage:has(.auth-shell) > .auth-shell", ".stage > .auth-shell"),
        (
            ".stage:has(.auth-shell)",
            ".app-shell:not([data-aeon-state='ready']) > .stage",
        ),
        (
            ".auth-shell-content:has([data-aeon-scope='create-keys-backup']) .keys-backup",
            ".auth-shell-content .keys-backup",
        ),
        (
            ".auth-shell-content:has([data-aeon-scope='create-keys-backup'])",
            ".auth-shell[data-aeon-state='keys-backup'] .auth-shell-content",
        ),
        (
            ".wallet-setup-option:has(.wallet-setup-option-mark)",
            ".wallet-setup-option[data-has-mark]",
        ),
        (":has([data-aeon-part='coin-trigger']:hover)", ":hover"),
        (
            ":has([data-aeon-part='coin-trigger']:focus-visible)",
            ":focus-within",
        ),
        (
            ".wallet-nav-stage:has(.nav-child-stage--browser):has(.permission-request-panel)",
            ".wallet-nav-stage[data-browser-permission]",
        ),
        (
            ".wallet-nav-stage:has(.app-browser-panel)",
            ".wallet-nav-stage[data-browser]",
        ),
        (
            ".wallet-nav-stage:has(.chat-shell) > .wallet-nav-panel",
            ".wallet-nav-stage[data-chat] > .wallet-nav-panel",
        ),
        (".nav-section-body:has(> .empty-state)", ".nav-section-body"),
        (".history-with-filters:has(.empty-state)", ".history-with-filters"),
        (
            ".wallet-hero > .wallet-hero-head.connected-panel-head:has(.fiat-currency-dropdown)",
            ".wallet-hero[data-menu-open] > .wallet-hero-head.connected-panel-head",
        ),
        (
            ".wallet-hero > .wallet-hero-head.connected-panel-head:has(.wallet-account-dropdown)",
            ".wallet-hero[data-menu-open] > .wallet-hero-head.connected-panel-head",
        ),
        (
            ".wallet-hero:has(.fiat-currency-dropdown)",
            ".wallet-hero[data-menu-open]",
        ),
        (
            ".wallet-hero:has(.fiat-currency-menu-dropdown)",
            ".wallet-hero[data-menu-open]",
        ),
        (
            ".wallet-nav-titlebar-pill:has(.wallet-nav-titlebar-label)",
            ".wallet-nav-titlebar-pill",
        ),
        (
            ".wallet-nav-titlebar-pill:has(.wallet-nav-titlebar-crumbs) .wallet-nav-titlebar-label",
            ".wallet-nav-titlebar-pill[data-has-crumbs] .wallet-nav-titlebar-label",
        ),
        (
            ".wallet-nav-titlebar-pill:has(.wallet-nav-titlebar-crumbs)",
            ".wallet-nav-titlebar-pill",
        ),
        (
            ".wallet-nav-titlebar:has(.wallet-nav-titlebar-crumbs)",
            ".wallet-nav-titlebar[data-has-crumbs]",
        ),
        (
            ".wallet-nav-titlebar-actions:not(:has(.wallet-nav-actions-pill))",
            ".wallet-nav-titlebar-actions:empty",
        ),
        (
            ".wallet-nav-titlebar-actions-slot:has(.wallet-nav-actions-pill--child)",
            ".wallet-nav-titlebar-actions-slot[data-has-child-pill]",
        ),
        (
            ":has(+ :is(.is-active, [aria-selected='true'], [data-selected]))",
            "[data-before-selected]",
        ),
        (
            ":has(+ :is([aria-selected='true'], [data-selected]))",
            "[data-before-selected]",
        ),
        (":has(+ .is-active)", "[data-before-selected]"),
        (":has(+ [aria-selected='true'])", "[data-before-selected]"),
        (":has(+ [data-selected])", "[data-before-selected]"),
        (
            ".identity-pill:has(> .identity-pill-lead:first-child)",
            ".identity-pill[data-has-lead]",
        ),
        (".identity-pill:has(> :only-child)", ".identity-pill[data-only-child]"),
        (
            ".history-icon:has(> .deferred-image > .history-item-thumb)",
            ".history-icon[data-has-thumb]",
        ),
        (".nav-child-body:has(.send-panel) .send-panel", ".nav-child-body .send-panel"),
        (".nav-child-body:has(.send-panel) .send-stage", ".nav-child-body .send-stage"),
        (".nav-child-body:has(.receive-panel)", ".nav-child-body"),
        (".nav-child-body:has(.send-panel)", ".nav-child-body"),
        (".nav-child-body:has(.scan-panel)", ".nav-child-body"),
        (".nav-child-body:has(.chat-with-scroll)", ".nav-child-body"),
        (".nav-child-stage:has(.chat-shell--nested)", ".nav-child-stage"),
        (
            ":has(> [data-aeon-part='description']:not(:empty))",
            "",
        ),
        (":has(> [data-aeon-part='leading'])", ""),
        (
            ".connected-panel-head:has(> .panel-filter)",
            ".connected-panel-head[data-has-filter]",
        ),
        (".fungible-avatar:has(> img)", ".fungible-avatar[data-has-img]"),
        (".collect-select:has(input:checked)", ".collect-select[data-checked]"),
        (
            ".collectable-card:has(.collect-select input:checked)",
            ".collectable-card[data-selected]",
        ),
        (
            ".collectable-row:has(.collect-select input:checked)",
            ".collectable-row[data-selected]",
        ),
        (".chat-unread-toggle:has(input:checked)", ".chat-unread-toggle[data-checked]"),
        (
            ".send-collectable-preview:has(> .collectable-media + .collectable-media)",
            ".send-collectable-preview[data-multi]",
        ),
        (
            ".wallet-nav-bar[data-permission]:has(.wallet-action-bar--nav[data-cta='primary'])",
            ".wallet-nav-bar[data-permission][data-cta='primary']",
        ),
        (
            ".wallet-nav-bar[data-permission]:has(.wallet-nav-tab-accept[data-selected]:not(:disabled))",
            ".wallet-nav-bar[data-permission][data-cta='primary']",
        ),
        (
            ".wallet-nav-bar[data-permission]:has(.wallet-action-bar--nav[data-cta='danger'])",
            ".wallet-nav-bar[data-permission][data-cta='danger']",
        ),
        (
            ".wallet-nav-bar[data-permission]:has(.wallet-nav-tab-danger[data-selected]:not(:disabled))",
            ".wallet-nav-bar[data-permission][data-cta='danger']",
        ),
        (
            ".wallet-actions:has(> .btn:nth-child(3))",
            ".wallet-actions",
        ),
        (
            ".wallet-nav-actions-pill.wallet-hero-metric:has(.fiat-currency-trigger:is(:active, :focus-visible, [aria-expanded='true']))",
            ".wallet-nav-actions-pill.wallet-hero-metric[data-aeon-state='open']",
        ),
        (
            ".wallet-nav-actions-pill.wallet-hero-identity-chrome:has(.wallet-hero-identity:is(:active, :focus-visible, [aria-expanded='true']))",
            ".wallet-nav-actions-pill.wallet-hero-identity-chrome[data-aeon-state='open']",
        ),
    ];
    for (from, to) in HAS_REWRITES {
        if s.contains(from) {
            s = s.replace(from, to);
        }
    }
    // Strip remaining `.wallet-nav-stage:has(...)` layout guards (stage is always a flex column).
    while let Some(pos) = s.find(".wallet-nav-stage:has(") {
        let has_open = pos + ".wallet-nav-stage:has(".len() - 1;
        let Some((close, _)) = scan_until(s.as_bytes(), has_open + 1, b")") else {
            break;
        };
        s.replace_range((pos + ".wallet-nav-stage".len())..=close, "");
    }
    if s.contains(":has(") {
        None
    } else {
        Some(s)
    }
}

pub fn rewrite_selector(raw_sel: &str) -> (Cond, String) {
    let normalized = normalize_selector_ws(raw_sel);
    let Some(sel_owned) = rewrite_has_clauses(&normalized) else {
        return (Cond::Never, String::new());
    };
    let sel = sel_owned.as_str();
    let Some(after_html) = sel.strip_prefix("html") else {
        return (Cond::Always, sel.to_string());
    };
    if after_html.chars().next().is_some_and(is_ident_char) {
        return (Cond::Always, sel.to_string());
    }
    let (simples, mut rest) = split_compound(after_html);
    let mut truth = [true, true];
    let mut kept = String::new();
    let mut removed = 0;
    for s in simples {
        match predicate(s) {
            Some(t) => {
                truth = [truth[0] && t[0], truth[1] && t[1]];
                removed += 1;
            }
            None => kept.push_str(s),
        }
    }
    // `html… body` styles the document body; the root div stands in for it.
    if let Some(after) = rest.trim_start().strip_prefix("body") {
        if after.is_empty() || after.starts_with(|c: char| c.is_whitespace() || c == '>') {
            rest = after;
        }
    }
    let mut out = format!(".{ROOT_CLASS}{kept}");
    for _ in 0..removed {
        out.push_str("[data-hc]");
    }
    out.push_str(rest);
    (Cond::from_truth(truth), out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_rules_become_media_queries() {
        let out =
            scope_html_css("html:is(.platform-mobile, .layout-compact) .dash { padding: 0; }");
        assert!(out.contains(&format!("@media {COMPACT_MEDIA}")), "{out}");
        assert!(out.contains(".hc-root[data-hc] .dash {"), "{out}");
    }

    #[test]
    fn wide_and_phone_only_rules() {
        let (c, s) = rewrite_selector("html:not(.platform-mobile):not(.layout-compact) .x");
        assert_eq!(c, Cond::Wide);
        assert_eq!(s, ".hc-root[data-hc][data-hc] .x");
        let (c, _) = rewrite_selector("html:not(:is(.platform-mobile, .layout-compact)) .x");
        assert_eq!(c, Cond::Wide);
        assert_eq!(rewrite_selector("html.platform-mobile .x").0, Cond::Never);
        let (c, s) = rewrite_selector("html:not(.platform-mobile) .x");
        assert_eq!((c, s.as_str()), (Cond::Always, ".hc-root[data-hc] .x"));
    }

    #[test]
    fn mode_platform_and_body_map_to_root() {
        let out = scope_html_css(
            "html[data-aeon-mode='light'] .brand-beta { color: red; }\n\
             html[data-aeon-platform] body, .keep { margin: 0; }\n\
             html:not([data-aeon-mode='dark']) .y { a: b; }",
        );
        assert!(
            out.contains(".hc-root[data-aeon-mode='light'] .brand-beta {"),
            "{out}"
        );
        assert!(
            out.contains(".hc-root[data-aeon-platform],\n.keep {"),
            "{out}"
        );
        assert!(
            out.contains(".hc-root:not([data-aeon-mode='dark']) .y {"),
            "{out}"
        );
    }

    #[test]
    fn mixed_lists_split_and_untouched_rules_survive() {
        let out = scope_html_css(
            "/* a { } */ .a, html.layout-compact .b { x: '}'; }\n\
             @keyframes k { from { o: 0 } }\n\
             @media (max-width: 1px) { html.layout-compact .c { y: 1 } }",
        );
        assert!(out.contains(".a { x: '}'; }"), "{out}");
        assert!(out.contains(".hc-root[data-hc] .b { x: '}'; }"), "{out}");
        assert!(out.contains("@keyframes k { from { o: 0 } }"), "{out}");
        assert!(out.contains("@media (max-width: 1px) {\n@media"), "{out}");
        assert!(!out.contains("/* a"), "{out}");
    }

    #[test]
    fn shipped_sheets_have_no_html_selectors_left() {
        let out = &*SCOPED_SHEETS;
        let open = out.matches('{').count();
        let close = out.matches('}').count();
        assert_eq!(open, close);
        assert!(
            !out.contains(":has("),
            "unrewritten :has() selector in SCOPED_SHEETS"
        );
        for line in out.lines() {
            let t = line.trim_start();
            assert!(
                !(t.starts_with("html[") || t.starts_with("html:") || t.starts_with("html.")),
                "unscoped html selector: {t}"
            );
        }
        assert!(out.contains(".hc-root[data-aeon-platform='linux']"));
        assert!(out.contains(".app-shell[data-aeon-state='ready'] > .stage"));
        assert!(out.contains(".app-shell:not([data-aeon-state='ready']) > .titlebar"));
        assert!(out.contains(".wallet-hero[data-menu-open] .wallet-hero-main"));
    }
}
