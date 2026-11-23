// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Rust replay half of the DOM parity harness. Port of `src/test/domParityNormalizer.ts`:
//! both the TS recorder fixtures and the dioxus-ssr output pass through `normalize_html`,
//! and the results must match exactly.

use std::collections::BTreeMap;

const VOID_TAGS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

const BOOLEAN_HTML_ATTRS: &[&str] = &[
    "checked", "disabled", "hidden", "multiple", "readonly", "required",
];

const BOOLEAN_DATA_ATTRS: &[&str] = &[
    "data-active",
    "data-activity-failed",
    "data-before-selected",
    "data-has-crumbs",
    "data-has-detail-actions",
    "data-hc",
    "data-highlight",
    "data-highlighted",
    "data-native",
    "data-permission",
    "data-ready",
    "data-selected",
];

const KEPT_EXACT_ATTRS: &[&str] = &[
    "accept",
    "alt",
    "class",
    "for",
    "id",
    "name",
    "placeholder",
    "role",
    "rows",
    "title",
    "type",
    "value",
];

#[derive(Debug, Clone, PartialEq)]
pub enum DomNode {
    El {
        tag: String,
        attrs: Vec<(String, String)>,
        children: Vec<DomNode>,
    },
    Text(String),
}

/// Case-insensitive replace for an ASCII lowercase `pat`, matching the TS `/gi` regexes.
fn replace_ci(s: &str, pat: &str, rep: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while let Some(pos) = lower[i..].find(pat) {
        out.push_str(&s[i..i + pos]);
        out.push_str(rep);
        i += pos + pat.len();
    }
    out.push_str(&s[i..]);
    out
}

fn decode_entities(raw: &str) -> String {
    let s = replace_ci(raw, "&#x27;", "'");
    let s = replace_ci(&s, "&apos;", "'");
    let s = replace_ci(&s, "&quot;", "\"");
    let s = replace_ci(&s, "&nbsp;", " ");
    let s = replace_ci(&s, "&lt;", "<");
    let s = replace_ci(&s, "&gt;", ">");
    replace_ci(&s, "&amp;", "&")
}

fn encode_attr(val: &str) -> String {
    val.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn encode_text(val: &str) -> String {
    val.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_attr(tag: &str, raw_name: &str, raw_val: Option<&str>) -> Option<(String, String)> {
    let name = raw_name.to_ascii_lowercase();
    let decoded = raw_val.map(decode_entities).unwrap_or_default();

    if BOOLEAN_HTML_ATTRS.contains(&name.as_str()) {
        if decoded == "false" {
            return None;
        }
        return Some((name, String::new()));
    }

    if name == "aria-hidden" {
        if decoded == "false" {
            return None;
        }
        return Some(("aria-hidden".into(), "true".into()));
    }

    if name.starts_with("aria-") {
        return Some((name, decoded.trim().to_string()));
    }

    if BOOLEAN_DATA_ATTRS.contains(&name.as_str()) {
        if decoded == "false" {
            return None;
        }
        return Some((name, String::new()));
    }

    if name.starts_with("data-") {
        return Some((name, decoded.trim().to_string()));
    }

    if name == "class" {
        let cls = collapse_ws(&decoded);
        if cls.is_empty() {
            return None;
        }
        return Some(("class".into(), cls));
    }

    if name == "value" && (tag == "textarea" || tag == "input") && decoded.is_empty() {
        return None;
    }

    if KEPT_EXACT_ATTRS.contains(&name.as_str()) {
        return Some((name, decoded));
    }

    None
}

/// Parses `name`, `name="v"`, `name='v'`, `name=v` pairs the way the TS attribute regex does.
fn parse_attrs(tag: &str, raw: &str) -> Vec<(String, String)> {
    let bytes = raw.as_bytes();
    let len = bytes.len();
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    let mut i = 0;

    let skip_ws = |mut j: usize| {
        while j < len && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        j
    };

    while i < len {
        let c = bytes[i];
        if !(c.is_ascii_alphabetic() || c == b'_' || c == b':') {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < len
            && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'-' | b'_' | b':' | b'.'))
        {
            i += 1;
        }
        let name = &raw[start..i];

        let mut value: Option<&str> = None;
        let mut end = i;
        let j = skip_ws(i);
        if j < len && bytes[j] == b'=' {
            let k = skip_ws(j + 1);
            if k < len && bytes[k] == b'"' {
                if let Some(close) = raw[k + 1..].find('"') {
                    value = Some(&raw[k + 1..k + 1 + close]);
                    end = k + 1 + close + 1;
                }
            } else if k < len && bytes[k] == b'\'' {
                if let Some(close) = raw[k + 1..].find('\'') {
                    value = Some(&raw[k + 1..k + 1 + close]);
                    end = k + 1 + close + 1;
                }
            } else {
                let mut m = k;
                while m < len
                    && !(bytes[m].is_ascii_whitespace()
                        || matches!(bytes[m], b'"' | b'\'' | b'=' | b'<' | b'>' | b'`'))
                {
                    m += 1;
                }
                if m > k {
                    value = Some(&raw[k..m]);
                    end = m;
                }
            }
        }
        i = end;

        if let Some((k, v)) = normalize_attr(tag, name, value) {
            map.insert(k, v);
        }
    }

    map.into_iter().collect()
}

fn is_tag_start(bytes: &[u8], pos: usize) -> bool {
    pos + 1 < bytes.len() && bytes[pos] == b'<' && {
        let mut p = pos + 1;
        if bytes[p] == b'/' {
            p += 1;
        }
        p < bytes.len() && bytes[p].is_ascii_alphabetic()
    }
}

struct Frame {
    tag: String,
    attrs: Vec<(String, String)>,
    children: Vec<DomNode>,
    in_svg: bool,
}

fn fold_top(stack: &mut Vec<Frame>) {
    let frame = stack.pop().expect("frame");
    let node = DomNode::El {
        tag: if frame.in_svg {
            "svg".into()
        } else {
            frame.tag.clone()
        },
        attrs: frame.attrs,
        children: frame.children,
    };
    stack.last_mut().expect("root").children.push(node);
}

/// Port of `parseAndNormalizeHtml`.
pub fn parse_and_normalize_html(html: &str) -> Vec<DomNode> {
    let cleaned = strip_comments(html);
    let bytes = cleaned.as_bytes();
    let len = bytes.len();
    let mut stack = vec![Frame {
        tag: "__root__".into(),
        attrs: vec![],
        children: vec![],
        in_svg: false,
    }];
    let mut pos = 0;

    while pos < len {
        if bytes[pos] != b'<' {
            let end = cleaned[pos..].find('<').map(|k| pos + k).unwrap_or(len);
            let top = stack.last_mut().expect("root");
            if !top.in_svg {
                let collapsed = collapse_ws(&decode_entities(&cleaned[pos..end]));
                if !collapsed.is_empty() {
                    match top.children.last_mut() {
                        Some(DomNode::Text(prev)) => {
                            prev.push(' ');
                            prev.push_str(&collapsed);
                        }
                        _ => top.children.push(DomNode::Text(collapsed)),
                    }
                }
            }
            pos = end;
            continue;
        }

        if !is_tag_start(bytes, pos) {
            pos += 1;
            continue;
        }
        let Some(gt_rel) = cleaned[pos..].find('>') else {
            pos += 1;
            continue;
        };
        let gt = pos + gt_rel;

        let is_closing = bytes[pos + 1] == b'/';
        let name_start = if is_closing { pos + 2 } else { pos + 1 };
        let mut name_end = name_start;
        while name_end < gt && (bytes[name_end].is_ascii_alphanumeric() || bytes[name_end] == b'-')
        {
            name_end += 1;
        }
        let raw_tag = cleaned[name_start..name_end].to_ascii_lowercase();
        let self_closing_slash = gt > name_end && bytes[gt - 1] == b'/';
        let attr_chunk = &cleaned[name_end..if self_closing_slash { gt - 1 } else { gt }];
        let self_closing = self_closing_slash || VOID_TAGS.contains(&raw_tag.as_str());
        pos = gt + 1;

        if raw_tag == "link" {
            continue;
        }

        let top_in_svg = stack.last().expect("root").in_svg;
        let top_tag = stack.last().expect("root").tag.clone();

        if is_closing {
            if top_in_svg && raw_tag != top_tag {
                continue;
            }
            if let Some(i) = (1..stack.len()).rev().find(|&i| stack[i].tag == raw_tag) {
                while stack.len() > i {
                    fold_top(&mut stack);
                }
            }
            continue;
        }

        if top_in_svg {
            continue;
        }

        let mut attrs = parse_attrs(&raw_tag, attr_chunk);
        let mut effective_tag = raw_tag.clone();
        // AuthMeshBackground canvas (TS) and payment-mesh SVG (Rust) share data-aeon-part="mesh".
        if raw_tag == "canvas"
            && attrs
                .iter()
                .any(|(k, v)| k == "data-aeon-part" && v == "mesh")
        {
            effective_tag = "svg".into();
        }
        if effective_tag == "svg" {
            attrs.retain(|(k, _)| {
                k == "class"
                    || k == "id"
                    || k == "role"
                    || k.starts_with("aria-")
                    || k.starts_with("data-")
            });
        }

        if self_closing {
            stack.last_mut().expect("root").children.push(DomNode::El {
                tag: effective_tag,
                attrs,
                children: vec![],
            });
        } else {
            stack.push(Frame {
                tag: raw_tag,
                attrs,
                children: vec![],
                in_svg: effective_tag == "svg",
            });
        }
    }

    while stack.len() > 1 {
        fold_top(&mut stack);
    }
    stack.pop().expect("root").children
}

fn strip_comments(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn format_node(node: &DomNode, depth: usize, lines: &mut Vec<String>) {
    let indent = "  ".repeat(depth);
    match node {
        DomNode::Text(t) => lines.push(format!("{indent}{}", encode_text(t))),
        DomNode::El {
            tag,
            attrs,
            children,
        } => {
            let attr_str: Vec<String> = attrs
                .iter()
                .map(|(k, v)| format!("{k}=\"{}\"", encode_attr(v)))
                .collect();
            let open = if attr_str.is_empty() {
                format!("<{tag}")
            } else {
                format!("<{tag} {}", attr_str.join(" "))
            };
            if children.is_empty() {
                lines.push(format!("{indent}{open}/>"));
            } else if children.len() == 1 {
                if let DomNode::Text(t) = &children[0] {
                    lines.push(format!("{indent}{open}>{}</{tag}>", encode_text(t)));
                    return;
                }
                lines.push(format!("{indent}{open}>"));
                format_node(&children[0], depth + 1, lines);
                lines.push(format!("{indent}</{tag}>"));
            } else {
                lines.push(format!("{indent}{open}>"));
                for child in children {
                    format_node(child, depth + 1, lines);
                }
                lines.push(format!("{indent}</{tag}>"));
            }
        }
    }
}

/// Port of `normalizeHtml`: the canonical text both sides are compared on.
pub fn normalize_html(html: &str) -> String {
    let mut lines = Vec::new();
    for node in parse_and_normalize_html(html) {
        format_node(&node, 0, &mut lines);
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use dioxus::prelude::*;

    fn fixture(path: &str) -> String {
        let full = format!("{}/../../fixtures/ui/{path}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("missing fixture {full}: {e}"))
    }

    fn render(app: fn() -> Element) -> String {
        let mut dom = VirtualDom::new(app);
        dom.rebuild_in_place();
        dioxus_ssr::render(&dom)
    }

    fn assert_parity(path: &str, app: fn() -> Element) {
        let actual = normalize_html(&render(app));
        let expected = normalize_html(&fixture(path));
        assert_eq!(actual, expected, "DOM parity mismatch for {path}");
    }

    #[test]
    fn normalizer_drops_styles_comments_and_whitespace() {
        let out = normalize_html(
            "<!-- x --><div  style=\"color:red\" CLASS=\"  a   b \" data-hc=\"false\">\n  Hi &amp; bye\n</div>",
        );
        assert_eq!(out, "<div class=\"a b\">Hi &amp; bye</div>");
    }

    #[test]
    fn normalizer_collapses_svg_to_structural_attributes() {
        let out =
            normalize_html("<svg viewBox=\"0 0 1 1\" aria-hidden=\"true\"><path d=\"M0\"/></svg>");
        assert_eq!(out, "<svg aria-hidden=\"true\"/>");
    }

    fn empty_state_basic() -> Element {
        rsx! {
            crate::ui::EmptyState {
                title: "No activity yet".to_string(),
                body: Some("Sends, receives, connections, and other wallet actions show up here.".to_string()),
                icon: Some(rsx! { svg { "aria-hidden": "true" } }),
            }
        }
    }

    #[test]
    fn empty_state_basic_matches_ts_fixture() {
        assert_parity("empty-state/basic.html", empty_state_basic);
    }

    fn empty_state_with_action() -> Element {
        rsx! {
            crate::ui::EmptyState {
                title: "No friends yet".to_string(),
                body: Some("Add someone by $handle or wallet key.".to_string()),
                icon: Some(rsx! { svg { "aria-hidden": "true" } }),
                action: Some(rsx! {
                    aeon_ui::button::Root {
                        variant: aeon_ui::button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        aeon_ui::button::Label { "Add friend" }
                    }
                }),
            }
        }
    }

    #[test]
    fn empty_state_with_action_matches_ts_fixture() {
        assert_parity("empty-state/with-action.html", empty_state_with_action);
    }

    fn brand_logo_default() -> Element {
        rsx! {
            crate::ui::BrandLogo { size: 28, show_wordmark: true }
        }
    }

    #[test]
    fn brand_logo_default_matches_ts_fixture() {
        assert_parity("brand-logo/default.html", brand_logo_default);
    }

    fn app_toast_host_empty() -> Element {
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        rsx! {
            crate::ui::chrome::AppToastHost { toast }
        }
    }

    #[test]
    fn app_toast_host_empty_matches_ts_fixture() {
        assert_parity("app-toast-host/empty.html", app_toast_host_empty);
    }

    fn wallet_action_bar_nav() -> Element {
        use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
        let trigger = use_signal(DockTrigger::default);
        let spec = DockSpec {
            aria_label: "Send actions",
            secondary: Some(DockActionSpec::new(
                "back",
                "Back",
                ActionTone::Secondary,
                ActionIcon::Back,
            )),
            primary: DockActionSpec::new("next", "Next", ActionTone::Primary, ActionIcon::Check),
        };
        rsx! {
            crate::ui::chrome::WalletActionBarFooter { spec, trigger }
        }
    }

    #[test]
    fn wallet_action_bar_nav_matches_ts_fixture() {
        assert_parity("wallet-action-bar/nav.html", wallet_action_bar_nav);
    }

    fn wallet_action_bar_nav_danger() -> Element {
        use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
        let trigger = use_signal(DockTrigger::default);
        let spec = DockSpec {
            aria_label: "Confirm disconnect app",
            secondary: Some(DockActionSpec::new(
                "cancel",
                "Cancel",
                ActionTone::Secondary,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "disconnect",
                "Disconnect",
                ActionTone::Danger,
                ActionIcon::Close,
            ),
        };
        rsx! {
            crate::ui::chrome::WalletActionBarFooter { spec, trigger }
        }
    }

    #[test]
    fn wallet_action_bar_nav_danger_matches_ts_fixture() {
        assert_parity(
            "wallet-action-bar/nav-danger.html",
            wallet_action_bar_nav_danger,
        );
    }

    fn payment_filters_default() -> Element {
        let filters = use_signal(crate::machines::PaymentFilters::default);
        rsx! {
            crate::ui::activity::PaymentFiltersPanel {
                filters,
                origins: vec!["wallet".to_string()],
            }
        }
    }

    #[test]
    fn payment_filters_default_matches_ts_fixture() {
        assert_parity("payment-filters/default.html", payment_filters_default);
    }

    fn settings_wallet_health_row_ok() -> Element {
        use crate::icons::ActivityIcon;
        use crate::ui::panels::SettingsNavRow;
        rsx! {
            ul { class: "settings-list",
                SettingsNavRow {
                    label: "Wallet health",
                    description: "All 5 checks OK".to_string(),
                    icon: rsx! { ActivityIcon { size: 20 } },
                    onclick: move |_| {},
                }
            }
        }
    }

    #[test]
    fn settings_wallet_health_row_ok_matches_ts_fixture() {
        assert_parity(
            "settings-wallet-health-row/ok.html",
            settings_wallet_health_row_ok,
        );
    }

    fn settings_wallet_health_row_warn() -> Element {
        use crate::icons::ActivityIcon;
        use crate::ui::panels::{SettingsNavRow, WalletHealthAlertBadge};
        rsx! {
            ul { class: "settings-list",
                SettingsNavRow {
                    label: "Wallet health",
                    description: String::new(),
                    status: Some("1 of 5 checks degraded".to_string()),
                    status_tone: "warn",
                    icon: rsx! { ActivityIcon { size: 20 } },
                    onclick: move |_| {},
                    trailing_end: Some(rsx! { WalletHealthAlertBadge { tone: "warn" } }),
                }
            }
        }
    }

    #[test]
    fn settings_wallet_health_row_warn_matches_ts_fixture() {
        assert_parity(
            "settings-wallet-health-row/warn.html",
            settings_wallet_health_row_warn,
        );
    }
}
