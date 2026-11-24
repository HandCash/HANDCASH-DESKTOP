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

    fn test_services() -> std::sync::Arc<crate::state::AppServices> {
        static SVC: std::sync::OnceLock<std::sync::Arc<crate::state::AppServices>> =
            std::sync::OnceLock::new();
        std::sync::Arc::clone(SVC.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!(
                "hc-parity-shared-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            crate::state::AppServices::open_in(dir, false).expect("open test AppServices")
        }))
    }

    fn render(app: fn() -> Element) -> String {
        let mut dom = VirtualDom::new(app);
        dom.provide_root_context(test_services());
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

    fn fiat_currency_menu_closed() -> Element {
        let fiat_code = use_signal(|| crate::machines::FiatCode::Usd);
        let open_menu = use_signal(|| Option::<&'static str>::None);
        rsx! {
            crate::ui::chrome::FiatCurrencyMenu {
                fiat_code,
                amount_label: "$0.00".to_string(),
                open_menu,
            }
        }
    }

    #[test]
    fn fiat_currency_menu_closed_matches_ts_fixture() {
        assert_parity("fiat-currency-menu/closed.html", fiat_currency_menu_closed);
    }

    fn fiat_currency_panel_usd() -> Element {
        let fiat_code = use_signal(|| crate::machines::FiatCode::Usd);
        rsx! {
            crate::ui::chrome::FiatCurrencyPanel { fiat_code }
        }
    }

    #[test]
    fn fiat_currency_panel_usd_matches_ts_fixture() {
        assert_parity("fiat-currency-panel/usd.html", fiat_currency_panel_usd);
    }

    fn wallet_account_menu_closed() -> Element {
        let profile = crate::state::SessionSummary {
            handle: "alice".to_string(),
            identity_key: "032a32ac11bbbd6b333b19cafc986e2508be3621246d75224e234a0d1a2f15eb75"
                .to_string(),
            address: "1Mmd5LJCnFKpkSYkZHdruZBs27koQoRpDj".to_string(),
            chain: "main".to_string(),
            account_id: "acc-0".to_string(),
            account_index: 0,
            toolbox_db_name: "hc-test".to_string(),
            generation: 1,
            has_mnemonic: true,
            derivation: "brc157".to_string(),
        };
        let app_machine = use_signal(|| {
            crate::machines::AppSessionMachine::new(true, Some(profile.clone()), 0, false)
        });
        let snapshot = use_signal(crate::state::WalletSnapshot::default);
        let nav_section = use_signal(|| crate::machines::NavSection::Activity);
        let nav_child = use_signal(|| Option::<crate::machines::NavChild>::None);
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        let open_menu = use_signal(|| Option::<&'static str>::None);
        rsx! {
            crate::ui::chrome::WalletAccountMenu {
                profile,
                app_machine,
                snapshot,
                nav_section,
                nav_child,
                toast,
                open_menu,
                identity_label: Some("$alice".to_string()),
                identity_copy: Some("$alice".to_string()),
            }
        }
    }

    #[test]
    fn wallet_account_menu_closed_matches_ts_fixture() {
        assert_parity("wallet-account-menu/closed.html", wallet_account_menu_closed);
    }

    fn recent_activity_empty() -> Element {
        let nav_section = use_signal(|| crate::machines::NavSection::Activity);
        let nav_child = use_signal(|| Option::<crate::machines::NavChild>::None);
        rsx! {
            crate::ui::activity::ActivityFeed {
                snap: crate::state::WalletSnapshot::default(),
                title: "Your activity".to_string(),
                embedded: false,
                show_view_all: false,
                currency: crate::machines::DisplayCurrency::Usd,
                fiat_code: crate::machines::FiatCode::Usd,
                fx_rates: crate::state::FxRates::default(),
                nav_section,
                nav_child,
            }
        }
    }

    #[test]
    fn recent_activity_empty_matches_ts_fixture() {
        assert_parity("recent-activity/empty.html", recent_activity_empty);
    }

    fn payment_details_not_found() -> Element {
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        rsx! {
            crate::ui::activity::PaymentDetailsPanel {
                entry_id: "missing-entry".to_string(),
                chain: "main".to_string(),
                snap: crate::state::WalletSnapshot::default(),
                currency: crate::machines::DisplayCurrency::Usd,
                fiat_code: crate::machines::FiatCode::Usd,
                fx_rates: crate::state::FxRates::default(),
                toast,
            }
        }
    }

    #[test]
    fn payment_details_not_found_matches_ts_fixture() {
        assert_parity("payment-details/not-found.html", payment_details_not_found);
    }

    fn friends_empty() -> Element {
        let view = use_signal(|| crate::machines::CollectionView::List);
        let nav_child = use_signal(|| Option::<crate::machines::NavChild>::None);
        rsx! {
            crate::ui::friends::FriendsPanel {
                chain: "main".to_string(),
                view,
                nav_child,
            }
        }
    }

    #[test]
    fn friends_empty_matches_ts_fixture() {
        assert_parity("friends/empty.html", friends_empty);
    }

    fn add_friend_idle() -> Element {
        let nav_child = use_signal(|| Option::<crate::machines::NavChild>::None);
        let dock_spec = use_signal(|| Option::<crate::ui::chrome::DockSpec>::None);
        let dock_trigger = use_signal(crate::ui::chrome::DockTrigger::default);
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        rsx! {
            crate::ui::friends::AddFriendPanel {
                nav_child,
                dock_spec,
                dock_trigger,
                toast,
            }
        }
    }

    #[test]
    fn add_friend_idle_matches_ts_fixture() {
        assert_parity("add-friend/idle.html", add_friend_idle);
    }

    fn friend_details_not_found() -> Element {
        let nav_child = use_signal(|| Option::<crate::machines::NavChild>::None);
        let dock_spec = use_signal(|| Option::<crate::ui::chrome::DockSpec>::None);
        let dock_trigger = use_signal(crate::ui::chrome::DockTrigger::default);
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        rsx! {
            crate::ui::friends::FriendDetailsPanel {
                friend_id: "missing-friend".to_string(),
                chain: "main".to_string(),
                nav_child,
                dock_spec,
                dock_trigger,
                toast,
            }
        }
    }

    #[test]
    fn friend_details_not_found_matches_ts_fixture() {
        assert_parity("friend-details/not-found.html", friend_details_not_found);
    }

    fn connected_apps_empty() -> Element {
        let view = use_signal(|| crate::machines::CollectionView::List);
        let nav_child = use_signal(|| Option::<crate::machines::NavChild>::None);
        rsx! {
            crate::ui::apps::ConnectedAppsPanel {
                snap: crate::state::WalletSnapshot::default(),
                view,
                nav_child,
            }
        }
    }

    #[test]
    fn connected_apps_empty_matches_ts_fixture() {
        assert_parity("connected-apps/empty.html", connected_apps_empty);
    }

    fn app_details_connected() -> Element {
        let nav_child = use_signal(|| Option::<crate::machines::NavChild>::None);
        let dock_spec = use_signal(|| Option::<crate::ui::chrome::DockSpec>::None);
        let dock_trigger = use_signal(crate::ui::chrome::DockTrigger::default);
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        let app = crate::state::ConnectedAppRecord {
            origin: "https://market.handcash.io".to_string(),
            name: "HandCash Market".to_string(),
            connected_at: 1700000000000,
            accept_incoming_funds: None,
            expires_at: None,
        };
        rsx! {
            crate::ui::apps::AppDetailsPanel {
                origin: app.origin.clone(),
                nav_child,
                dock_spec,
                dock_trigger,
                toast,
                app_override: Some(app),
            }
        }
    }

    #[test]
    fn app_details_connected_matches_ts_fixture() {
        assert_parity("app-details/connected.html", app_details_connected);
    }

    fn settings_fiat_dropdown_closed() -> Element {
        let fiat_code = use_signal(|| crate::machines::FiatCode::Usd);
        rsx! {
            crate::ui::panels::SettingsFiatDropdown { fiat_code }
        }
    }

    #[test]
    fn settings_fiat_dropdown_closed_matches_ts_fixture() {
        assert_parity("settings-fiat-dropdown/closed.html", settings_fiat_dropdown_closed);
    }

    fn settings_preferences_appearance_accept() -> Element {
        use crate::icons::{CoinGlyphIcon, DarkModeIcon, LightModeIcon, LtcGlyphIcon, MonitorIcon, PaletteIcon};
        use crate::state::AcceptedCoins;
        use crate::ui::primitives::{SettingsControlRow, SettingsIconToggle, SettingsIconToggleOption, SettingsSection};
        rsx! {
            SettingsSection {
                title: "Preferences".to_string(),
                part: "preferences",
                ul { class: "settings-list",
                    SettingsControlRow {
                        icon: Some(rsx! { PaletteIcon { size: 20 } }),
                        label: "Appearance".to_string(),
                        description: Some("Follows Omarchy or your system theme.".to_string()),
                        SettingsIconToggle {
                            aria_label: "Appearance".to_string(),
                            value: "system".to_string(),
                            on_change: move |_| {},
                            options: vec![
                                SettingsIconToggleOption {
                                    value: "system".to_string(),
                                    label: "System".to_string(),
                                    icon: rsx! { MonitorIcon { size: 16 } },
                                },
                                SettingsIconToggleOption {
                                    value: "dark".to_string(),
                                    label: "Dark".to_string(),
                                    icon: rsx! { DarkModeIcon { size: 16 } },
                                },
                                SettingsIconToggleOption {
                                    value: "light".to_string(),
                                    label: "Light".to_string(),
                                    icon: rsx! { LightModeIcon { size: 16 } },
                                },
                            ],
                        }
                    }
                    SettingsControlRow {
                        icon: Some(rsx! { CoinGlyphIcon { size: 20 } }),
                        label: "Accept".to_string(),
                        description: Some(format!("{}. {}", AcceptedCoins::Bitcoin.title(), AcceptedCoins::Bitcoin.description())),
                        SettingsIconToggle {
                            aria_label: "Accept".to_string(),
                            value: "bitcoin".to_string(),
                            on_change: move |_| {},
                            options: vec![
                                SettingsIconToggleOption {
                                    value: "bitcoin".to_string(),
                                    label: AcceptedCoins::Bitcoin.title().to_string(),
                                    icon: rsx! { CoinGlyphIcon { size: 16 } },
                                },
                                SettingsIconToggleOption {
                                    value: "all".to_string(),
                                    label: AcceptedCoins::All.title().to_string(),
                                    icon: rsx! {
                                        span { class: "accepted-coins-glyphs",
                                            CoinGlyphIcon { size: 12 }
                                            LtcGlyphIcon { size: 12 }
                                        }
                                    },
                                },
                            ],
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn settings_preferences_appearance_accept_matches_ts_fixture() {
        assert_parity(
            "settings-preferences/appearance-accept.html",
            settings_preferences_appearance_accept,
        );
    }

    fn auth_shell_onboard_entry() -> Element {
        rsx! {
            crate::ui::auth::AuthShell { state: "onboarding",
                crate::ui::auth::OnboardEntryPanel {
                    on_sign_in: move |_| {},
                    on_create: move |_| {},
                    on_migrate: move |_| {},
                }
            }
        }
    }

    #[test]
    fn auth_shell_onboard_entry_matches_ts_fixture() {
        assert_parity("auth-shell/onboard-entry.html", auth_shell_onboard_entry);
    }

    fn auth_create_idle() -> Element {
        let auth_mode = use_signal(|| crate::machines::AuthFormMode::Create);
        let app_machine = use_signal(|| crate::machines::AppSessionMachine::new(false, None, 0, false));
        let snapshot = use_signal(crate::state::WalletSnapshot::default);
        let fiat_code = use_signal(|| crate::machines::FiatCode::Usd);
        let fresh_mnemonic = use_signal(|| Option::<String>::None);
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        rsx! {
            crate::ui::auth::AuthFlow {
                is_locked: false,
                auth_mode,
                app_machine,
                snapshot,
                fiat_code,
                fresh_mnemonic,
                toast,
            }
        }
    }

    #[test]
    fn auth_create_idle_matches_ts_fixture() {
        assert_parity("auth-create/idle.html", auth_create_idle);
    }

    fn auth_restore_phrase_idle() -> Element {
        let auth_mode = use_signal(|| crate::machines::AuthFormMode::Phrase);
        let app_machine = use_signal(|| crate::machines::AppSessionMachine::new(false, None, 0, false));
        let snapshot = use_signal(crate::state::WalletSnapshot::default);
        let fiat_code = use_signal(|| crate::machines::FiatCode::Usd);
        let fresh_mnemonic = use_signal(|| Option::<String>::None);
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        rsx! {
            crate::ui::auth::AuthFlow {
                is_locked: false,
                auth_mode,
                app_machine,
                snapshot,
                fiat_code,
                fresh_mnemonic,
                toast,
            }
        }
    }

    #[test]
    fn auth_restore_phrase_idle_matches_ts_fixture() {
        assert_parity("auth-restore-phrase/idle.html", auth_restore_phrase_idle);
    }

    fn auth_unlock_idle() -> Element {
        let auth_mode = use_signal(|| crate::machines::AuthFormMode::Unlock);
        let app_machine = use_signal(|| crate::machines::AppSessionMachine::new(true, None, 0, false));
        let snapshot = use_signal(crate::state::WalletSnapshot::default);
        let fiat_code = use_signal(|| crate::machines::FiatCode::Usd);
        let fresh_mnemonic = use_signal(|| Option::<String>::None);
        let toast = use_signal(|| Option::<crate::machines::ToastNotice>::None);
        rsx! {
            crate::ui::auth::AuthFlow {
                is_locked: true,
                auth_mode,
                app_machine,
                snapshot,
                fiat_code,
                fresh_mnemonic,
                toast,
            }
        }
    }

    #[test]
    fn auth_unlock_idle_matches_ts_fixture() {
        assert_parity("auth-unlock/idle.html", auth_unlock_idle);
    }

    fn create_keys_backup_phrase() -> Element {
        rsx! {
            crate::ui::auth::CreateKeysBackupPanel {
                mnemonic: "absurd avoid scissors anxiety gather lottery category door army half long cage bachelor another expect people blade school educate curtain scrub monitor lady beyond".to_string(),
            }
        }
    }

    #[test]
    fn create_keys_backup_phrase_matches_ts_fixture() {
        assert_parity("create-keys-backup/phrase.html", create_keys_backup_phrase);
    }

    fn onboard_accept_bitcoin() -> Element {
        rsx! {
            crate::ui::auth::OnboardAcceptPanel {
                initial_choice: Some(crate::state::AcceptedCoins::Bitcoin),
                bsv_ready: false,
            }
        }
    }

    #[test]
    fn onboard_accept_bitcoin_matches_ts_fixture() {
        assert_parity("onboard-accept/bitcoin.html", onboard_accept_bitcoin);
    }

    fn onboard_fiat_usd() -> Element {
        rsx! {
            crate::ui::auth::OnboardFiatPanel {
                initial_fiat: crate::machines::FiatCode::Usd,
            }
        }
    }

    #[test]
    fn onboard_fiat_usd_matches_ts_fixture() {
        assert_parity("onboard-fiat/usd.html", onboard_fiat_usd);
    }

    fn onboard_protect_none() -> Element {
        rsx! {
            crate::ui::auth::OnboardProtectPanel {
                none_allowed: true,
                default_mode: "none".to_string(),
            }
        }
    }

    #[test]
    fn onboard_protect_none_matches_ts_fixture() {
        assert_parity("onboard-protect/none.html", onboard_protect_none);
    }

    fn phase_3_to_10_surfaces_smoke() -> Element {
        use crate::ui::{
            app_browser::{AppBrowserPanel, AppBrowserTabSwitcher, AppLaunchMenu, AppLaunchPanel, AppsSearchBar, BrowserTabEntry},
            collectables_extra::{AssetHistoryList, BntAssetView, BntShelf, CollectableListedMark, CollectableSendingMark, DeferredModelViewer, FungibleTokenFace, ItemHistoryEventView},
            devices::{GoogleEmailRecoveryMethods, GoogleLoginPanel, QrScanner},
            import::{ImportItemBrowser, ImportPanel, ImportSecretForm, ImportSourceKind, ImportSourceView, ImportedSourceView},
            permissions::{ActionPermissionDialog, ConnectPermissionDialog, IdentityPublishReview, PendingPromptView, PermissionDetailsPanel},
            platform_extras::{CallDock, ScreenshotToast, UpdatePrompt},
            swaps::{CoinDepositDetails, NetworkPicker, SwapDetailPanel, SwapOffersPanel},
        };
        let connect_prompt = PendingPromptView {
            id: 1,
            kind: "connect".into(),
            origin: "https://market.handcash.io".into(),
            app_name: "HandCash Market".into(),
            method: "connect".into(),
            title: "Connect".into(),
            summary: "Connect wallet".into(),
            details: vec![],
            grant_duration: "week".into(),
            amount_primary: None,
            amount_secondary: None,
            item_outpoint: None,
            token_id: None,
            item_name: None,
            item_image_url: None,
            preview_kind: None,
            monthly_cap: None,
            signing_required: false,
        };
        let mut action_prompt = connect_prompt.clone();
        action_prompt.kind = "action".into();
        action_prompt.method = "createAction".into();
        action_prompt.title = "Pay app".into();
        action_prompt.signing_required = true;
        rsx! {
            div {
                ConnectPermissionDialog { pending: Some(connect_prompt) }
                ActionPermissionDialog { pending: Some(action_prompt), signing_gated: true }
                PermissionDetailsPanel { origin: "https://market.handcash.io".to_string(), scope_id: "identity".to_string() }
                IdentityPublishReview { stage: Some("reviewing".to_string()), signing_gated: true }
                QrScanner { on_scan: move |_| {}, on_cancel: move |_| {} }
                GoogleLoginPanel { on_cancel: move |_| {} }
                GoogleEmailRecoveryMethods {}
                ImportPanel {}
                ImportSecretForm { kind: ImportSourceKind::HandCash, on_submit: move |_| {}, on_back: move |_| {} }
                ImportSourceView {
                    source: ImportedSourceView { id: "s1".to_string(), kind: ImportSourceKind::Phrase, label: "Old".to_string(), cash_sats: 1000, item_count: 1, scan_complete: true },
                    on_open_items: move |_| {},
                    on_back: move |_| {},
                }
                ImportItemBrowser { source_label: "Old".to_string(), items: vec![], on_back: move |_| {} }
                FungibleTokenFace { token_id: "tok1".to_string(), sym: "TOK".to_string(), size: 72 }
                DeferredModelViewer { src: "https://example.com/m.glb".to_string(), alt: "Model".to_string() }
                AssetHistoryList { events: vec![ItemHistoryEventView { id: "e1".to_string(), kind: "received".to_string(), title: "Received".to_string(), detail: "From peer".to_string(), when_label: None, contact_label: None, asset_name: None }] }
                CollectableSendingMark { sending: true }
                CollectableListedMark { label: "Listed".to_string() }
                BntShelf { assets: vec![BntAssetView { asset_id: "a1".to_string(), sym: "BNT".to_string(), name: "Token".to_string(), kind: "ft".to_string(), amount_display: "10".to_string(), supply_label: None, image_url: None }] }
                AppLaunchMenu { url: "https://market.handcash.io".to_string(), origin: "https://market.handcash.io".to_string(), name: "Market".to_string() }
                AppLaunchPanel { origin: "https://market.handcash.io".to_string(), name: "Market".to_string(), url: "https://market.handcash.io".to_string() }
                AppsSearchBar { query: String::new(), on_query_change: move |_| {} }
                AppBrowserTabSwitcher { tabs: vec![BrowserTabEntry { origin: "https://market.handcash.io".to_string(), name: "Market".to_string(), url: "https://market.handcash.io".to_string(), preview_data_url: None }], on_select: move |_| {}, on_close: move |_| {}, on_done: move |_| {} }
                AppBrowserPanel { name: "Market".to_string(), origin: "https://market.handcash.io".to_string(), url: "https://market.handcash.io".to_string() }
                CoinDepositDetails { chain: "ltc".to_string(), title: "Received LTC".to_string(), when_label: "Today".to_string() }
                NetworkPicker { value: "bsv".to_string(), on_change: move |_| {} }
                SwapOffersPanel {}
                SwapDetailPanel {}
                UpdatePrompt { phase: "available".to_string(), available_version: Some("1.3.722".to_string()) }
                ScreenshotToast { copied_version: Some("1.3.722".to_string()) }
                CallDock { state: "active".to_string(), peer_label: "$alice".to_string(), status_label: "Connected".to_string(), elapsed_ms: 12_000, encrypted: true }
            }
        }
    }

    #[test]
    fn phase_3_to_10_surfaces_render_with_honest_gating() {
        let html = render(phase_3_to_10_surfaces_smoke);
        for expected in [
            "data-aeon-scope=\"connect-permission\"",
            "data-aeon-scope=\"action-permission\"",
            "data-aeon-scope=\"permission-details\"",
            "data-aeon-part=\"identity-publish-review\"",
            "data-aeon-scope=\"qr-scanner\"",
            "data-aeon-scope=\"google-login\"",
            "data-aeon-scope=\"handcash-recovery\"",
            "data-aeon-scope=\"legacy-import\"",
            "data-aeon-scope=\"model-viewer\"",
            "data-aeon-scope=\"item-history\"",
            "data-aeon-scope=\"bnt-holdings\"",
            "data-aeon-scope=\"app-browser\"",
            "data-aeon-scope=\"network-picker\"",
            "data-aeon-scope=\"swap-offers\"",
            "data-aeon-scope=\"swap-detail\"",
            "data-aeon-scope=\"app-update\"",
            "data-aeon-scope=\"call-dock\"",
            "data-aeon-state=\"unavailable\"",
        ] {
            assert!(html.contains(expected), "missing expected SSR marker: {expected}");
        }
    }
}
