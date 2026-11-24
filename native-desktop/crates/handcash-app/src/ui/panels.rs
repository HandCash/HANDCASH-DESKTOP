// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of the HandCash Desktop navigation panels:
//! `SendPanel`, `ReceivePanel`, `RecentActivity` / `TransactionsPanel`,
//! `ConnectedAppsPanel`, `InventoryPanel`, `FriendsPanel`, `IdentityPanel`, `SettingsPanel`.

use crate::health::{dependency_health_alert, DependencyHealthSnapshot, HealthAlert};
use crate::icons::{
    ActivityIcon, AppsIcon, ArcUsdGlyphIcon, CheckIcon, CodeIcon, CoinGlyphIcon, CopyIcon,
    DarkModeIcon, DevicesIcon, DownloadIcon, EncryptIcon, ExpandMoreIcon, FileIcon,
    FingerprintIcon, InfoIcon, LaunchIcon, LightModeIcon, LockIcon, LtcGlyphIcon, MonitorIcon,
    PaletteIcon, RefreshIcon, ScanQrIcon, SystemUpdateIcon, VolumeUpIcon, WarningIcon,
};
use crate::machines::{AppSessionMachine, FiatCode, NavChild, SettingSubpage, ToastNotice};
use crate::state::{
    copy_to_clipboard, load_builtin_chart_apps, open_external_url, render_qr_svg, truncate_mid,
    AcceptedCoins, AppServices, IdentityCardItem, LabFeature, RecoverScan,
    SessionSummary, WalletSnapshot, APP_VERSION,
};
use crate::theme::AppearancePreference;
use crate::ui::auth::{KeySliceList, PasswordField};
use crate::ui::primitives::ProfileIdenticon;
use aeon_ui::{button, list_row};
use base64::Engine as _;
use dioxus::prelude::*;
use handcash_primitives::brc140::Brc140IssuedSet;
use std::collections::BTreeSet;
use std::sync::Arc;

/// Split a dense payload into QR frames mirroring `splitQrFrames` (`src/components/AnimatedQr.tsx`).
pub fn split_qr_frames(value: &str, chunk_size: usize) -> Vec<String> {
    let size = chunk_size.max(32);
    if value.len() <= size {
        return vec![value.to_string()];
    }
    let bytes = value.as_bytes();
    let total = bytes.len().div_ceil(size);
    bytes
        .chunks(size)
        .enumerate()
        .map(|(idx, chunk)| {
            let part = String::from_utf8_lossy(chunk);
            format!("HCQR:{}/{}:{part}", idx + 1, total)
        })
        .collect()
}

/// 1:1 port of `src/components/AnimatedQr.tsx`.
#[component]
pub fn AnimatedQr(
    value: String,
    #[props(default = 180)] size: u32,
    #[props(default = "Animated recovery code".to_string())] alt: String,
    #[props(default = 10)] fps: u32,
) -> Element {
    let frames = split_qr_frames(&value, 220);
    let count = frames.len().max(1);
    let mut frame_idx = use_signal(|| 0usize);
    let hz = fps.clamp(8, 12);
    let frame_count_bg = count;
    use_future(move || async move {
        if frame_count_bg < 2 {
            return;
        }
        let step_ms = (1000 / hz).max(80) as u64;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(step_ms)).await;
            let next = (*frame_idx.read() + 1) % frame_count_bg;
            frame_idx.set(next);
        }
    });
    let cur = (*frame_idx.read()).min(count - 1);
    let svg = frames.get(cur).map(|f| render_qr_svg(f)).unwrap_or_default();
    rsx! {
        div { class: "animated-qr", "data-aeon-part": "animated-qr", aria_label: "{alt}",
            if !svg.is_empty() {
                div {
                    style: "width: {size}px; height: {size}px;",
                    dangerous_inner_html: "{svg}",
                }
            } else {
                crate::ui::primitives::SkeletonQr { size }
            }
            p { class: "animated-qr-count", aria_live: "polite",
                "{cur + 1} / {count}"
            }
        }
    }
}

/// 1:1 port of `src/components/settings/LabsPanel.tsx`.
#[component]
pub fn LabsPanel() -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut rev = use_signal(|| 0u64);
    let _ = *rev.read();
    rsx! {
        div {
            class: "nav-section-body settings-nav settings-scroll",
            "data-aeon-scope": "labs",
            p { class: "settings-row-desc", "data-aeon-part": "intro",
                "Experimental features; off by default, on this device only."
            }
            ul { class: "settings-list",
                for feature in LabFeature::ALL {
                    {
                        let enabled = services.lab_enabled(feature);
                        let svc_lab = Arc::clone(&services);
                        rsx! {
                            crate::ui::primitives::SettingsControlRow {
                                key: "{feature.key()}",
                                label: feature.title().to_string(),
                                description: Some(feature.description().to_string()),
                                button {
                                    r#type: "button",
                                    role: "switch",
                                    aria_checked: if enabled { "true" } else { "false" },
                                    aria_label: "{feature.title()}",
                                    class: "settings-icon-toggle-btn",
                                    "data-aeon-part": "lab-switch",
                                    "data-aeon-state": if enabled { "on" } else { "off" },
                                    "data-selected": if enabled { Some("") } else { None },
                                    onclick: move |_| {
                                        svc_lab.set_lab_enabled(feature, !enabled);
                                        let next = *rev.read() + 1;
                                        rev.set(next);
                                    },
                                    if enabled { "On" } else { "Off" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/settings/HistoryBackupUrlField.tsx`.
#[component]
pub fn HistoryBackupUrlField(
    #[props(default = "history-backup-url".to_string())] id: String,
    #[props(default = "History host".to_string())] label: String,
    #[props(default = true)] show_actions: bool,
    #[props(default)] current_url: String,
    #[props(default)] on_saved: Option<EventHandler<String>>,
) -> Element {
    let default_host = "https://history.handcash.io";
    let mut custom_host = use_signal(|| {
        let t = current_url.trim().trim_end_matches('/');
        !t.is_empty() && t != default_host
    });
    let mut draft = use_signal(|| {
        if current_url.trim().is_empty() {
            default_host.to_string()
        } else {
            current_url.clone()
        }
    });
    let is_custom = *custom_host.read();
    let cur_draft = draft.read().clone();
    rsx! {
        div { class: "settings-form settings-form-compact", "data-aeon-part": "history-url-field",
            ul { class: "settings-list",
                crate::ui::primitives::SettingsControlRow {
                    label: "Custom history host".to_string(),
                    icon: Some(rsx! { crate::icons::CloudUploadIcon { size: 20 } }),
                    description: Some(if is_custom {
                        "Backups go to the URL below".to_string()
                    } else {
                        "Off · backups go to HandCash".to_string()
                    }),
                    button {
                        r#type: "button",
                        role: "switch",
                        aria_checked: if is_custom { "true" } else { "false" },
                        aria_label: "Custom history host",
                        class: "settings-icon-toggle-btn",
                        "data-selected": if is_custom { Some("") } else { None },
                        onclick: move |_| {
                            let next = !*custom_host.read();
                            custom_host.set(next);
                            if !next {
                                draft.set(default_host.to_string());
                                if let Some(cb) = on_saved {
                                    cb.call(default_host.to_string());
                                }
                            }
                        },
                        if is_custom { "On" } else { "Off" }
                    }
                }
            }
            if is_custom {
                aeon_ui::field::Root { class: "field",
                    aeon_ui::field::Label { r#for: id.clone(), "{label}" }
                    input {
                        id: "{id}",
                        r#type: "url",
                        "data-aeon-part": "control",
                        placeholder: "{default_host}",
                        value: "{cur_draft}",
                        autocomplete: "off",
                        spellcheck: "false",
                        oninput: move |e| draft.set(e.value()),
                    }
                }
            }
            if show_actions && is_custom {
                div { class: "actions",
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        onclick: move |_| {
                            let next = draft.read().trim().to_string();
                            if let Some(cb) = on_saved {
                                cb.call(next);
                            }
                        },
                        button::Label { "Save URL" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| {
                            custom_host.set(false);
                            draft.set(default_host.to_string());
                            if let Some(cb) = on_saved {
                                cb.call(default_host.to_string());
                            }
                        },
                        button::Label { "Use HandCash" }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/LogViewerPanel.tsx`.
#[component]
pub fn LogViewerPanel(mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut log_rev = use_signal(|| 0u64);
    let mut filter = use_signal(String::new);
    let mut upload_url = use_signal(String::new);
    let _ = *log_rev.read();
    let payload = services.host_log.read_logs(Some(256 * 1024));
    let raw_text = payload
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("No log lines yet.")
        .to_string();
    let log_path = payload
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let q = filter.read().trim().to_ascii_lowercase();
    let filtered_text = if q.is_empty() {
        raw_text.clone()
    } else {
        let matched: Vec<&str> = raw_text
            .lines()
            .filter(|line| line.to_ascii_lowercase().contains(&q))
            .collect();
        if matched.is_empty() {
            "No matching lines.".to_string()
        } else {
            matched.join("\n")
        }
    };
    let copy_text = filtered_text.clone();
    let svc_open = Arc::clone(&services);
    let cur_filter = filter.read().clone();
    let cur_upload = upload_url.read().clone();

    rsx! {
        div { class: "nav-section-body settings-scroll log-viewer", "data-aeon-scope": "log-viewer",
            p { class: "settings-hint",
                "Copy lines for support, or open the log folder. Logs are privacy-scrubbed before writing."
            }
            crate::ui::primitives::SettingsSection { title: "Send to support".to_string(), part: "upload",
                div { class: "settings-form settings-form-compact log-viewer-tools",
                    aeon_ui::field::Root { class: "field",
                        aeon_ui::field::Label { r#for: "log-upload-url", "Upload URL" }
                        input {
                            id: "log-upload-url",
                            class: "settings-control-input settings-control-input-block",
                            r#type: "url",
                            "data-aeon-part": "log-upload-url",
                            placeholder: "https://…/v1/logs/hc-…",
                            value: "{cur_upload}",
                            oninput: move |e| upload_url.set(e.value()),
                        }
                        p { class: "field-hint", "Log upload is not available in this build yet; copy lines or open the log folder instead." }
                    }
                    div { class: "actions", "data-aeon-state": "unavailable",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            "data-aeon-part": "upload-logs",
                            "data-aeon-state": "unavailable",
                            disabled: true,
                            button::Label { "Upload session" }
                        }
                    }
                }
            }
            crate::ui::primitives::SettingsSection { title: "This session".to_string(), part: "session",
                div { class: "settings-form settings-form-compact log-viewer-tools",
                    aeon_ui::field::Root { class: "field",
                        aeon_ui::field::Label { r#for: "log-filter", "Filter" }
                        input {
                            id: "log-filter",
                            "data-aeon-part": "control",
                            placeholder: "cloud-backup, sync, error…",
                            value: "{cur_filter}",
                            autocomplete: "off",
                            spellcheck: "false",
                            oninput: move |e| filter.set(e.value()),
                        }
                    }
                    div { class: "actions log-viewer-actions", "data-aeon-part": "log-actions",
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            "data-aeon-part": "refresh-logs",
                            onclick: move |_| {
                                let next = *log_rev.read() + 1;
                                log_rev.set(next);
                            },
                            button::Label { "Refresh" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| match copy_to_clipboard(&copy_text) {
                                Ok(()) => toast.set(Some(ToastNotice {
                                    title: "Logs copied".into(),
                                    body: None,
                                    tone: "success",
                                })),
                                Err(e) => toast.set(Some(ToastNotice {
                                    title: "Copy failed".into(),
                                    body: Some(e),
                                    tone: "error",
                                })),
                            },
                            button::Label { "Copy" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            "data-aeon-part": "open-logs",
                            onclick: move |_| {
                                let _ = svc_open.host_log.open_logs();
                            },
                            button::Label { "Open folder" }
                        }
                    }
                }
            }
            if !log_path.is_empty() {
                p { class: "settings-log-path mono", title: "{log_path}", "{log_path}" }
            }
            pre { class: "log-viewer-pre", tabindex: "0", aria_label: "Log output", "{filtered_text}" }
        }
    }
}

/// 1:1 port of `src/components/StatechartsPanel.tsx` (list view, no Mermaid).
#[component]
pub fn StatechartsPanel(profile: SessionSummary, snap: WalletSnapshot) -> Element {
    let rows = [
        ("Session", "ready".to_string()),
        ("Engine", format!("phase {} · gen {}", snap.engine_phase, snap.engine_generation)),
        ("Account", format!("#{} · {} · {}", profile.account_index, profile.chain, profile.derivation)),
        ("BRC-100 bridge", snap.bridge_http_url.clone()),
        ("UTXOs / 1Sat items", format!("{} / {}", snap.balance.spendable_utxo_count, snap.balance.item_count)),
    ];
    rsx! {
        div { class: "nav-child-panel statecharts-panel", "data-aeon-scope": "statecharts",
            h3 { "Statecharts" }
            p { class: "settings-row-desc",
                "Live runtime states of the native Rust wallet machines."
            }
            ul { class: "identity-list",
                for (label, value) in rows {
                    li { key: "{label}", class: "identity-field",
                        span { class: "identity-field-label", "{label}" }
                        strong { class: "mono", "{value}" }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/ChartAppView.tsx` (state runner view for a verified chart app).
#[component]
pub fn ChartAppView(
    app: crate::state::BuiltinChartApp,
    state_name: String,
    on_transition: EventHandler<String>,
    on_back: EventHandler<()>,
) -> Element {
    let state_obj = app.raw_json.get("states").and_then(|s| s.get(&state_name));
    let copy = state_obj
        .and_then(|s| s.get("description").or_else(|| s.get("meta").and_then(|m| m.get("copy"))))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let transitions: Vec<(String, String)> = state_obj
        .and_then(|s| s.get("on"))
        .and_then(|o| o.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(evt, target)| {
                    let t = target
                        .as_str()
                        .or_else(|| target.get("target").and_then(|v| v.as_str()))?;
                    Some((evt.clone(), t.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    rsx! {
        div { class: "nav-child-panel chart-app-view", "data-aeon-scope": "chart-app-view", "data-aeon-state": "{state_name}",
            div { class: "connected-panel-head",
                h3 { "{app.name}" }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| on_back.call(()),
                    button::Label { "Close" }
                }
            }
            p { class: "settings-row-desc", "{app.summary}" }
            div { class: "chart-app-state-card",
                strong { class: "mono", "State: {state_name}" }
                if !copy.is_empty() {
                    p { class: "settings-row-desc", "{copy}" }
                }
                if !transitions.is_empty() {
                    div { class: "actions",
                        for (ev, target) in transitions {
                            {
                                let tgt = target.clone();
                                rsx! {
                                    button::Root {
                                        key: "{ev}-{target}",
                                        variant: button::ButtonVariant::Solid,
                                        class: "btn btn-primary",
                                        onclick: move |_| on_transition.call(tgt.clone()),
                                        button::Label { "{ev} → {target}" }
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

/// 1:1 port of `src/components/ReceivePanel.tsx`.
#[component]
pub fn ReceivePanel(profile: SessionSummary, mut toast: Signal<Option<ToastNotice>>) -> Element {
    let mut mode = use_signal(|| "address");
    let current_mode = *mode.read();
    let value = if current_mode == "peerpay" {
        format!("peerpay:{}", profile.identity_key)
    } else {
        profile.address.clone()
    };
    let qr_svg = render_qr_svg(&value);
    let val_for_qr = value.clone();
    let val_for_addr = value.clone();
    let val_for_btn = value.clone();

    rsx! {
        div {
            class: "nav-child-panel receive-panel",
            "data-aeon-scope": "receive",
            "data-chain": "bsv",
            div { class: "receive-layout",
                header { class: "receive-panel-intro",
                    h3 { class: "receive-panel-title", "Receive BSV" }
                }

                div { class: "receive-qr", "data-aeon-part": "media",
                    button {
                        r#type: "button",
                        class: "qr-frame receive-qr-frame",
                        title: "Click to copy",
                        onclick: move |_| match copy_to_clipboard(&val_for_qr) {
                            Ok(()) => toast.set(Some(ToastNotice {
                                title: "Copied".into(),
                                body: Some("Receive address copied.".into()),
                                tone: "success",
                            })),
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Copy failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        },
                        div { dangerous_inner_html: "{qr_svg}" }
                    }
                    div { class: "receive-mode-toggle", role: "group",
                        button {
                            r#type: "button",
                            class: "receive-mode-opt",
                            "data-active": if current_mode == "peerpay" { Some("") } else { None },
                            aria_pressed: current_mode == "peerpay",
                            onclick: move |_| mode.set("peerpay"),
                            "PeerPay"
                        }
                        button {
                            r#type: "button",
                            class: "receive-mode-opt",
                            "data-active": if current_mode == "address" { Some("") } else { None },
                            aria_pressed: current_mode == "address",
                            onclick: move |_| mode.set("address"),
                            "Address"
                        }
                    }
                }

                div { class: "receive-side",
                    div { class: "field receive-address-field",
                        label {
                            if current_mode == "peerpay" { "PeerPay link" } else { "BSV address" }
                        }
                        button {
                            r#type: "button",
                            class: "mono qr-value receive-address",
                            title: "Click to copy",
                            onclick: move |_| match copy_to_clipboard(&val_for_addr) {
                                Ok(()) => toast.set(Some(ToastNotice {
                                    title: "Copied".into(),
                                    body: Some("Copied to clipboard.".into()),
                                    tone: "success",
                                })),
                                Err(e) => toast.set(Some(ToastNotice {
                                    title: "Copy failed".into(),
                                    body: Some(e),
                                    tone: "error",
                                })),
                            },
                            "{value}"
                        }
                    }
                    p { class: "receive-eta-row", "data-native": "",
                        span { class: "receive-eta-label", "Arrival" }
                        strong { class: "receive-eta-value", "Instant · BSV" }
                    }
                }

                div { class: "actions receive-actions",
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        onclick: move |_| match copy_to_clipboard(&val_for_btn) {
                            Ok(()) => toast.set(Some(ToastNotice {
                                title: "Copied".into(),
                                body: Some("Copied to clipboard.".into()),
                                tone: "success",
                            })),
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Copy failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        },
                        button::Label {
                            if current_mode == "peerpay" { "Copy PeerPay" } else { "Copy address" }
                        }
                    }
                }
            }
        }
    }
}

#[component]
pub fn SwapPanel() -> Element {
    let mut network = use_signal(|| "bsv".to_string());
    rsx! {
        div { class: "nav-child-panel", "data-aeon-scope": "swap-panel", "data-aeon-state": "unavailable",
            crate::ui::swaps::NetworkPicker {
                value: network.read().clone(),
                on_change: move |next| network.set(next),
            }
            crate::ui::swaps::SwapOffersPanel {
                offers: Vec::new(),
                swap_gated: true,
            }
        }
    }
}

#[component]
pub fn ScanPanel(mut nav_child: Signal<Option<NavChild>>) -> Element {
    rsx! {
        div { class: "nav-child-panel",
            crate::ui::devices::QrScanner {
                hint: "Point your camera at a QR code".to_string(),
                on_scan: move |raw: String| nav_child.set(Some(NavChild::Send(Some(raw)))),
                on_cancel: move |_| nav_child.set(None),
            }
        }
    }
}

/// 1:1 port of `src/components/IdentityCards.tsx`.
#[component]
pub fn IdentityCards(
    cards: Vec<IdentityCardItem>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    rsx! {
        div {
            class: "id-deck",
            "data-aeon-scope": "identity-cards",
            aria_label: "Identity cards",
            for c in cards {
                {
                    let ik_copy = c.identity_key.clone();
                    let kind_label = if c.kind == "key" { "KEY" } else { "BRC-169" };
                    let own_str = if c.own { "true" } else { "false" };
                    let card_title = format!("Copy identity key\n{}", c.identity_key);
                    rsx! {
                        button {
                            key: "{c.id}",
                            r#type: "button",
                            class: "id-card",
                            "data-aeon-part": "card",
                            "data-aeon-state": "{c.kind}",
                            "data-own": "{own_str}",
                            title: "{card_title}",
                            onclick: move |_| {
                                if copy_to_clipboard(&ik_copy).is_ok() {
                                    toast.set(Some(ToastNotice {
                                        title: "Copied".into(),
                                        body: Some("Wallet key copied.".into()),
                                        tone: "success",
                                    }));
                                }
                            },
                            span { class: "id-card-top",
                                span { class: "id-card-title", "{c.title}" }
                                span { class: "id-card-kind", "{kind_label}" }
                            }
                            span { class: "id-card-chip", "aria-hidden": "true" }
                            span { class: "id-card-number mono",
                                for (i, g) in c.groups.iter().enumerate() {
                                    span { key: "{i}", "{g}" }
                                }
                            }
                            span { class: "id-card-bottom",
                                span { class: "id-card-holder", "{c.holder}" }
                                span { class: "id-card-mark", "aria-hidden": "true" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/IdentityPanel.tsx`, `src/components/IdentityCards.tsx`,
/// and `src/components/PublicIdentitiesPanel.tsx`.
#[component]
pub fn IdentityPanel(profile: SessionSummary, mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let rev = use_signal(|| 0u64);
    let _ = *rev.read();

    let details = services.load_identity_details(&profile);
    let cards = services.build_identity_cards(&profile);
    let qr_svg = render_qr_svg(&profile.identity_key);
    let claimed_handle =
        services.claimed_handle_for(&profile.chain, profile.account_index, &profile.identity_key);
    let handle_state = if claimed_handle.is_some() {
        "certificate"
    } else {
        "empty"
    };
    let bap_profile_id = details.bap_profile_id.clone();

    rsx! {
        div {
            class: "nav-section-body identity-nav nav-section-with-scroll",
            "data-aeon-scope": "identity",
            div { class: "connected-panel-head",
                h2 { "Identity" }
            }
            div { class: "nav-section-scroll-body",
                IdentityCards { cards, toast }

                section { class: "identity-card", aria_label: "Wallet identity",
                    div { class: "identity-hero",
                        div { class: "identity-qr",
                            div { class: "identity-qr-frame",
                                div { dangerous_inner_html: "{qr_svg}" }
                            }
                        }
                        section {
                            class: "handle-ipt",
                            "data-aeon-scope": "handle-ipt",
                            "data-aeon-state": "{handle_state}",
                            aria_label: "Handle",
                            header { "data-aeon-part": "head",
                                h3 { "data-aeon-part": "title", "Handle" }
                                span { "data-aeon-part": "profile", "iptnft" }
                            }
                            if let Some(ref handle_str) = claimed_handle {
                                {
                                    let h_copy = handle_str.clone();
                                    let h_title = format!("Click to copy {handle_str}");
                                    rsx! {
                                        div { "data-aeon-part": "held",
                                            button {
                                                r#type: "button",
                                                class: "identity-qr-handle",
                                                "data-aeon-part": "label",
                                                title: "{h_title}",
                                                onclick: move |_| {
                                                    if copy_to_clipboard(&h_copy).is_ok() {
                                                        toast.set(Some(ToastNotice {
                                                            title: "Copied".into(),
                                                            body: Some(format!("{h_copy} copied.")),
                                                            tone: "success",
                                                        }));
                                                    }
                                                },
                                                "{handle_str}"
                                            }
                                            span {
                                                "data-aeon-part": "owned",
                                                title: "Your BRC-169 certificate binds this handle to this wallet",
                                                "Owned"
                                            }
                                        }
                                    }
                                }
                            } else {
                                div { "data-aeon-part": "empty",
                                    p { class: "identity-handle-missing", "No handle yet." }
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost identity-claim-btn",
                                        onclick: move |_| {
                                            if let Err(e) = open_external_url("https://handcash.io") {
                                                toast.set(Some(ToastNotice {
                                                    title: "Claim handle".into(),
                                                    body: Some(e),
                                                    tone: "error",
                                                }));
                                            }
                                        },
                                        button::Label { "Claim handle" }
                                    }
                                }
                            }
                        }
                    }

                    ul { class: "identity-list",
                        li { class: "identity-field",
                            span { class: "identity-field-label", "Network" }
                            strong {
                                class: "identity-network",
                                "data-network": "{profile.chain}",
                                if profile.chain == "main" {
                                    "Bitcoin SV Mainnet"
                                } else {
                                    "Bitcoin SV Testnet"
                                }
                            }
                        }
                        if let Some(ref bap_id) = bap_profile_id {
                            li { class: "identity-field",
                                span { class: "identity-field-label", "Profile ID" }
                                strong {
                                    class: "mono identity-bap-id",
                                    title: "{bap_id}",
                                    ProfileIdenticon { id: bap_id.clone(), size: 16 }
                                    "{truncate_mid(bap_id, 10)}"
                                }
                            }
                        }
                    }
                    p { class: "identity-note",
                        if bap_profile_id.is_some() {
                            "People pay your wallet key. Your profile ID is the public name they check: a copycat can borrow your name and picture, never this ID."
                        } else {
                            "People pay your wallet key, and your profile is signed by it: a copycat can borrow your name and picture, never this key."
                        }
                    }
                }

                PublicIdentitiesPanel {
                    profile: profile.clone(),
                    rev,
                    toast,
                }
            }
        }
    }
}

/// 1:1 port of `src/components/PublicIdentitiesPanel.tsx`.
#[component]
pub fn PublicIdentitiesPanel(
    profile: SessionSummary,
    mut rev: Signal<u64>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let _ = *rev.read();

    // Modes: "browsing" | "composing" | "importing"
    let mut mode = use_signal(|| "browsing");
    let mut more_open = use_signal(|| false);
    let mut row_menu_key = use_signal(|| Option::<String>::None);
    let mut compose_key = use_signal(String::new);
    let mut draft_name = use_signal(String::new);
    let mut draft_bio = use_signal(String::new);
    let mut draft_image = use_signal(|| Option::<String>::None);
    let mut import_key_input = use_signal(String::new);
    let mut status_err = use_signal(|| Option::<String>::None);

    let cur_mode = *mode.read();
    let view = services.list_public_identities_view(&profile);
    let signs = view.signs_issuance;

    let svc_export = Arc::clone(&services);
    let svc_restore = Arc::clone(&services);
    let svc_toggle_sign = Arc::clone(&services);
    let svc_import_key = Arc::clone(&services);
    let svc_save_prof = Arc::clone(&services);
    let prof_export = profile.clone();
    let prof_restore = profile.clone();
    let prof_toggle = profile.clone();
    let prof_import = profile.clone();
    let prof_save = profile.clone();

    rsx! {
        section {
            class: "identity-card identity-compose",
            "data-aeon-scope": "public-identities",
            "data-aeon-state": "{cur_mode}",
            aria_label: "Public identities",
            div { "data-aeon-part": "actions", "data-aeon-state": "idle",
                if cur_mode == "browsing" {
                    div { class: "public-identities-head", "data-aeon-part": "head",
                        style: "position: relative;",
                        h3 { class: "identity-compose-title", "Public identities" }
                        button {
                            r#type: "button",
                            class: "btn btn-ghost public-identity-more",
                            aria_label: "Identity backup and import",
                            aria_expanded: *more_open.read(),
                            onclick: move |_| {
                                let next = !*more_open.read();
                                more_open.set(next);
                                row_menu_key.set(None);
                            },
                            "More"
                        }
                        if *more_open.read() {
                            div {
                                class: "wallet-account-dropdown",
                                style: "position: absolute; right: 0; top: 38px; z-index: 30; min-width: 210px; padding: 6px;",
                                role: "menu",
                                button {
                                    r#type: "button",
                                    class: "wallet-account-option",
                                    role: "menuitem",
                                    onclick: move |_| {
                                        more_open.set(false);
                                        match svc_export.export_public_identities_backup_json(&prof_export) {
                                            Ok(json_str) => {
                                                if let Some(path) = rfd::FileDialog::new()
                                                    .set_file_name("handcash-identities-backup.json")
                                                    .add_filter("JSON", &["json"])
                                                    .save_file()
                                                {
                                                    match std::fs::write(&path, json_str) {
                                                        Ok(()) => toast.set(Some(ToastNotice {
                                                            title: "Issuer backup saved".into(),
                                                            body: Some(path.display().to_string()),
                                                            tone: "success",
                                                        })),
                                                        Err(e) => status_err.set(Some(e.to_string())),
                                                    }
                                                }
                                            }
                                            Err(e) => status_err.set(Some(e)),
                                        }
                                    },
                                    "Back up identities"
                                }
                                button {
                                    r#type: "button",
                                    class: "wallet-account-option",
                                    role: "menuitem",
                                    onclick: move |_| {
                                        more_open.set(false);
                                        if let Some(path) = rfd::FileDialog::new()
                                            .add_filter("JSON", &["json"])
                                            .pick_file()
                                        {
                                            match std::fs::read_to_string(&path)
                                                .map_err(|e| e.to_string())
                                                .and_then(|raw| svc_restore.restore_public_identities_backup_json(&prof_restore, &raw))
                                            {
                                                Ok(msg) => {
                                                    status_err.set(None);
                                                    let n = *rev.read() + 1;
                                                    rev.set(n);
                                                    toast.set(Some(ToastNotice {
                                                        title: "Identities restored".into(),
                                                        body: Some(msg),
                                                        tone: "success",
                                                    }));
                                                }
                                                Err(e) => status_err.set(Some(e)),
                                            }
                                        }
                                    },
                                    "Restore backup"
                                }
                                button {
                                    r#type: "button",
                                    class: "wallet-account-option",
                                    role: "menuitem",
                                    onclick: move |_| {
                                        more_open.set(false);
                                        status_err.set(None);
                                        import_key_input.set(String::new());
                                        mode.set("importing");
                                    },
                                    "Import signing key"
                                }
                                button {
                                    r#type: "button",
                                    class: "wallet-account-option",
                                    role: "menuitem",
                                    onclick: move |_| {
                                        more_open.set(false);
                                        let next_signs = !signs;
                                        match svc_toggle_sign.set_signs_issuance(&prof_toggle, next_signs) {
                                            Ok(()) => {
                                                let n = *rev.read() + 1;
                                                rev.set(n);
                                                toast.set(Some(ToastNotice {
                                                    title: if next_signs {
                                                        "New mints are signed by your identity key".into()
                                                    } else {
                                                        "New mints will be unsigned".into()
                                                    },
                                                    body: None,
                                                    tone: "success",
                                                }));
                                            }
                                            Err(e) => status_err.set(Some(e)),
                                        }
                                    },
                                    if signs { "Issue new mints unsigned" } else { "Sign new mints" }
                                }
                            }
                        }
                    }

                    ul { class: "identity-list", "data-aeon-part": "records",
                        for row in view.rows.iter() {
                            {
                                let ik = row.identity_key.clone();
                                let ik_compose = row.identity_key.clone();
                                let ik_menu = row.identity_key.clone();
                                let ik_issuer = row.identity_key.clone();
                                let ik_present = row.identity_key.clone();
                                let ik_card = row.identity_key.clone();
                                let ik_copy = row.identity_key.clone();
                                let ik_remove = row.identity_key.clone();
                                let own = row.profile_source.as_deref() == Some("identity-key");
                                let rec_state = if own {
                                    "profile"
                                } else if row.profile_source.is_some() {
                                    "bap"
                                } else {
                                    "draft"
                                };
                                let display_name = row.name.clone().unwrap_or_else(|| "No profile".into());
                                let name_for_compose = row.name.clone().unwrap_or_default();
                                let bio_for_compose = row.description.clone().unwrap_or_default();
                                let img_for_compose = row.image_data_url.clone();
                                let img_avatar = row.image_data_url.clone();
                                let profile_id = row.identity_key.clone();
                                let is_issuer = row.is_selected_issuer;
                                let is_shown = row.is_presented;
                                let is_imported = row.signer == "imported";
                                let bap_pub = row.bap_published;
                                let has_prof = row.name.is_some();
                                let row_menu_open = row_menu_key.read().as_deref() == Some(ik.as_str());
                                let svc_row_iss = Arc::clone(&services);
                                let svc_row_pres = Arc::clone(&services);
                                let svc_row_card = Arc::clone(&services);
                                let svc_row_rm = Arc::clone(&services);
                                let prof_row_iss = profile.clone();
                                let prof_row_pres = profile.clone();
                                let prof_row_card = profile.clone();
                                let prof_row_rm = profile.clone();
                                let more_aria = format!("More for {}", row.name.as_deref().unwrap_or("this identity"));

                                rsx! {
                                    li {
                                        key: "{ik}",
                                        "data-aeon-part": "record",
                                        "data-aeon-state": "{rec_state}",
                                        style: "position: relative;",
                                        span { class: "public-identity-avatar", "aria-hidden": "true",
                                            if let Some(ref src) = img_avatar {
                                                img {
                                                    src: "{src}",
                                                    alt: "",
                                                    width: "44",
                                                    height: "44",
                                                    style: "border-radius: 50%; object-fit: cover;",
                                                }
                                            } else {
                                                ProfileIdenticon { id: profile_id.clone(), size: 44 }
                                            }
                                        }
                                        div { class: "public-identity-main",
                                            strong { class: "public-identity-name", "{display_name}" }
                                            span {
                                                class: "public-identity-bap mono",
                                                title: "{profile_id}",
                                                "{truncate_mid(&profile_id, 10)}"
                                            }
                                            if let Some(ref desc) = row.description {
                                                p { class: "public-identity-bio", "{desc}" }
                                            }
                                            span { class: "public-identity-chips", "data-aeon-part": "chips",
                                                if is_issuer {
                                                    span {
                                                        "data-aeon-part": "chip",
                                                        "data-aeon-state": if signs { "issuer" } else { "unsigned" },
                                                        if signs { "Issuer" } else { "Mints unsigned" }
                                                    }
                                                }
                                                if is_shown {
                                                    span {
                                                        "data-aeon-part": "chip",
                                                        "data-aeon-state": "shown",
                                                        "Shared with contacts"
                                                    }
                                                }
                                                if bap_pub && own {
                                                    span {
                                                        "data-aeon-part": "chip",
                                                        "data-aeon-state": "bap",
                                                        "On BAP"
                                                    }
                                                }
                                                if is_imported {
                                                    span {
                                                        "data-aeon-part": "chip",
                                                        "data-aeon-state": "imported",
                                                        "Imported key"
                                                    }
                                                }
                                            }
                                        }
                                        div { class: "public-identity-actions",
                                            button::Root {
                                                variant: if own { button::ButtonVariant::Ghost } else { button::ButtonVariant::Solid },
                                                class: if own { "btn btn-ghost" } else { "btn btn-primary" },
                                                onclick: move |_| {
                                                    status_err.set(None);
                                                    more_open.set(false);
                                                    row_menu_key.set(None);
                                                    compose_key.set(ik_compose.clone());
                                                    draft_name.set(name_for_compose.clone());
                                                    draft_bio.set(bio_for_compose.clone());
                                                    draft_image.set(img_for_compose.clone());
                                                    mode.set("composing");
                                                },
                                                button::Label { if own { "Edit" } else { "Add profile" } }
                                            }
                                            button {
                                                r#type: "button",
                                                class: "btn btn-ghost public-identity-more",
                                                aria_label: "{more_aria}",
                                                onclick: move |_| {
                                                    more_open.set(false);
                                                    let cur = row_menu_key.read().clone();
                                                    if cur.as_deref() == Some(ik_menu.as_str()) {
                                                        row_menu_key.set(None);
                                                    } else {
                                                        row_menu_key.set(Some(ik_menu.clone()));
                                                    }
                                                },
                                                "⋯"
                                            }
                                            if row_menu_open {
                                                div {
                                                    class: "wallet-account-dropdown",
                                                    style: "position: absolute; right: 0; top: 48px; z-index: 30; min-width: 210px; padding: 6px;",
                                                    role: "menu",
                                                    if !is_issuer {
                                                        button {
                                                            r#type: "button",
                                                            class: "wallet-account-option",
                                                            role: "menuitem",
                                                            onclick: move |_| {
                                                                row_menu_key.set(None);
                                                                if let Err(e) = svc_row_iss.select_public_identity_issuer(&prof_row_iss, &ik_issuer) {
                                                                    status_err.set(Some(e));
                                                                } else {
                                                                    let n = *rev.read() + 1;
                                                                    rev.set(n);
                                                                }
                                                            },
                                                            "Use as issuer"
                                                        }
                                                    }
                                                    if has_prof && !is_shown {
                                                        button {
                                                            r#type: "button",
                                                            class: "wallet-account-option",
                                                            role: "menuitem",
                                                            onclick: move |_| {
                                                                row_menu_key.set(None);
                                                                if let Err(e) = svc_row_pres.present_public_identity(&prof_row_pres, &ik_present) {
                                                                    status_err.set(Some(e));
                                                                } else {
                                                                    let n = *rev.read() + 1;
                                                                    rev.set(n);
                                                                    toast.set(Some(ToastNotice {
                                                                        title: "Profile shared with contacts".into(),
                                                                        body: None,
                                                                        tone: "success",
                                                                    }));
                                                                }
                                                            },
                                                            "Share this one instead"
                                                        }
                                                    }
                                                    if has_prof && is_shown {
                                                        button {
                                                            r#type: "button",
                                                            class: "wallet-account-option",
                                                            role: "menuitem",
                                                            onclick: move |_| {
                                                                row_menu_key.set(None);
                                                                match svc_row_card.export_identity_card_json(&prof_row_card, &ik_card) {
                                                                    Ok(card_json) => {
                                                                        if let Some(path) = rfd::FileDialog::new()
                                                                            .set_file_name("handcash-identity-card.json")
                                                                            .add_filter("JSON", &["json"])
                                                                            .save_file()
                                                                        {
                                                                            match std::fs::write(&path, card_json) {
                                                                                Ok(()) => toast.set(Some(ToastNotice {
                                                                                    title: "Identity card saved".into(),
                                                                                    body: Some(path.display().to_string()),
                                                                                    tone: "success",
                                                                                })),
                                                                                Err(e) => status_err.set(Some(e.to_string())),
                                                                            }
                                                                        }
                                                                    }
                                                                    Err(e) => status_err.set(Some(e)),
                                                                }
                                                            },
                                                            "Share identity card"
                                                        }
                                                    }
                                                    button {
                                                        r#type: "button",
                                                        class: "wallet-account-option",
                                                        role: "menuitem",
                                                        onclick: move |_| {
                                                            row_menu_key.set(None);
                                                            if copy_to_clipboard(&ik_copy).is_ok() {
                                                                toast.set(Some(ToastNotice {
                                                                    title: "Copied".into(),
                                                                    body: Some("Issuer wallet key copied.".into()),
                                                                    tone: "success",
                                                                }));
                                                            }
                                                        },
                                                        "Copy wallet key"
                                                    }
                                                    if is_imported {
                                                        button {
                                                            r#type: "button",
                                                            class: "wallet-account-option",
                                                            role: "menuitem",
                                                            onclick: move |_| {
                                                                row_menu_key.set(None);
                                                                match svc_row_rm.remove_imported_public_identity(&prof_row_rm, &ik_remove) {
                                                                    Ok(()) => {
                                                                        let n = *rev.read() + 1;
                                                                        rev.set(n);
                                                                        toast.set(Some(ToastNotice {
                                                                            title: "Signer removed".into(),
                                                                            body: None,
                                                                            tone: "info",
                                                                        }));
                                                                    }
                                                                    Err(e) => status_err.set(Some(e)),
                                                                }
                                                            },
                                                            "Remove signer"
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
                } else if cur_mode == "importing" {
                    h3 { class: "identity-compose-title", "Import signing key" }
                    div { class: "field identity-compose-field",
                        label { r#for: "public-identity-import-key", "Private key" }
                        input {
                            id: "public-identity-import-key",
                            r#type: "password",
                            placeholder: "64-character hex private key",
                            autocomplete: "off",
                            value: "{import_key_input}",
                            oninput: move |e| import_key_input.set(e.value()),
                        }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            disabled: import_key_input.read().trim().is_empty(),
                            onclick: move |_| {
                                status_err.set(None);
                                let raw = import_key_input.read().clone();
                                match svc_import_key.import_issuer_private_key(&prof_import, &raw) {
                                    Ok(_) => {
                                        import_key_input.set(String::new());
                                        mode.set("browsing");
                                        let n = *rev.read() + 1;
                                        rev.set(n);
                                        toast.set(Some(ToastNotice {
                                            title: "Signing key imported".into(),
                                            body: None,
                                            tone: "success",
                                        }));
                                    }
                                    Err(e) => status_err.set(Some(e)),
                                }
                            },
                            button::Label { "Import" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                import_key_input.set(String::new());
                                status_err.set(None);
                                mode.set("browsing");
                            },
                            button::Label { "Cancel" }
                        }
                    }
                } else {
                    {
                        let target_ik = compose_key.read().clone();
                        let is_edit = view
                            .rows
                            .iter()
                            .find(|r| r.identity_key == target_ik)
                            .and_then(|r| r.profile_source.as_deref())
                            == Some("identity-key");
                        let cur_img = draft_image.read().clone();
                        let name_empty = draft_name.read().trim().is_empty();
                        rsx! {
                            h3 { class: "identity-compose-title",
                                if is_edit { "Edit profile" } else { "Add profile" }
                            }
                            p { class: "identity-note",
                                "Signed by this identity key and kept on this device; contacts get it with your identity card. No transaction, no fee."
                            }
                            div { class: "public-identity-compose", "data-aeon-part": "compose",
                                div { class: "public-identity-image-col",
                                    button {
                                        r#type: "button",
                                        class: "public-identity-image-pick",
                                        "data-aeon-part": "image",
                                        "data-aeon-state": if cur_img.is_some() { "set" } else { "empty" },
                                        aria_label: if cur_img.is_some() { "Change image" } else { "Choose image" },
                                        onclick: move |_| {
                                            if let Some(path) = rfd::FileDialog::new()
                                                .add_filter("Image (PNG / JPEG / WebP)", &["png", "jpg", "jpeg", "webp"])
                                                .pick_file()
                                            {
                                                match std::fs::read(&path) {
                                                    Ok(bytes) => {
                                                        if bytes.len() > 65_536 {
                                                            status_err.set(Some("Choose an image 64 KB or smaller.".into()));
                                                            return;
                                                        }
                                                        let ext = path
                                                            .extension()
                                                            .and_then(|e| e.to_str())
                                                            .unwrap_or("png")
                                                            .to_ascii_lowercase();
                                                        let mime = match ext.as_str() {
                                                            "jpg" | "jpeg" => "image/jpeg",
                                                            "webp" => "image/webp",
                                                            _ => "image/png",
                                                        };
                                                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                                                        draft_image.set(Some(format!("data:{mime};base64,{b64}")));
                                                        status_err.set(None);
                                                    }
                                                    Err(e) => status_err.set(Some(e.to_string())),
                                                }
                                            }
                                        },
                                        if let Some(ref src) = cur_img {
                                            img {
                                                src: "{src}",
                                                alt: "",
                                                width: "88",
                                                height: "88",
                                                style: "object-fit: cover; border-radius: 12px;",
                                            }
                                        } else {
                                            span { "aria-hidden": "true", "+" }
                                        }
                                        span { class: "public-identity-image-label",
                                            if cur_img.is_some() { "Change" } else { "Image" }
                                        }
                                    }
                                    if cur_img.is_some() {
                                        button::Root {
                                            variant: button::ButtonVariant::Ghost,
                                            class: "btn btn-ghost public-identity-image-clear",
                                            onclick: move |_| draft_image.set(None),
                                            button::Label { "Remove" }
                                        }
                                    }
                                }
                                div { class: "public-identity-compose-fields",
                                    div { class: "field identity-compose-field",
                                        label { r#for: "public-identity-name", "Name" }
                                        input {
                                            id: "public-identity-name",
                                            maxlength: "64",
                                            value: "{draft_name}",
                                            oninput: move |e| draft_name.set(e.value()),
                                        }
                                    }
                                    div { class: "field identity-compose-field",
                                        label { r#for: "public-identity-bio", "Bio" }
                                        input {
                                            id: "public-identity-bio",
                                            maxlength: "160",
                                            placeholder: "Optional",
                                            value: "{draft_bio}",
                                            oninput: move |e| draft_bio.set(e.value()),
                                        }
                                    }
                                }
                            }
                            div { class: "actions",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: name_empty,
                                    onclick: move |_| {
                                        status_err.set(None);
                                        let tik = compose_key.read().clone();
                                        let n = draft_name.read().clone();
                                        let b = draft_bio.read().clone();
                                        let img = draft_image.read().clone();
                                        match svc_save_prof.save_public_identity_profile(
                                            &prof_save,
                                            &tik,
                                            &n,
                                            &b,
                                            img.as_deref(),
                                        ) {
                                            Ok(()) => {
                                                mode.set("browsing");
                                                let next = *rev.read() + 1;
                                                rev.set(next);
                                                toast.set(Some(ToastNotice {
                                                    title: "Profile saved".into(),
                                                    body: None,
                                                    tone: "success",
                                                }));
                                            }
                                            Err(e) => status_err.set(Some(e)),
                                        }
                                    },
                                    button::Label { "Save" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        status_err.set(None);
                                        mode.set("browsing");
                                    },
                                    button::Label { "Cancel" }
                                }
                            }
                        }
                    }
                }
                if let Some(ref err) = *status_err.read() {
                    p { role: "alert", class: "identity-compose-status error", "{err}" }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/SettingsPanel.tsx`.
#[component]
pub fn SettingsPanel(
    snap: WalletSnapshot,
    mut appearance: Signal<AppearancePreference>,
    mut nav_child: Signal<Option<NavChild>>,
    fiat_code: Signal<FiatCode>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let app_pref = *appearance.read();
    let mut accepted = use_signal(|| services.load_accepted_coins());
    let accepted_now = *accepted.read();
    let mut sfx_enabled = use_signal(|| services.sfx_enabled());
    let sfx_now = *sfx_enabled.read();
    let mut updater_rev = use_signal(|| 0u64);
    let _ = *updater_rev.read();
    let updater_status = services.updater.status();
    let upd_state = updater_status
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("idle")
        .to_string();
    let upd_avail_ver = updater_status
        .get("availableVersion")
        .and_then(|v| v.as_str())
        .map(ToString::to_string);
    let mut open = move |sub: SettingSubpage| nav_child.set(Some(NavChild::Setting(sub)));
    let health = use_dependency_health();
    {
        let svc = Arc::clone(&services);
        use_hook(move || spawn_health_refresh(&svc, None));
    }
    let health_view = health.read().clone();
    let health_alert = dependency_health_alert(&health_view);
    let alerting = matches!(health_alert, HealthAlert::Warn | HealthAlert::Error);
    let health_desc = if health_view.at == 0 {
        "Checking…".to_string()
    } else {
        health_view.summary.clone()
    };

    rsx! {
        div {
            class: "nav-section-body settings-nav settings-with-scroll",
            "data-aeon-scope": "settings",
            div { class: "connected-panel-head settings-panel-head",
                h2 { "Settings" }
            }
            div { class: "settings-scroll-body",
                // HandCash Recovery section
                section { class: "settings-group", "data-aeon-part": "handcash-recovery",
                    h3 { class: "settings-group-title", "HandCash Recovery" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Back this up on another device",
                            description: "Each device keeps a full copy",
                            icon: setting_icon(SettingSubpage::HandCashRecovery),
                            onclick: move |_| open(SettingSubpage::HandCashRecovery),
                        }
                    }
                }

                // Security section (`SECURITY_ITEMS` in SettingsPanel.tsx)
                section { class: "settings-group", "data-aeon-part": "security",
                    h3 { class: "settings-group-title", "Security" }
                    ul { class: "settings-list",
                        for (sub, label, description) in SECURITY_ITEMS {
                            SettingsNavRow {
                                key: "{label}",
                                label,
                                description,
                                tone: setting_tone(sub),
                                icon: setting_icon(sub),
                                onclick: move |_| open(sub),
                            }
                        }
                    }
                }

                // Preferences section
                crate::ui::primitives::SettingsSection {
                    title: "Preferences".to_string(),
                    part: "preferences",
                    ul { class: "settings-list",
                        crate::ui::primitives::SettingsControlRow {
                            icon: Some(rsx! { PaletteIcon { size: 20 } }),
                            label: "Appearance".to_string(),
                            description: Some(match app_pref {
                                AppearancePreference::System => "Follows Omarchy or your system theme.".to_string(),
                                AppearancePreference::Dark => "HandCash OLED dark sheet.".to_string(),
                                AppearancePreference::Light => "HandCash light paper sheet.".to_string(),
                            }),
                            crate::ui::primitives::SettingsIconToggle {
                                aria_label: "Appearance".to_string(),
                                value: match app_pref {
                                    AppearancePreference::System => "system".to_string(),
                                    AppearancePreference::Dark => "dark".to_string(),
                                    AppearancePreference::Light => "light".to_string(),
                                },
                                on_change: {
                                    let svc_app = Arc::clone(&services);
                                    move |next: String| {
                                        let pref = match next.as_str() {
                                            "dark" => AppearancePreference::Dark,
                                            "light" => AppearancePreference::Light,
                                            _ => AppearancePreference::System,
                                        };
                                        appearance.set(pref);
                                        svc_app.save_appearance(pref);
                                    }
                                },
                                options: vec![
                                    crate::ui::primitives::SettingsIconToggleOption {
                                        value: "system".to_string(),
                                        label: "System".to_string(),
                                        icon: rsx! { MonitorIcon { size: 16 } },
                                    },
                                    crate::ui::primitives::SettingsIconToggleOption {
                                        value: "dark".to_string(),
                                        label: "Dark".to_string(),
                                        icon: rsx! { DarkModeIcon { size: 16 } },
                                    },
                                    crate::ui::primitives::SettingsIconToggleOption {
                                        value: "light".to_string(),
                                        label: "Light".to_string(),
                                        icon: rsx! { LightModeIcon { size: 16 } },
                                    },
                                ],
                            }
                        }

                        crate::ui::primitives::SettingsControlRow {
                            icon: Some(rsx! { CoinGlyphIcon { size: 20 } }),
                            label: "Accept".to_string(),
                            description: Some(format!("{}. {}", accepted_now.title(), accepted_now.description())),
                            crate::ui::primitives::SettingsIconToggle {
                                aria_label: "Accept".to_string(),
                                value: accepted_now.as_str().to_string(),
                                on_change: {
                                    let svc_coins = Arc::clone(&services);
                                    move |next: String| {
                                        let choice = if next == "all" {
                                            AcceptedCoins::All
                                        } else {
                                            AcceptedCoins::Bitcoin
                                        };
                                        accepted.set(choice);
                                        svc_coins.save_accepted_coins(choice);
                                    }
                                },
                                options: vec![
                                    crate::ui::primitives::SettingsIconToggleOption {
                                        value: "bitcoin".to_string(),
                                        label: AcceptedCoins::Bitcoin.title().to_string(),
                                        icon: rsx! { CoinGlyphIcon { size: 16 } },
                                    },
                                    crate::ui::primitives::SettingsIconToggleOption {
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

                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Leading {
                                    span { class: "settings-row-icon", "data-tone": "default",
                                        ArcUsdGlyphIcon { size: 20 }
                                    }
                                }
                                list_row::Label { "Currency" }
                                list_row::Description { "Currency for balances and totals." }
                                list_row::Trailing {
                                    SettingsFiatDropdown { fiat_code }
                                }
                            }
                        }

                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Leading {
                                    span { class: "settings-row-icon", "data-tone": "default",
                                        VolumeUpIcon { size: 20 }
                                    }
                                }
                                list_row::Label { "Sound effects" }
                                list_row::Description { "Subtle audio feedback for payments and actions." }
                                list_row::Trailing {
                                    {
                                        let svc_sfx = Arc::clone(&services);
                                        rsx! {
                                            button {
                                                r#type: "button",
                                                role: "switch",
                                                aria_checked: sfx_now,
                                                class: "settings-icon-toggle-btn",
                                                style: "padding: 4px 10px; min-width: 52px;",
                                                "data-selected": if sfx_now { Some("") } else { None },
                                                onclick: move |_| {
                                                    let next = !sfx_now;
                                                    sfx_enabled.set(next);
                                                    svc_sfx.set_sfx_enabled(next);
                                                },
                                                if sfx_now { "On" } else { "Off" }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Leading {
                                    span { class: "settings-row-icon", "data-tone": "default",
                                        InfoIcon { size: 20 }
                                    }
                                }
                                list_row::Label { "Version {APP_VERSION}" }
                                list_row::Description {
                                    if let Some(ref ver) = upd_avail_ver {
                                        "Update v{ver} available ({upd_state})"
                                    } else if upd_state != "idle" {
                                        "Updater: {upd_state} · Pure-Rust SQLite WAL"
                                    } else {
                                        "Pure-Rust SQLite WAL · Engine phase {snap.engine_phase}"
                                    }
                                }
                                list_row::Trailing {
                                    {
                                        let svc_upd = Arc::clone(&services);
                                        let has_avail = upd_avail_ver.is_some() && upd_state == "available";
                                        rsx! {
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost settings-action-btn",
                                                disabled: upd_state == "checking" || upd_state == "downloading",
                                                onclick: move |_| {
                                                    if has_avail {
                                                        svc_upd.updater.download();
                                                    } else {
                                                        svc_upd.updater.check(false);
                                                    }
                                                    let next = *updater_rev.read() + 1;
                                                    updater_rev.set(next);
                                                },
                                                button::Label {
                                                    if has_avail {
                                                        "Download"
                                                    } else if upd_state == "checking" {
                                                        "Checking…"
                                                    } else if upd_state == "downloading" {
                                                        "Downloading…"
                                                    } else {
                                                        "Check updates"
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

                // Apps section
                section { class: "settings-group", "data-aeon-part": "chart-apps",
                    h3 { class: "settings-group-title", "Apps" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Apps",
                            description: CHART_APPS_DESCRIPTION,
                            icon: setting_icon(SettingSubpage::ChartApps),
                            onclick: move |_| open(SettingSubpage::ChartApps),
                        }
                    }
                }

                // Support section
                section { class: "settings-group", "data-aeon-part": "support",
                    h3 { class: "settings-group-title", "Support" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Wallet health",
                            description: if alerting { String::new() } else { health_desc.clone() },
                            status: if alerting { Some(health_desc.clone()) } else { None },
                            status_tone: "warn",
                            icon: setting_icon(SettingSubpage::WalletHealth),
                            onclick: move |_| open(SettingSubpage::WalletHealth),
                            trailing_end: if alerting {
                                Some(rsx! { WalletHealthAlertBadge { tone: health_alert.as_str() } })
                            } else {
                                None
                            },
                        }
                        SettingsNavRow {
                            label: "Recover from transaction",
                            description: "Claim a token or item by its txid",
                            icon: setting_icon(SettingSubpage::RecoverTx),
                            onclick: move |_| open(SettingSubpage::RecoverTx),
                        }
                        SettingsNavRow {
                            label: "Session logs",
                            description: "View, copy, and open log folder",
                            icon: setting_icon(SettingSubpage::Logs),
                            onclick: move |_| open(SettingSubpage::Logs),
                        }
                        SettingsNavRow {
                            label: "Statecharts",
                            description: "Live app and engine state",
                            icon: setting_icon(SettingSubpage::Statecharts),
                            onclick: move |_| open(SettingSubpage::Statecharts),
                        }
                    }
                }

                // Labs section
                section { class: "settings-group", "data-aeon-part": "labs",
                    h3 { class: "settings-group-title", "Labs" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "Labs",
                            description: "Experimental features, off by default",
                            icon: setting_icon(SettingSubpage::Labs),
                            onclick: move |_| open(SettingSubpage::Labs),
                        }
                    }
                }

                // About section
                section { class: "settings-group", "data-aeon-part": "about",
                    h3 { class: "settings-group-title", "About" }
                    ul { class: "settings-list",
                        SettingsNavRow {
                            label: "HandCash",
                            description: "Desktop wallet",
                            icon: setting_icon(SettingSubpage::About),
                            onclick: move |_| open(SettingSubpage::About),
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/settings/SettingsFiatDropdown.tsx`. Shares the
/// 1:1 port of `src/components/settings/SettingsFiatDropdown.tsx`, sharing the
/// durable `fiat_code` signal with the hero `FiatCurrencyMenu`.
#[component]
pub fn SettingsFiatDropdown(mut fiat_code: Signal<FiatCode>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut open = use_signal(|| false);
    let is_open = *open.read();
    let current = *fiat_code.read();

    rsx! {
        div {
            class: "wallet-account-menu settings-fiat-menu",
            "data-aeon-scope": "wallet-account-menu",
            "data-aeon-state": if is_open { "open" } else { "closed" },
            onkeydown: move |e: KeyboardEvent| {
                if e.key() == Key::Escape {
                    open.set(false);
                }
            },
            button {
                r#type: "button",
                class: "wallet-hero-identity settings-fiat-trigger",
                "data-aeon-part": "trigger",
                aria_controls: "settings-fiat-dropdown",
                aria_expanded: is_open,
                aria_haspopup: "listbox",
                aria_label: "Currency: {current.iso()}",
                onclick: move |_| open.set(!is_open),
                span { class: "settings-fiat-flag", aria_hidden: true, "{current.flag()}" }
                span { "{current.iso()}" }
                ExpandMoreIcon {
                    size: 16,
                    class: if is_open { "wallet-account-caret is-open" } else { "wallet-account-caret" },
                }
            }
            if is_open {
                section {
                    id: "settings-fiat-dropdown",
                    class: "wallet-account-dropdown settings-fiat-dropdown",
                    "data-aeon-part": "content",
                    aria_label: "Choose currency",
                    header { class: "wallet-account-heading",
                        div { strong { "Choose currency" } }
                        span { class: "wallet-account-count", "{FiatCode::ALL.len()}" }
                    }
                    ul { class: "wallet-account-list", role: "listbox", aria_label: "Government currency",
                        for opt in FiatCode::ALL {
                            {
                                let selected = opt == current;
                                let svc = Arc::clone(&services);
                                rsx! {
                                    li { key: "{opt.as_str()}", role: "none",
                                        button {
                                            r#type: "button",
                                            role: "option",
                                            aria_selected: selected,
                                            class: if selected { "wallet-account-option is-selected" } else { "wallet-account-option" },
                                            onclick: move |_| {
                                                fiat_code.set(opt);
                                                svc.save_fiat_currency(opt);
                                                if svc.current_fx_rates().rate_for(opt).is_none() {
                                                    let svc_bg = Arc::clone(&svc);
                                                    svc.engine.runtime_handle().spawn(async move {
                                                        svc_bg.refresh_fx_rates_async().await;
                                                    });
                                                }
                                                open.set(false);
                                            },
                                            span { class: "wallet-account-option-lead",
                                                span { class: "settings-fiat-flag", aria_hidden: true, "{opt.flag()}" }
                                                span { class: "wallet-account-option-copy",
                                                    strong { "{opt.iso()}" }
                                                    span { "{opt.name()}" }
                                                }
                                            }
                                            if selected {
                                                CheckIcon { size: 17, class: "wallet-account-option-check" }
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

/// Mirrors `CHART_APPS_DESCRIPTION` in `src/apps/chartFormat.ts`.
const CHART_APPS_DESCRIPTION: &str =
    "Small single-purpose apps your wallet runs itself. Not a replacement for websites.";

/// 1:1 port of `SECURITY_ITEMS` in `src/components/SettingsPanel.tsx`.
const SECURITY_ITEMS: [(SettingSubpage, &str, &str); 7] = [
    (
        SettingSubpage::Backup,
        "Recovery backup",
        "Save your phrase or key slices",
    ),
    (
        SettingSubpage::HistoryBackup,
        "History",
        "Required for recovery",
    ),
    (
        SettingSubpage::DeviceHandoff,
        "Device backup",
        "Keep a copy on your other device",
    ),
    (
        SettingSubpage::SigninEmail,
        "Sign-in email",
        "For new devices that can\u{2019}t reach this one",
    ),
    (
        SettingSubpage::Import,
        "Import",
        "HandCash, Twetch, Yours, phrases and keys",
    ),
    (
        SettingSubpage::Unlock,
        "Unlock",
        "Device lock or HandCash password",
    ),
    (
        SettingSubpage::WipeWallet,
        "Wipe wallet",
        "Remove from this device",
    ),
];

/// Port of `settingIconFor` tone in `src/components/settings/settingIcons.tsx`.
fn setting_tone(sub: SettingSubpage) -> &'static str {
    match sub {
        SettingSubpage::WipeWallet => "danger",
        _ => "default",
    }
}

/// Port of `settingIconFor` icon in `src/components/settings/settingIcons.tsx`.
fn setting_icon(sub: SettingSubpage) -> Element {
    match sub {
        SettingSubpage::Backup | SettingSubpage::HandCashRecovery => {
            rsx! { EncryptIcon { size: 20 } }
        }
        SettingSubpage::HistoryBackup => rsx! { DownloadIcon { size: 20 } },
        SettingSubpage::DeviceHandoff | SettingSubpage::SigninEmail => {
            rsx! { DevicesIcon { size: 20 } }
        }
        SettingSubpage::Import | SettingSubpage::RecoverTx => rsx! { RefreshIcon { size: 20 } },
        SettingSubpage::Unlock => rsx! { LockIcon { size: 20 } },
        SettingSubpage::WipeWallet => rsx! { WarningIcon { size: 20 } },
        SettingSubpage::About => rsx! { LaunchIcon { size: 20 } },
        SettingSubpage::Statecharts | SettingSubpage::WalletHealth => {
            rsx! { ActivityIcon { size: 20 } }
        }
        SettingSubpage::Logs => rsx! { FileIcon { size: 20 } },
        SettingSubpage::Labs => rsx! { CodeIcon { size: 20 } },
        SettingSubpage::ChartApps => rsx! { AppsIcon { size: 20 } },
    }
}

#[component]
pub fn SettingsNavRow(
    label: &'static str,
    #[props(into, default)] description: String,
    /// Live status replaces the description (`status || description` in TS).
    #[props(default)]
    status: Option<String>,
    #[props(default = "muted")] status_tone: &'static str,
    #[props(default = "default")] tone: &'static str,
    icon: Element,
    onclick: EventHandler<MouseEvent>,
    #[props(default)] trailing_end: Option<Element>,
) -> Element {
    let desc_state = if status.is_some() {
        status_tone
    } else {
        "idle"
    };
    let desc = status.unwrap_or(description);
    rsx! {
        li { class: "settings-nav-item",
            button {
                r#type: "button",
                class: "settings-nav-row",
                "data-aeon-scope": "listRow",
                "data-aeon-part": "root",
                onclick: move |evt| onclick.call(evt),
                span {
                    "aria-hidden": "true",
                    "data-aeon-scope": "listRow",
                    "data-aeon-part": "leading",
                    span {
                        "aria-hidden": "true",
                        class: "settings-row-icon",
                        "data-tone": "{tone}",
                        {icon}
                    }
                }
                list_row::Label { "{label}" }
                if !desc.is_empty() {
                    list_row::Description { "data-aeon-state": "{desc_state}", "{desc}" }
                }
                if let Some(end) = trailing_end {
                    list_row::Trailing { {end} }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/settings/WalletHealthAlertBadge.tsx`.
#[component]
pub fn WalletHealthAlertBadge(tone: &'static str) -> Element {
    rsx! {
        div { class: "settings-icon-toggle wallet-health-trailing", aria_hidden: "true",
            span {
                class: "settings-icon-toggle-btn wallet-health-alert",
                "data-tone": "{tone}",
                "data-selected": "",
                WarningIcon { size: 16 }
            }
        }
    }
}

/// Live dependency-health snapshot (`subscribeDependencyHealth`).
fn use_dependency_health() -> Signal<DependencyHealthSnapshot> {
    let services = use_context::<Arc<AppServices>>();
    let mut snap = use_signal(|| services.dependency_health());
    use_future(move || {
        let svc = Arc::clone(&services);
        async move {
            let mut rx = svc.subscribe_dependency_health();
            while rx.changed().await.is_ok() {
                snap.set(rx.borrow().clone());
            }
        }
    });
    snap
}

/// Fire one probe pass on the engine runtime; `done` flips back when it lands.
fn spawn_health_refresh(services: &Arc<AppServices>, mut running: Option<Signal<bool>>) {
    if let Some(r) = running.as_mut() {
        r.set(true);
    }
    let svc = Arc::clone(services);
    let handle = svc.engine.runtime_handle().clone();
    let task = handle.spawn(async move {
        svc.refresh_dependency_health_async().await;
    });
    if let Some(mut r) = running {
        spawn(async move {
            let _ = task.await;
            r.set(false);
        });
    }
}

/// 1:1 port of `src/components/settings/WalletHealthPanel.tsx`.
#[component]
fn WalletHealthPanel(
    mut snapshot: Signal<WalletSnapshot>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let snap = use_dependency_health();
    let checking = use_signal(|| false);
    let mut heal_state = use_signal(|| "idle");
    let mut heal_summary = use_signal(|| Option::<String>::None);
    {
        let svc = Arc::clone(&services);
        use_hook(move || spawn_health_refresh(&svc, Some(checking)));
    }
    let is_checking = *checking.read();
    let view = snap.read().clone();
    let svc_btn = Arc::clone(&services);
    let svc_heal = Arc::clone(&services);
    let cur_heal_state = *heal_state.read();
    let cur_heal_msg = heal_summary.read().clone();

    rsx! {
        div { class: "nav-section-body settings-nav", "data-aeon-scope": "wallet-health",
            div { class: "connected-panel-head settings-panel-head",
                h2 { "Wallet health" }
                div {
                    class: "connected-panel-head-actions",
                    "data-aeon-part": "health-actions",
                    "data-aeon-state": if is_checking { "running" } else { "idle" },
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary settings-action-btn",
                        disabled: is_checking,
                        onclick: move |_| spawn_health_refresh(&svc_btn, Some(checking)),
                        button::Label { if is_checking { "Checking…" } else { "Refresh" } }
                    }
                }
            }

            ul { class: "settings-list",
                for probe in view.probes.iter() {
                    li { key: "{probe.id}",
                        list_row::Root { "data-aeon-layout": "control",
                            list_row::Label { "{probe.label}" }
                            list_row::Description {
                                if is_checking && view.at == 0 { "…" } else { "{probe.detail}" }
                            }
                            list_row::Trailing {
                                span {
                                    class: "status-pill status-pill-compact",
                                    "data-tone": "{probe.status.tone()}",
                                    "data-aeon-state": "{probe.status.as_str()}",
                                    "{probe.status.label()}"
                                }
                            }
                        }
                    }
                }
            }

            section { class: "settings-group", "data-aeon-part": "utxo-heal",
                h3 { class: "settings-group-title", "Local recovery" }
                ul { class: "settings-list",
                    li {
                        list_row::Root { "data-aeon-layout": "control",
                            list_row::Leading {
                                span { class: "settings-row-icon", "data-tone": "default",
                                    SystemUpdateIcon { size: 20 }
                                }
                            }
                            list_row::Label { "Heal wallet UTXOs" }
                            list_row::Description {
                                if let Some(ref msg) = cur_heal_msg {
                                    "{msg}"
                                } else {
                                    "Snapshots local UTXOs to the write-once BRC-39 archive and reconciles proofs and 1Sat provenance."
                                }
                            }
                            list_row::Trailing {
                                span {
                                    class: "status-pill status-pill-compact",
                                    "data-tone": if cur_heal_state == "done" { "ok" } else if cur_heal_state == "error" { "error" } else { "muted" },
                                    "data-aeon-state": "{cur_heal_state}",
                                    if cur_heal_state == "done" {
                                        "OK"
                                    } else if cur_heal_state == "error" {
                                        "Failed"
                                    } else {
                                        "Ready"
                                    }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary settings-action-btn",
                                    disabled: cur_heal_state == "running",
                                    "data-aeon-part": "heal-action",
                                    "data-aeon-state": "{cur_heal_state}",
                                    onclick: move |_| {
                                        heal_state.set("running");
                                        match svc_heal.heal_wallet_utxos() {
                                            Ok(summary) => {
                                                heal_summary.set(Some(summary.clone()));
                                                heal_state.set("done");
                                                snapshot.set(svc_heal.read_snapshot());
                                                toast.set(Some(ToastNotice {
                                                    title: "Wallet UTXOs healed".into(),
                                                    body: Some(summary),
                                                    tone: "success",
                                                }));
                                            }
                                            Err(e) => {
                                                heal_summary.set(Some(e.clone()));
                                                heal_state.set("error");
                                                toast.set(Some(ToastNotice {
                                                    title: "Heal failed".into(),
                                                    body: Some(e),
                                                    tone: "error",
                                                }));
                                            }
                                        }
                                    },
                                    button::Label {
                                        if cur_heal_state == "running" { "Healing…" } else { "Heal" }
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

/// 1:1 port of `src/components/SettingsFeatureAbout.tsx`.
#[component]
pub fn SettingsFeatureAbout(tags: &'static [&'static str], copy: &'static str) -> Element {
    rsx! {
        footer { class: "settings-feature-about", "data-aeon-scope": "feature-about",
            div { class: "settings-feature-about-tags",
                for tag in tags.iter().copied() {
                    span { key: "{tag}", class: "spec-tag", "{tag}" }
                }
            }
            p { class: "settings-feature-about-copy", "{copy}" }
        }
    }
}

/// 1:1 port of `src/components/WalletBackupPanel.tsx`.
#[component]
fn WalletBackupPanel(
    profile: SessionSummary,
    mut nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let has_phrase = profile.has_mnemonic;
    let mut kind = use_signal(|| "split");
    let mut revealed = use_signal(|| false);
    let mut copied = use_signal(|| false);
    let mut brc140_set = use_signal(|| Option::<Brc140IssuedSet>::None);
    let mut brc140_err = use_signal(|| Option::<String>::None);
    let mut saved_slices = use_signal(BTreeSet::<usize>::new);

    let cur_kind = *kind.read();
    let is_revealed = *revealed.read();
    let can_confirm = *copied.read();
    let phrase_val = if is_revealed && cur_kind == "phrase" {
        services.current_mnemonic()
    } else {
        None
    };
    let key_val = if is_revealed && cur_kind == "key" {
        services.current_root_key_hex()
    } else {
        None
    };
    let svc_reveal = Arc::clone(&services);
    let svc_confirm_phrase = Arc::clone(&services);
    let svc_confirm_key = Arc::clone(&services);
    let svc_confirm_split = Arc::clone(&services);
    let svc_rotate_split = Arc::clone(&services);

    rsx! {
        div {
            class: "nav-section-body settings-scroll",
            "data-aeon-scope": "wallet-backup",
            "data-aeon-state": if is_revealed { "revealed" } else { "idle" },
            p { class: "settings-hint",
                "Save two of three slices in separate accounts or apps you control; HandCash receives none."
            }
            div { class: "backup-format-tabs", role: "tablist", aria_label: "Recovery formats",
                button {
                    r#type: "button",
                    role: "tab",
                    aria_selected: if cur_kind == "split" { "true" } else { "false" },
                    class: if cur_kind == "split" { "btn btn-primary" } else { "btn btn-ghost" },
                    onclick: move |_| {
                        revealed.set(false);
                        copied.set(false);
                        kind.set("split");
                    },
                    "Key slices"
                }
                button {
                    r#type: "button",
                    role: "tab",
                    aria_selected: if cur_kind == "phrase" { "true" } else { "false" },
                    class: if cur_kind == "phrase" { "btn btn-primary" } else { "btn btn-ghost" },
                    disabled: !has_phrase,
                    onclick: move |_| {
                        revealed.set(false);
                        copied.set(false);
                        kind.set("phrase");
                    },
                    "Recovery phrase"
                }
                button {
                    r#type: "button",
                    role: "tab",
                    aria_selected: if cur_kind == "key" { "true" } else { "false" },
                    class: if cur_kind == "key" { "btn btn-primary" } else { "btn btn-ghost" },
                    onclick: move |_| {
                        revealed.set(false);
                        copied.set(false);
                        kind.set("key");
                    },
                    "Emergency key"
                }
            }

            if !is_revealed {
                div { class: "confirm-password-gate", "data-aeon-scope": "reveal-recovery",
                    div { class: "confirm-password-copy",
                        h3 { class: "confirm-password-title", "Show recovery material" }
                        p { class: "confirm-password-lede",
                            "The wallet is unlocked; no password is needed to show backups."
                        }
                    }
                    div {
                        class: "actions",
                        "data-aeon-part": "reveal-actions",
                        "data-aeon-state": "idle",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| {
                                copied.set(false);
                                if *kind.read() == "split" && brc140_set.read().is_none() {
                                    match svc_reveal.load_or_issue_brc140_set() {
                                        Ok(set) => {
                                            brc140_err.set(None);
                                            brc140_set.set(Some(set));
                                        }
                                        Err(e) => brc140_err.set(Some(e)),
                                    }
                                }
                                revealed.set(true);
                            },
                            button::Label {
                                if cur_kind == "split" {
                                    "Show slices"
                                } else if cur_kind == "phrase" {
                                    "Show phrase"
                                } else {
                                    "Show key"
                                }
                            }
                        }
                    }
                }
            }

            if is_revealed && cur_kind == "split" {
                if let Some(set) = brc140_set.read().clone() {
                    {
                        let threshold = set.threshold;
                        let saved_count = saved_slices.read().len();
                        let split_ready = saved_count >= threshold;
                        rsx! {
                            KeySliceList {
                                set,
                                saved_indices: saved_slices,
                                toast,
                                on_rotate: move |_| {
                                    match svc_rotate_split.rotate_brc140_set() {
                                        Ok(new_set) => {
                                            saved_slices.set(BTreeSet::new());
                                            brc140_set.set(Some(new_set));
                                            toast.set(Some(ToastNotice {
                                                title: "New slice set issued".into(),
                                                body: Some("Previous slices will no longer combine with this set.".into()),
                                                tone: "info",
                                            }));
                                        }
                                        Err(e) => toast.set(Some(ToastNotice {
                                            title: "Rotate failed".into(),
                                            body: Some(e),
                                            tone: "error",
                                        })),
                                    }
                                },
                            }
                            div { class: "actions",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !split_ready,
                                    onclick: move |_| {
                                        svc_confirm_split.mark_keys_backup_confirmed("split");
                                        revealed.set(false);
                                        toast.set(Some(ToastNotice {
                                            title: "Keys backup saved".into(),
                                            body: Some("History backup is next if you have not done it yet.".into()),
                                            tone: "success",
                                        }));
                                        nav_child.set(Some(NavChild::Setting(SettingSubpage::HistoryBackup)));
                                    },
                                    button::Label { "Done — slices saved" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        revealed.set(false);
                                    },
                                    button::Label { "Hide" }
                                }
                            }
                        }
                    }
                } else if let Some(ref err) = *brc140_err.read() {
                    p { class: "error", role: "alert", "{err}" }
                }
            }

            if let Some(ref phrase) = phrase_val {
                {
                    let words: Vec<String> = phrase
                        .split_whitespace()
                        .map(ToString::to_string)
                        .collect();
                    let p_copy = phrase.clone();
                    rsx! {
                        div { class: "split-backup-shares",
                            p { class: "settings-hint", "Keep these words private." }
                            ol { class: "recovery-phrase-grid",
                                for (i, word) in words.iter().enumerate() {
                                    li { key: "{i}-{word}",
                                        span { class: "recovery-phrase-index", "{i + 1}." }
                                        " {word}"
                                    }
                                }
                            }
                            div { class: "actions",
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        if copy_to_clipboard(&p_copy).is_ok() {
                                            copied.set(true);
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some("Recovery phrase copied.".into()),
                                                tone: "success",
                                            }));
                                        }
                                    },
                                    button::Label { "Copy" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !can_confirm,
                                    onclick: move |_| {
                                        svc_confirm_phrase.mark_keys_backup_confirmed("phrase");
                                        revealed.set(false);
                                        toast.set(Some(ToastNotice {
                                            title: "Keys backup saved".into(),
                                            body: Some("History backup is next if you have not done it yet.".into()),
                                            tone: "success",
                                        }));
                                        nav_child.set(Some(NavChild::Setting(SettingSubpage::HistoryBackup)));
                                    },
                                    button::Label { "I’ve saved my phrase" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        revealed.set(false);
                                        copied.set(false);
                                    },
                                    button::Label { "Hide" }
                                }
                            }
                        }
                    }
                }
            }

            if let Some(ref rk) = key_val {
                {
                    let rk_copy = rk.clone();
                    rsx! {
                        div { class: "split-backup-shares",
                            p { class: "settings-hint", "Keep this key private." }
                            p { class: "mono backup-root-key", "{rk}" }
                            div { class: "actions",
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        if copy_to_clipboard(&rk_copy).is_ok() {
                                            copied.set(true);
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some("Emergency key copied.".into()),
                                                tone: "success",
                                            }));
                                        }
                                    },
                                    button::Label { "Copy" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !can_confirm,
                                    onclick: move |_| {
                                        svc_confirm_key.mark_keys_backup_confirmed("key");
                                        revealed.set(false);
                                        toast.set(Some(ToastNotice {
                                            title: "Keys backup saved".into(),
                                            body: Some("History backup is next if you have not done it yet.".into()),
                                            tone: "success",
                                        }));
                                        nav_child.set(Some(NavChild::Setting(SettingSubpage::HistoryBackup)));
                                    },
                                    button::Label { "I’ve saved my key" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        revealed.set(false);
                                        copied.set(false);
                                    },
                                    button::Label { "Hide" }
                                }
                            }
                        }
                    }
                }
            }

            SettingsFeatureAbout {
                tags: &["BRC-140", "BRC-157", "BRC-75"],
                copy: "Any two slices from one set restore the wallet. Only Replace slice set creates a new set.",
            }
        }
    }
}

/// 1:1 port of `src/components/UnlockSettingsPanel.tsx` + `src/components/ConfirmPasswordGate.tsx`.
#[component]
fn UnlockSettingsPanel(mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut mode = use_signal(|| "overview");
    let mut gate_input = use_signal(String::new);
    let mut gate_verified_pw = use_signal(|| Option::<String>::None);
    let mut new_pw = use_signal(String::new);
    let mut confirm_pw = use_signal(String::new);
    let mut error_msg = use_signal(|| Option::<String>::None);
    let mut rev = use_signal(|| 0u64);
    let _ = *rev.read();

    let cur_mode = *mode.read();
    let no_lock = services.is_no_device_lock();
    let has_mem_pw = services.has_memorable_password();

    if cur_mode == "change-password" && gate_verified_pw.read().is_none() {
        let svc_gate = Arc::clone(&services);
        let pw_len = gate_input.read().len();
        return rsx! {
            div {
                class: "settings-detail settings-detail-compact settings-scroll",
                "data-aeon-scope": "settings-unlock",
                div {
                    class: "confirm-password-gate",
                    "data-aeon-scope": "confirm-password",
                    "data-aeon-state": "idle",
                    "data-factor": "password",
                    div { class: "confirm-password-copy",
                        h3 { class: "confirm-password-title", "Change password" }
                        p { class: "confirm-password-lede", "Confirm your current password to change it." }
                    }
                    form {
                        class: "settings-form settings-form-compact",
                        onsubmit: move |e| {
                            e.prevent_default();
                            error_msg.set(None);
                            let entered = gate_input.read().clone();
                            match svc_gate.verify_password(&entered) {
                                Ok(()) => {
                                    gate_input.set(String::new());
                                    gate_verified_pw.set(Some(entered));
                                }
                                Err(err) => error_msg.set(Some(err)),
                            }
                        },
                        PasswordField {
                            id: "unlock-change-password",
                            label: "HandCash password",
                            placeholder: "Your unlock password",
                            value: gate_input,
                        }
                        if let Some(ref err) = *error_msg.read() {
                            p { class: "error", role: "alert", "{err}" }
                        }
                        div { class: "actions",
                            button::Root {
                                variant: button::ButtonVariant::Solid,
                                button_type: "submit",
                                class: "btn btn-primary",
                                disabled: pw_len < 8,
                                button::Label { "Continue" }
                            }
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| {
                                    gate_input.set(String::new());
                                    error_msg.set(None);
                                    mode.set("overview");
                                },
                                button::Label { "Cancel" }
                            }
                        }
                    }
                }
            }
        };
    }

    if cur_mode == "change-password" {
        let svc_change = Arc::clone(&services);
        let new_empty = new_pw.read().is_empty();
        return rsx! {
            div {
                class: "settings-detail settings-detail-compact settings-scroll",
                "data-aeon-scope": "settings-unlock",
                "data-aeon-state": "change-password",
                div { class: "confirm-password-copy",
                    h3 { class: "confirm-password-title", "Choose a new password" }
                    p { class: "confirm-password-lede",
                        "This HandCash password is separate from your phone or computer unlock."
                    }
                }
                form {
                    class: "settings-form settings-form-compact",
                    "data-aeon-part": "factor-form",
                    "data-aeon-state": "idle",
                    onsubmit: move |e| {
                        e.prevent_default();
                        error_msg.set(None);
                        let np = new_pw.read().clone();
                        let cp = confirm_pw.read().clone();
                        if np != cp {
                            error_msg.set(Some("Passwords do not match".into()));
                            return;
                        }
                        if let Some(err) = handcash_primitives::vault::password_policy_error(&np) {
                            error_msg.set(Some(err));
                            return;
                        }
                        let cur = gate_verified_pw.read().clone().unwrap_or_default();
                        match svc_change.change_password(&cur, &np) {
                            Ok(()) => {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                gate_verified_pw.set(None);
                                mode.set("overview");
                                let next = *rev.read() + 1;
                                rev.set(next);
                                toast.set(Some(ToastNotice {
                                    title: "Password updated".into(),
                                    body: None,
                                    tone: "success",
                                }));
                            }
                            Err(err) => error_msg.set(Some(err)),
                        }
                    },
                    PasswordField {
                        id: "settings-new-password",
                        label: "New password",
                        placeholder: "10+ chars, letter and number",
                        value: new_pw,
                    }
                    PasswordField {
                        id: "settings-confirm-password",
                        label: "Confirm password",
                        placeholder: "Type it again",
                        value: confirm_pw,
                    }
                    if let Some(ref err) = *error_msg.read() {
                        p { class: "error", role: "alert", "{err}" }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            button_type: "submit",
                            class: "btn btn-primary",
                            disabled: new_empty,
                            button::Label { "Update password" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                gate_verified_pw.set(None);
                                error_msg.set(None);
                                mode.set("overview");
                            },
                            button::Label { "Back" }
                        }
                    }
                }
            }
        };
    }

    if cur_mode == "set-password" {
        let svc_set = Arc::clone(&services);
        let new_empty = new_pw.read().is_empty();
        return rsx! {
            div {
                class: "settings-detail settings-detail-compact settings-scroll",
                "data-aeon-scope": "settings-unlock",
                "data-aeon-state": "set-password",
                div { class: "confirm-password-copy",
                    h3 { class: "confirm-password-title", "Add a HandCash password" }
                    p { class: "confirm-password-lede",
                        "Backup unlock without biometrics; confirm with this device first."
                    }
                }
                form {
                    class: "settings-form settings-form-compact",
                    "data-aeon-part": "factor-form",
                    "data-aeon-state": "idle",
                    onsubmit: move |e| {
                        e.prevent_default();
                        error_msg.set(None);
                        let np = new_pw.read().clone();
                        let cp = confirm_pw.read().clone();
                        if np != cp {
                            error_msg.set(Some("Passwords do not match".into()));
                            return;
                        }
                        match svc_set.set_password_from_open(&np) {
                            Ok(()) => {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                mode.set("overview");
                                let next = *rev.read() + 1;
                                rev.set(next);
                                toast.set(Some(ToastNotice {
                                    title: "HandCash password added".into(),
                                    body: None,
                                    tone: "success",
                                }));
                            }
                            Err(err) => error_msg.set(Some(err)),
                        }
                    },
                    PasswordField {
                        id: "settings-set-password",
                        label: "HandCash password",
                        placeholder: "10+ chars, letter and number",
                        value: new_pw,
                    }
                    PasswordField {
                        id: "settings-set-password-confirm",
                        label: "Confirm password",
                        placeholder: "Type it again",
                        value: confirm_pw,
                    }
                    if let Some(ref err) = *error_msg.read() {
                        p { class: "error", role: "alert", "{err}" }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            button_type: "submit",
                            class: "btn btn-primary",
                            disabled: new_empty,
                            button::Label { "Save password" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                new_pw.set(String::new());
                                confirm_pw.set(String::new());
                                error_msg.set(None);
                                mode.set("overview");
                            },
                            button::Label { "Back" }
                        }
                    }
                }
            }
        };
    }

    rsx! {
        div {
            class: "settings-detail settings-detail-compact settings-scroll",
            "data-aeon-scope": "settings-unlock",
            "data-aeon-state": "overview",
            div { class: "confirm-password-copy",
                h3 { class: "confirm-password-title", "Unlock" }
                p { class: "confirm-password-lede",
                    if no_lock {
                        "This device opens the wallet without a prompt. Add a password any time."
                    } else {
                        "Use device unlock, a HandCash password, or both. Keep at least one."
                    }
                }
            }
            ul { class: "settings-list",
                li {
                    list_row::Root { "data-aeon-layout": "control",
                        list_row::Leading {
                            span { class: "settings-row-icon", "data-tone": "default",
                                FingerprintIcon { size: 20 }
                            }
                        }
                        list_row::Label { "Device unlock" }
                        list_row::Description { "Not available on this device" }
                    }
                }
                li {
                    list_row::Root { "data-aeon-layout": "control",
                        list_row::Leading {
                            span { class: "settings-row-icon", "data-tone": "default",
                                LockIcon { size: 20 }
                            }
                        }
                        list_row::Label { "HandCash password" }
                        list_row::Description {
                            if no_lock {
                                "Off · no prompt on this device"
                            } else if has_mem_pw {
                                "On · separate from device lock"
                            } else {
                                "Off"
                            }
                        }
                        list_row::Trailing {
                            if has_mem_pw {
                                div { class: "actions",
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        onclick: move |_| {
                                            error_msg.set(None);
                                            gate_input.set(String::new());
                                            gate_verified_pw.set(None);
                                            mode.set("change-password");
                                        },
                                        button::Label { "Change" }
                                    }
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        disabled: true,
                                        button::Label { "Remove" }
                                    }
                                }
                            } else {
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !no_lock,
                                    onclick: move |_| {
                                        error_msg.set(None);
                                        new_pw.set(String::new());
                                        confirm_pw.set(String::new());
                                        mode.set("set-password");
                                    },
                                    button::Label { "Add" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/AboutHandCashPanel.tsx`.
#[component]
fn AboutHandCashPanel(mut nav_child: Signal<Option<NavChild>>) -> Element {
    rsx! {
        div {
            class: "nav-section-body settings-scroll about-handcash",
            "data-aeon-scope": "about-handcash",
            p { class: "settings-hint about-handcash-lead",
                "Your Bitcoin SV keys stay here; you approve app access through the local bridge."
            }
            div { class: "about-handcash-body",
                p { "HandCash cannot recover your funds if you lose this device without a backup." }
            }
            section { class: "settings-group", "data-aeon-part": "app",
                h3 { class: "settings-group-title", "This app" }
                ul { class: "settings-list",
                    li {
                        list_row::Root { "data-aeon-layout": "control",
                            list_row::Leading {
                                span { class: "settings-row-icon", "data-tone": "default",
                                    InfoIcon { size: 20 }
                                }
                            }
                            list_row::Label { "Version" }
                            list_row::Trailing {
                                span { class: "settings-row-desc mono", "{APP_VERSION}" }
                            }
                        }
                    }
                    SettingsNavRow {
                        label: "Statecharts",
                        description: "The state machines behind each flow",
                        icon: setting_icon(SettingSubpage::Statecharts),
                        onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::Statecharts))),
                    }
                }
            }
        }
    }
}

/// Settings child panels (Recovery backup, Import BRC-38/BRC-39, Unlock/Password, Wallet health, About, History backup, Wipe wallet, Device handoff, HandCash Recovery, Sign-in email, Chart apps).
#[component]
pub fn SettingSubpagePanel(
    subpage: SettingSubpage,
    profile: SessionSummary,
    snap: WalletSnapshot,
    mut snapshot: Signal<WalletSnapshot>,
    app_machine: Signal<AppSessionMachine>,
    nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();

    match subpage {
        SettingSubpage::Backup => rsx! {
            WalletBackupPanel {
                profile,
                nav_child,
                toast,
            }
        },
        SettingSubpage::Import => {
            let svc_import = Arc::clone(&services);
            rsx! {
                div { class: "nav-child-panel", style: "display: flex; flex-direction: column; gap: 14px;",
                    h3 { "Import BRC-38 / BRC-39 backup" }
                    p { class: "settings-row-desc",
                        "Merge an encrypted .brc39 backup or a BRC-38 JSON backup into this account's SQLite WAL store. Existing outputs and proven items are never removed."
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| {
                                if let Some(path) = rfd::FileDialog::new()
                                    .add_filter("History Backup (.brc39 / .json)", &["brc39", "json"])
                                    .pick_file()
                                {
                                    match std::fs::read(&path)
                                        .map_err(|e| e.to_string())
                                        .and_then(|bytes| svc_import.restore_brc39_backup_bytes(&bytes, None))
                                    {
                                        Ok(msg) => {
                                            snapshot.set(svc_import.read_snapshot());
                                            toast.set(Some(ToastNotice {
                                                title: "Import complete".into(),
                                                body: Some(msg),
                                                tone: "success",
                                            }));
                                        }
                                        Err(e) => toast.set(Some(ToastNotice {
                                            title: "Import failed".into(),
                                            body: Some(e),
                                            tone: "error",
                                        })),
                                    }
                                }
                            },
                            DownloadIcon { size: 16 }
                            button::Label { "Choose backup file (.brc39 / .json)" }
                        }
                    }
                }
            }
        }
        SettingSubpage::Unlock => rsx! {
            UnlockSettingsPanel { toast }
        },
        SettingSubpage::WalletHealth => rsx! {
            WalletHealthPanel { snapshot, toast }
        },
        SettingSubpage::About => rsx! {
            AboutHandCashPanel { nav_child }
        },
        SettingSubpage::Labs => rsx! {
            LabsPanel {}
        },
        SettingSubpage::Logs => rsx! {
            LogViewerPanel { toast }
        },
        SettingSubpage::Statecharts => rsx! {
            StatechartsPanel { profile, snap }
        },
        SettingSubpage::RecoverTx => rsx! {
            RecoverTxPanel { snapshot, toast }
        },
        SettingSubpage::HandCashRecovery => rsx! {
            HandCashRecoveryPanel {
                profile,
                nav_child,
                toast,
            }
        },
        SettingSubpage::HistoryBackup => rsx! {
            HistoryBackupPanel {
                profile,
                snapshot,
                nav_child,
                toast,
            }
        },
        SettingSubpage::DeviceHandoff => rsx! {
            DeviceHandoffPanel { nav_child, toast }
        },
        SettingSubpage::SigninEmail => rsx! {
            SigninEmailPanel { toast }
        },
        SettingSubpage::WipeWallet => rsx! {
            WipeWalletPanel {
                snap,
                snapshot,
                app_machine,
                nav_child,
                toast,
            }
        },
        SettingSubpage::ChartApps => rsx! {
            ChartAppsPanel { toast }
        },
    }
}

/// 1:1 port of `src/components/RecoverFromTxPanel.tsx`: scans a txid for 1-sat outputs
/// paying this wallet and claims them into the wallet's `1sat` basket + BRC-150 verifier.
#[component]
fn RecoverTxPanel(
    mut snapshot: Signal<WalletSnapshot>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let svc_scan = Arc::clone(&services);
    let mut txid = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut claiming = use_signal(|| false);
    let mut result = use_signal(|| None::<Result<RecoverScan, String>>);
    let state = if *claiming.read() {
        "claiming"
    } else if *busy.read() {
        "scanning"
    } else {
        "idle"
    };
    let current = result.read().clone();
    rsx! {
        div {
            class: "nav-child-panel",
            "data-aeon-scope": "settings-recover-tx",
            "data-aeon-state": state,
            style: "display: flex; flex-direction: column; gap: 12px;",
            h3 { "Recover from transaction" }
            p { class: "settings-row-desc",
                "Paste the sender's transaction id to find the items in it that were sent to this wallet. Scanning only reads the chain; claiming adds them to your 1Sat items."
            }
            input {
                class: "mono",
                placeholder: "64-character transaction id",
                value: "{txid}",
                oninput: move |e| {
                    result.set(None);
                    txid.set(e.value());
                },
            }
            div { class: "actions", style: "display: flex; gap: 8px;",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: *busy.read() || *claiming.read() || txid.read().trim().is_empty(),
                    onclick: move |_| {
                        let svc = Arc::clone(&svc_scan);
                        let raw = txid.read().clone();
                        busy.set(true);
                        result.set(None);
                        spawn(async move {
                            let handle = svc.engine.runtime_handle().clone();
                            let svc_bg = Arc::clone(&svc);
                            let out = handle
                                .spawn(async move { svc_bg.scan_recover_tx(&raw).await })
                                .await
                                .unwrap_or_else(|e| Err(e.to_string()));
                            result.set(Some(out));
                            busy.set(false);
                        });
                    },
                    button::Label { if *busy.read() { "Scanning…" } else { "Scan transaction" } }
                }
            }
            match current {
                None => rsx! {},
                Some(Err(e)) => rsx! {
                    p { class: "settings-row-desc", role: "alert", "data-tone": "error", "{e}" }
                },
                Some(Ok(scan)) if scan.outputs.is_empty() => rsx! {
                    p { class: "settings-row-desc",
                        "No 1-sat outputs in this transaction pay this wallet's address."
                    }
                },
                Some(Ok(scan)) => {
                    let count = scan.outputs.len();
                    let scan_txid = scan.txid.clone();
                    let svc_claim = Arc::clone(&services);
                    rsx! {
                        p { class: "settings-row-desc",
                            "{count} output(s) in this transaction pay this wallet."
                        }
                        ul { class: "identity-list",
                            for out in scan.outputs {
                                li { key: "{out.outpoint}", class: "identity-field",
                                    span { class: "identity-field-label",
                                        if out.inscribed { "Inscribed output" } else { "1-sat output" }
                                    }
                                    strong { class: "mono", "{truncate_mid(&out.outpoint, 10)}" }
                                }
                            }
                        }
                        div { class: "actions",
                            button::Root {
                                variant: button::ButtonVariant::Solid,
                                class: "btn btn-primary",
                                disabled: *claiming.read(),
                                onclick: move |_| {
                                    let svc = Arc::clone(&svc_claim);
                                    let raw_tx = scan_txid.clone();
                                    claiming.set(true);
                                    spawn(async move {
                                        let handle = svc.engine.runtime_handle().clone();
                                        let svc_bg = Arc::clone(&svc);
                                        let out = handle
                                            .spawn(async move { svc_bg.claim_recover_tx(&raw_tx).await })
                                            .await
                                            .unwrap_or_else(|e| Err(e.to_string()));
                                        claiming.set(false);
                                        match out {
                                            Ok(msg) => {
                                                snapshot.set(svc.read_snapshot());
                                                toast.set(Some(ToastNotice {
                                                    title: "Recovered".into(),
                                                    body: Some(msg),
                                                    tone: "success",
                                                }));
                                            }
                                            Err(e) => toast.set(Some(ToastNotice {
                                                title: "Claim failed".into(),
                                                body: Some(e),
                                                tone: "error",
                                            })),
                                        }
                                    });
                                },
                                button::Label {
                                    if *claiming.read() { "Claiming…" } else { "Claim into wallet" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/HistoryBackupPanel.tsx`.
#[component]
fn HistoryBackupPanel(
    profile: SessionSummary,
    mut snapshot: Signal<WalletSnapshot>,
    mut nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut prefs = use_signal(|| services.load_history_backup_prefs());
    let mut url_input = use_signal(|| services.load_history_backup_prefs().base_url);
    let mut rev = use_signal(|| 0u64);
    let _ = *rev.read();

    let cur_prefs = prefs.read().clone();
    let custom_host = cur_prefs.is_custom_host();
    let confirmed = services.is_history_backup_confirmed();
    let local_snapshots = services.list_local_brc39_archive();
    let id_prefix: String = profile.identity_key.chars().take(10).collect();
    let default_filename = format!("handcash-history-{id_prefix}.brc39");

    let svc_save_url = Arc::clone(&services);
    let svc_clear_url = Arc::clone(&services);
    let svc_download = Arc::clone(&services);
    let svc_import = Arc::clone(&services);
    let svc_confirm = Arc::clone(&services);

    rsx! {
        div {
            class: "nav-section-body settings-scroll",
            "data-aeon-scope": "history-backup",
            "data-aeon-state": if confirmed { "confirmed" } else { "idle" },
            p { class: "settings-hint",
                "History backup saves your payment notes, contacts, and 1Sat item provenance in an encrypted BRC-39 bundle derived from your root key. Refreshing from the chain alone will not restore P2P notes."
            }

            section { class: "settings-group", "data-aeon-part": "history-actions",
                h3 { class: "settings-group-title", "Encrypted backup (.brc39)" }
                div { class: "actions", style: "display: flex; gap: 8px; flex-wrap: wrap;",
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        onclick: move |_| {
                            match svc_download.create_brc39_backup_bytes() {
                                Ok(bytes) => {
                                    if let Some(path) = rfd::FileDialog::new()
                                        .set_file_name(&default_filename)
                                        .add_filter("BRC-39 History Backup", &["brc39"])
                                        .save_file()
                                    {
                                        match std::fs::write(&path, &bytes) {
                                            Ok(()) => {
                                                svc_download.mark_history_backup_confirmed();
                                                let next = *rev.read() + 1;
                                                rev.set(next);
                                                toast.set(Some(ToastNotice {
                                                    title: "History backup saved".into(),
                                                    body: Some(path.display().to_string()),
                                                    tone: "success",
                                                }));
                                            }
                                            Err(e) => toast.set(Some(ToastNotice {
                                                title: "Save failed".into(),
                                                body: Some(e.to_string()),
                                                tone: "error",
                                            })),
                                        }
                                    } else {
                                        let next = *rev.read() + 1;
                                        rev.set(next);
                                    }
                                }
                                Err(e) => toast.set(Some(ToastNotice {
                                    title: "Export failed".into(),
                                    body: Some(e),
                                    tone: "error",
                                })),
                            }
                        },
                        DownloadIcon { size: 16 }
                        button::Label { "Download a backup" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("History Backup (.brc39 / .json)", &["brc39", "json"])
                                .pick_file()
                            {
                                match std::fs::read(&path)
                                    .map_err(|e| e.to_string())
                                    .and_then(|bytes| svc_import.restore_brc39_backup_bytes(&bytes, None))
                                {
                                    Ok(msg) => {
                                        snapshot.set(svc_import.read_snapshot());
                                        let next = *rev.read() + 1;
                                        rev.set(next);
                                        toast.set(Some(ToastNotice {
                                            title: "History merged".into(),
                                            body: Some(msg),
                                            tone: "success",
                                        }));
                                    }
                                    Err(e) => toast.set(Some(ToastNotice {
                                        title: "Restore failed".into(),
                                        body: Some(e),
                                        tone: "error",
                                    })),
                                }
                            }
                        },
                        button::Label { "Import a backup" }
                    }
                    if !confirmed {
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                svc_confirm.mark_history_backup_confirmed();
                                let next = *rev.read() + 1;
                                rev.set(next);
                                toast.set(Some(ToastNotice {
                                    title: "History backup confirmed".into(),
                                    body: None,
                                    tone: "success",
                                }));
                                nav_child.set(None);
                            },
                            button::Label { "History backup saved" }
                        }
                    }
                }
            }

            section { class: "settings-group", "data-aeon-part": "history-host",
                h3 { class: "settings-group-title", "Custom history host" }
                p { class: "settings-row-desc",
                    "Active endpoint: {cur_prefs.effective_base_url()}"
                }
                div { style: "display: flex; gap: 8px; margin-top: 8px; align-items: center;",
                    input {
                        class: "mono",
                        style: "flex: 1;",
                        placeholder: "https://your-brc39-host.example/history",
                        value: "{url_input}",
                        oninput: move |e| url_input.set(e.value()),
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| {
                            let mut next_p = prefs.read().clone();
                            next_p.base_url = url_input.read().trim().to_string();
                            svc_save_url.save_history_backup_prefs(&next_p);
                            prefs.set(next_p);
                            toast.set(Some(ToastNotice {
                                title: "History host updated".into(),
                                body: None,
                                tone: "success",
                            }));
                        },
                        button::Label { "Save URL" }
                    }
                    if custom_host {
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                let mut next_p = prefs.read().clone();
                                next_p.base_url = String::new();
                                url_input.set(String::new());
                                svc_clear_url.save_history_backup_prefs(&next_p);
                                prefs.set(next_p);
                            },
                            button::Label { "Use default" }
                        }
                    }
                }
            }

            section { class: "settings-group", "data-aeon-part": "local-archive",
                h3 { class: "settings-group-title", "On-device snapshots ({local_snapshots.len()})" }
                if local_snapshots.is_empty() {
                    p { class: "settings-row-desc",
                        "No on-device snapshots yet. Downloading a backup or healing UTXOs writes a write-once snapshot to your local archive."
                    }
                } else {
                    ul { class: "settings-list",
                        for snap_entry in local_snapshots.iter() {
                            {
                                let sid = snap_entry.id.clone();
                                let sid_restore = snap_entry.id.clone();
                                let bytes_len = snap_entry.bytes;
                                let svc_rest = Arc::clone(&services);
                                rsx! {
                                    li { key: "{sid}",
                                        list_row::Root { "data-aeon-layout": "control",
                                            list_row::Label { "{sid}" }
                                            list_row::Description { "{bytes_len} bytes · write-once archive" }
                                            list_row::Trailing {
                                                button::Root {
                                                    variant: button::ButtonVariant::Ghost,
                                                    class: "btn btn-ghost settings-action-btn",
                                                    onclick: move |_| {
                                                        match svc_rest.restore_local_brc39_snapshot(&sid_restore, None) {
                                                            Ok(msg) => {
                                                                snapshot.set(svc_rest.read_snapshot());
                                                                toast.set(Some(ToastNotice {
                                                                    title: "Snapshot merged".into(),
                                                                    body: Some(msg),
                                                                    tone: "success",
                                                                }));
                                                            }
                                                            Err(e) => toast.set(Some(ToastNotice {
                                                                title: "Restore failed".into(),
                                                                body: Some(e),
                                                                tone: "error",
                                                            })),
                                                        }
                                                    },
                                                    button::Label { "Restore" }
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

            SettingsFeatureAbout {
                tags: &["BRC-39", "BRC-38", "BRC-78"],
                copy: "History backups are encrypted with a secret derived from your root key and merged without dropping existing UTXOs or proven 1Sat items.",
            }
        }
    }
}

/// 1:1 port of `src/components/WipeWalletPanel.tsx`.
#[component]
fn WipeWalletPanel(
    snap: WalletSnapshot,
    mut snapshot: Signal<WalletSnapshot>,
    mut app_machine: Signal<AppSessionMachine>,
    mut nav_child: Signal<Option<NavChild>>,
    toast: Signal<Option<ToastNotice>>,
) -> Element {
    let _ = toast;
    let services = use_context::<Arc<AppServices>>();
    let no_lock = services.is_no_device_lock();
    let mut gate_verified = use_signal(|| no_lock);
    let gate_pw = use_signal(String::new);
    let mut confirm_text = use_signal(String::new);
    let mut gate_warning = use_signal(|| Option::<String>::None);
    let mut error_msg = use_signal(|| Option::<String>::None);

    let is_verified = *gate_verified.read();
    let typed_delete = confirm_text.read().trim() == "DELETE";
    let svc_verify = Arc::clone(&services);
    let svc_wipe = Arc::clone(&services);
    let svc_sync_wipe = Arc::clone(&services);
    let svc_force_wipe = Arc::clone(&services);

    if !is_verified {
        return rsx! {
            div {
                class: "settings-detail settings-detail-compact settings-scroll",
                "data-aeon-scope": "wipe-wallet",
                "data-aeon-state": "password-gate",
                form {
                    class: "confirm-password-gate",
                    onsubmit: move |e| {
                        e.prevent_default();
                        error_msg.set(None);
                        let pw = gate_pw.read().clone();
                        match svc_verify.verify_password(&pw) {
                            Ok(()) => {
                                gate_verified.set(true);
                                gate_warning.set(svc_verify.check_wipe_history_gate().err());
                            }
                            Err(err) => error_msg.set(Some(err)),
                        }
                    },
                    div { class: "confirm-password-copy",
                        h3 { class: "confirm-password-title", "Confirm password to wipe wallet" }
                        p { class: "confirm-password-lede",
                            "Enter your HandCash password before removing this wallet from this device."
                        }
                    }
                    PasswordField {
                        id: "wipe-wallet-password",
                        label: "HandCash password",
                        placeholder: "Your password",
                        value: gate_pw,
                    }
                    if let Some(ref err) = *error_msg.read() {
                        p { class: "error", role: "alert", "{err}" }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            button_type: "submit",
                            class: "btn btn-primary",
                            disabled: gate_pw.read().trim().is_empty(),
                            button::Label { "Continue" }
                        }
                    }
                }
            }
        };
    }

    let active_gate_warn = gate_warning
        .read()
        .clone()
        .or_else(|| services.check_wipe_history_gate().err());

    rsx! {
        div {
            class: "settings-detail settings-detail-compact settings-scroll",
            "data-aeon-scope": "wipe-wallet",
            "data-aeon-state": "confirm",
            div { class: "confirm-password-copy",
                h3 { class: "confirm-password-title", "Wipe wallet from this device" }
                p { class: "confirm-password-lede",
                    "This removes your vault keys and local SQLite databases from this computer. On-device write-once BRC-39 archive snapshots are preserved. Type DELETE to confirm."
                }
            }

            if let Some(ref warn) = active_gate_warn {
                div {
                    class: "settings-hint",
                    role: "alert",
                    "data-tone": "warn",
                    p { "{warn}" }
                }
            }

            label { class: "field",
                span { "Type DELETE to confirm" }
                input {
                    class: "mono",
                    placeholder: "DELETE",
                    value: "{confirm_text}",
                    oninput: move |e| {
                        error_msg.set(None);
                        confirm_text.set(e.value());
                    },
                }
            }

            if let Some(ref err) = *error_msg.read() {
                p { class: "error", role: "alert", "{err}" }
            }

            div { class: "actions", style: "display: flex; gap: 8px; flex-wrap: wrap;",
                if active_gate_warn.is_some() {
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        disabled: !typed_delete,
                        onclick: move |_| {
                            error_msg.set(None);
                            let _ = svc_sync_wipe.create_brc39_backup_bytes();
                            svc_sync_wipe.mark_history_backup_confirmed();
                            let pw = gate_pw.read().clone();
                            let pw_opt = if no_lock { None } else { Some(pw.as_str()) };
                            match svc_sync_wipe.wipe_all_wallet_data(pw_opt) {
                                Ok(()) => {
                                    snapshot.set(svc_sync_wipe.read_snapshot());
                                    nav_child.set(None);
                                    app_machine.set(AppSessionMachine::new(false, None, 0, snap.bridge_online));
                                }
                                Err(e) => error_msg.set(Some(e)),
                            }
                        },
                        button::Label { "Snapshot and wipe" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        disabled: !typed_delete,
                        onclick: move |_| {
                            error_msg.set(None);
                            let pw = gate_pw.read().clone();
                            let pw_opt = if no_lock { None } else { Some(pw.as_str()) };
                            match svc_force_wipe.wipe_all_wallet_data(pw_opt) {
                                Ok(()) => {
                                    snapshot.set(svc_force_wipe.read_snapshot());
                                    nav_child.set(None);
                                    app_machine.set(AppSessionMachine::new(false, None, 0, snap.bridge_online));
                                }
                                Err(e) => error_msg.set(Some(e)),
                            }
                        },
                        button::Label { "Wipe anyway" }
                    }
                } else {
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        disabled: !typed_delete,
                        onclick: move |_| {
                            error_msg.set(None);
                            let pw = gate_pw.read().clone();
                            let pw_opt = if no_lock { None } else { Some(pw.as_str()) };
                            match svc_wipe.wipe_all_wallet_data(pw_opt) {
                                Ok(()) => {
                                    snapshot.set(svc_wipe.read_snapshot());
                                    nav_child.set(None);
                                    app_machine.set(AppSessionMachine::new(false, None, 0, snap.bridge_online));
                                }
                                Err(e) => error_msg.set(Some(e)),
                            }
                        },
                        button::Label { "Wipe wallet" }
                    }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| nav_child.set(None),
                    button::Label { "Cancel" }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/settings/HandCashRecoveryPanel.tsx`.
#[component]
fn HandCashRecoveryPanel(
    profile: SessionSummary,
    mut nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut rev = use_signal(|| 0u64);
    let _ = *rev.read();
    let local_label = AppServices::local_device_label();
    let peers = services.list_peer_devices();
    let saved_formats = services.saved_backup_formats();
    let phrase_saved = saved_formats.iter().any(|s| s == "phrase");
    let split_saved = saved_formats.iter().any(|s| s == "split");
    let key_saved = saved_formats.iter().any(|s| s == "key");

    rsx! {
        div {
            class: "nav-section-body settings-scroll",
            "data-aeon-scope": "handcash-recovery",
            p { class: "settings-hint",
                "Keep a second device signed in or save your recovery slices yourself. HandCash never holds your keys."
            }

            div { class: "actions", style: "margin-bottom: 12px;",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::DeviceHandoff))),
                    DevicesIcon { size: 16 }
                    button::Label { "Back this up on another device" }
                }
            }

            section { class: "settings-group", "data-aeon-part": "devices",
                h3 { class: "settings-group-title", "Signed-in devices" }
                ul { class: "settings-list",
                    li {
                        list_row::Root { "data-aeon-layout": "control",
                            list_row::Leading {
                                span { class: "settings-row-icon", "data-tone": "default",
                                    DevicesIcon { size: 20 }
                                }
                            }
                            list_row::Label { "{local_label}" }
                            list_row::Description { "This device · Account #{profile.account_index}" }
                            list_row::Trailing {
                                span {
                                    class: "status-pill status-pill-compact",
                                    "data-tone": "ok",
                                    "Active"
                                }
                            }
                        }
                    }
                    for peer in peers.iter() {
                        {
                            let pid = peer.device_id.clone();
                            let pid_rm = peer.device_id.clone();
                            let plabel = peer.label.clone();
                            let pkey = truncate_mid(&peer.identity_key, 8);
                            let svc_rm = Arc::clone(&services);
                            rsx! {
                                li { key: "{pid}",
                                    list_row::Root { "data-aeon-layout": "control",
                                        list_row::Leading {
                                            span { class: "settings-row-icon", "data-tone": "default",
                                                DevicesIcon { size: 20 }
                                            }
                                        }
                                        list_row::Label { "{plabel}" }
                                        list_row::Description { "Linked device · {pkey}" }
                                        list_row::Trailing {
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost settings-action-btn",
                                                onclick: move |_| {
                                                    svc_rm.remove_peer_device(&pid_rm);
                                                    let next = *rev.read() + 1;
                                                    rev.set(next);
                                                    toast.set(Some(ToastNotice {
                                                        title: "Device removed".into(),
                                                        body: None,
                                                        tone: "info",
                                                    }));
                                                },
                                                button::Label { "Remove" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    SettingsNavRow {
                        label: "Back up a different wallet",
                        description: "Pair or hand off over local network or QR",
                        icon: setting_icon(SettingSubpage::DeviceHandoff),
                        onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::DeviceHandoff))),
                    }
                }
            }

            section { class: "settings-group", "data-aeon-part": "self-backup",
                h3 { class: "settings-group-title", "Save a backup yourself" }
                ul { class: "settings-list",
                    if profile.has_mnemonic {
                        SettingsNavRow {
                            label: "24-word recovery phrase",
                            description: if phrase_saved { "Saved" } else { "Not saved" },
                            icon: setting_icon(SettingSubpage::Backup),
                            onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::Backup))),
                        }
                    }
                    SettingsNavRow {
                        label: "3 key slices, any 2 restore it",
                        description: if split_saved { "Saved" } else { "Not saved" },
                        icon: setting_icon(SettingSubpage::Backup),
                        onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::Backup))),
                    }
                    SettingsNavRow {
                        label: "Emergency key",
                        description: if key_saved { "Saved" } else { "Not saved" },
                        icon: setting_icon(SettingSubpage::Backup),
                        onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::Backup))),
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/DeviceHandoffPanel.tsx`.
#[component]
fn DeviceHandoffPanel(
    mut nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut show_qr = use_signal(|| false);
    let mut paste_code = use_signal(String::new);
    let mut rev = use_signal(|| 0u64);
    let _ = *rev.read();

    let pair_json = services.build_local_pair_qr_json();
    let qr_svg = pair_json.as_ref().map(|j| render_qr_svg(j));
    let peers = services.list_peer_devices();
    let svc_link = Arc::clone(&services);

    rsx! {
        div {
            class: "nav-section-body settings-scroll",
            "data-aeon-scope": "device-handoff",
            p { class: "settings-hint",
                "Pair a second device so each install holds its own account or backs up your wallet over an encrypted BRC-108 / BRC-246 link."
            }

            section { class: "settings-group", "data-aeon-part": "pair-qr",
                h3 { class: "settings-group-title", "This device's pairing code" }
                if !*show_qr.read() {
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        onclick: move |_| show_qr.set(true),
                        ScanQrIcon { size: 16 }
                        button::Label { "Show my code" }
                    }
                } else if let (Some(ref json_str), Some(ref svg_str)) = (&pair_json, &qr_svg) {
                    {
                        let copy_json = json_str.clone();
                        rsx! {
                            div { style: "display: flex; flex-direction: column; gap: 10px; align-items: flex-start;",
                                div {
                                    class: "qr-frame",
                                    style: "width: 180px; height: 180px; padding: 10px; background: #fff; border-radius: 12px;",
                                    dangerous_inner_html: "{svg_str}",
                                }
                                div { class: "actions", style: "display: flex; gap: 8px;",
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        onclick: move |_| {
                                            if copy_to_clipboard(&copy_json).is_ok() {
                                                toast.set(Some(ToastNotice {
                                                    title: "Pairing code copied".into(),
                                                    body: None,
                                                    tone: "success",
                                                }));
                                            }
                                        },
                                        CopyIcon { size: 15 }
                                        button::Label { "Copy code" }
                                    }
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        onclick: move |_| show_qr.set(false),
                                        button::Label { "Hide" }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            section { class: "settings-group", "data-aeon-part": "link-peer",
                h3 { class: "settings-group-title", "Link another device" }
                div { style: "display: flex; gap: 8px; align-items: center;",
                    input {
                        class: "mono",
                        style: "flex: 1;",
                        placeholder: "Paste device pairing JSON code",
                        value: "{paste_code}",
                        oninput: move |e| paste_code.set(e.value()),
                    }
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary",
                        disabled: paste_code.read().trim().is_empty(),
                        onclick: move |_| {
                            let raw = paste_code.read().clone();
                            match svc_link.link_peer_from_json(&raw) {
                                Ok(row) => {
                                    paste_code.set(String::new());
                                    let next = *rev.read() + 1;
                                    rev.set(next);
                                    toast.set(Some(ToastNotice {
                                        title: "Device linked".into(),
                                        body: Some(row.label),
                                        tone: "success",
                                    }));
                                }
                                Err(e) => toast.set(Some(ToastNotice {
                                    title: "Link failed".into(),
                                    body: Some(e),
                                    tone: "error",
                                })),
                            }
                        },
                        button::Label { "Link device" }
                    }
                }
            }

            if !peers.is_empty() {
                section { class: "settings-group", "data-aeon-part": "linked-devices",
                    h3 { class: "settings-group-title", "Linked devices ({peers.len()})" }
                    ul { class: "settings-list",
                        for peer in peers.iter() {
                            {
                                let pid = peer.device_id.clone();
                                let pid_rm = peer.device_id.clone();
                                let plabel = peer.label.clone();
                                let pkey = truncate_mid(&peer.identity_key, 8);
                                let svc_rm = Arc::clone(&services);
                                rsx! {
                                    li { key: "{pid}",
                                        list_row::Root { "data-aeon-layout": "control",
                                            list_row::Label { "{plabel}" }
                                            list_row::Description { "{pkey}" }
                                            list_row::Trailing {
                                                button::Root {
                                                    variant: button::ButtonVariant::Ghost,
                                                    class: "btn btn-ghost settings-action-btn",
                                                    onclick: move |_| {
                                                        svc_rm.remove_peer_device(&pid_rm);
                                                        let next = *rev.read() + 1;
                                                        rev.set(next);
                                                    },
                                                    button::Label { "Remove" }
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

            section { class: "settings-group", "data-aeon-part": "related",
                h3 { class: "settings-group-title", "Related" }
                ul { class: "settings-list",
                    SettingsNavRow {
                        label: "Key slices",
                        description: "Save 2-of-3 BRC-140 recovery slices",
                        icon: setting_icon(SettingSubpage::Backup),
                        onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::Backup))),
                    }
                    SettingsNavRow {
                        label: "History backup",
                        description: "Download or restore an encrypted .brc39 bundle",
                        icon: setting_icon(SettingSubpage::HistoryBackup),
                        onclick: move |_| nav_child.set(Some(NavChild::Setting(SettingSubpage::HistoryBackup))),
                    }
                }
            }

            SettingsFeatureAbout {
                tags: &["BRC-108", "BRC-246", "BRC-249"],
                copy: "Devices share a vault by holding separate accounts and exchanging signed release requests directly over the vault link.",
            }
        }
    }
}

/// 1:1 port of `src/components/settings/SigninEmailPanel.tsx`.
#[component]
fn SigninEmailPanel(mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut current_email = use_signal(|| services.signin_email());
    let mut editing = use_signal(|| false);
    let mut email_input = use_signal(|| services.signin_email().unwrap_or_default());

    let cur = current_email.read().clone();
    let is_editing = *editing.read() || cur.is_none();
    let svc_save = Arc::clone(&services);
    let svc_remove = Arc::clone(&services);

    rsx! {
        div {
            class: "settings-detail settings-detail-compact settings-scroll",
            "data-aeon-scope": "signin-email",
            div { class: "confirm-password-copy",
                h3 { class: "confirm-password-title", "Sign-in email" }
                p { class: "confirm-password-lede",
                    "Optional email hint used when requesting a sign-in approval from your other devices."
                }
            }

            if let Some(ref saved) = cur {
                if !is_editing {
                    ul { class: "settings-list",
                        li {
                            list_row::Root { "data-aeon-layout": "control",
                                list_row::Label { "{saved}" }
                                list_row::Description { "Stored locally on this device" }
                                list_row::Trailing {
                                    div { class: "actions",
                                        button::Root {
                                            variant: button::ButtonVariant::Ghost,
                                            class: "btn btn-ghost",
                                            onclick: move |_| {
                                                email_input.set(current_email.read().clone().unwrap_or_default());
                                                editing.set(true);
                                            },
                                            button::Label { "Change" }
                                        }
                                        button::Root {
                                            variant: button::ButtonVariant::Ghost,
                                            class: "btn btn-ghost",
                                            onclick: move |_| {
                                                svc_remove.set_signin_email(None);
                                                current_email.set(None);
                                                email_input.set(String::new());
                                                editing.set(false);
                                                toast.set(Some(ToastNotice {
                                                    title: "Sign-in email removed".into(),
                                                    body: None,
                                                    tone: "info",
                                                }));
                                            },
                                            button::Label { "Remove" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if is_editing {
                form {
                    class: "confirm-password-gate",
                    onsubmit: move |e| {
                        e.prevent_default();
                        let val = email_input.read().trim().to_string();
                        if !val.contains('@') {
                            toast.set(Some(ToastNotice {
                                title: "Invalid email".into(),
                                body: Some("Enter a valid email address.".into()),
                                tone: "error",
                            }));
                            return;
                        }
                        svc_save.set_signin_email(Some(&val));
                        current_email.set(Some(val));
                        editing.set(false);
                        toast.set(Some(ToastNotice {
                            title: "Sign-in email saved".into(),
                            body: None,
                            tone: "success",
                        }));
                    },
                    label { class: "field",
                        span { "Email address" }
                        input {
                            r#type: "email",
                            placeholder: "you@example.com",
                            value: "{email_input}",
                            oninput: move |e| email_input.set(e.value()),
                        }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            button_type: "submit",
                            class: "btn btn-primary",
                            disabled: email_input.read().trim().is_empty(),
                            button::Label { "Save email" }
                        }
                        if cur.is_some() {
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| editing.set(false),
                                button::Label { "Cancel" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/ChartAppsPanel.tsx`, `src/components/AppReview.tsx`, and `src/components/ChartAppView.tsx`.
#[component]
pub fn ChartAppsPanel(
    mut toast: Signal<Option<ToastNotice>>,
    #[props(default)] initial_app_id: Option<String>,
) -> Element {
    let apps = use_hook(load_builtin_chart_apps);
    let initial_selected = initial_app_id
        .as_ref()
        .and_then(|id| apps.iter().find(|a| &a.id == id).cloned());
    let initial_state_val = initial_selected
        .as_ref()
        .map(|a| a.initial_state.clone())
        .unwrap_or_default();
    let mut selected_app = use_signal(move || initial_selected);
    let mut active_state = use_signal(move || initial_state_val);
    let mut reviewing = use_signal(|| false);

    if let Some(app) = selected_app.read().clone() {
        if *reviewing.read() {
            let author_id = app.author_identity_key.clone();
            let author_name = app.author_name.clone();
            let verified = app.verified;
            let effects = app.effects.clone();
            let initial = app.initial_state.clone();
            return rsx! {
                div {
                    class: "nav-child-panel",
                    "data-aeon-scope": "chart-app-review",
                    style: "display: flex; flex-direction: column; gap: 12px;",
                    h3 { "{app.name}" }
                    p { class: "settings-row-desc", "{app.summary}" }
                    ul { class: "identity-list",
                        li { class: "identity-field",
                            span { class: "identity-field-label", "App ID" }
                            strong { class: "mono", "{app.id} (v{app.version})" }
                        }
                        li { class: "identity-field",
                            span { class: "identity-field-label", "Author" }
                            strong { class: "mono", "{author_name}" }
                        }
                        if !author_id.is_empty() {
                            li { class: "identity-field",
                                span { class: "identity-field-label", "Signed by" }
                                strong { class: "mono", "{truncate_mid(&author_id, 12)}" }
                            }
                        }
                        li { class: "identity-field",
                            span { class: "identity-field-label", "Signature" }
                            strong { class: "mono", if verified { "Verified (BRC-100)" } else { "Unverified" } }
                        }
                    }
                    if !effects.is_empty() {
                        div {
                            h4 { class: "settings-group-title", "Declared wallet effects" }
                            ul { class: "identity-list",
                                for (idx, (needs_approval, desc)) in effects.iter().enumerate() {
                                    li { key: "{idx}", class: "identity-field",
                                        span { class: "identity-field-label", "{desc}" }
                                        strong { class: "mono", if *needs_approval { "Requires approval" } else { "Read-only" } }
                                    }
                                }
                            }
                        }
                    }
                    div { class: "actions", style: "display: flex; gap: 8px;",
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| {
                                active_state.set(initial.clone());
                                reviewing.set(false);
                            },
                            button::Label { "Open app" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| selected_app.set(None),
                            button::Label { "Back to apps" }
                        }
                    }
                }
            };
        }

        let cur_state = active_state.read().clone();
        let state_obj = app
            .raw_json
            .get("states")
            .and_then(|s| s.get(&cur_state));
        let transitions: Vec<(String, String)> = state_obj
            .and_then(|s| s.get("on"))
            .and_then(|o| o.as_object())
            .map(|map| {
                map.iter()
                    .filter_map(|(evt, target)| {
                        let t = target
                            .as_str()
                            .or_else(|| target.get("target").and_then(|v| v.as_str()))?;
                        Some((evt.clone(), t.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();

        return rsx! {
            div {
                class: "nav-child-panel",
                "data-aeon-scope": "chart-app-view",
                "data-aeon-state": "{cur_state}",
                style: "display: flex; flex-direction: column; gap: 14px;",
                div { style: "display: flex; justify-content: space-between; align-items: center;",
                    div {
                        h3 { "{app.name}" }
                        p { class: "settings-row-desc mono", "State: {cur_state}" }
                    }
                    div { class: "actions", style: "display: flex; gap: 6px;",
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| reviewing.set(true),
                            button::Label { "Review" }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| selected_app.set(None),
                            button::Label { "Close" }
                        }
                    }
                }
                p { class: "settings-row-desc", "{app.summary}" }
                if !transitions.is_empty() {
                    div { class: "actions", style: "display: flex; gap: 8px; flex-wrap: wrap;",
                        for (evt, target) in transitions {
                            {
                                let next_target = target.clone();
                                let evt_label = evt.clone();
                                let evt_toast = evt.clone();
                                rsx! {
                                    button::Root {
                                        key: "{evt_label}",
                                        variant: button::ButtonVariant::Solid,
                                        class: "btn btn-primary",
                                        onclick: move |_| {
                                            active_state.set(next_target.clone());
                                            toast.set(Some(ToastNotice {
                                                title: format!("Event: {evt_toast}"),
                                                body: None,
                                                tone: "info",
                                            }));
                                        },
                                        button::Label { "{evt_label} → {target}" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
    }

    rsx! {
        div {
            class: "nav-section-body settings-scroll",
            "data-aeon-scope": "chart-apps",
            p { class: "settings-hint",
                "Chart apps are pure signed JSON statecharts. Every wallet action they request is declared up front and approved through your BRC-100 wallet."
            }
            section { class: "settings-group", "data-aeon-part": "builtin-apps",
                h3 { class: "settings-group-title", "Verified apps ({apps.len()})" }
                ul { class: "settings-list",
                    for app in apps.iter() {
                        {
                            let app_open = app.clone();
                            let app_review = app.clone();
                            let initial = app.initial_state.clone();
                            rsx! {
                                li { key: "{app.id}",
                                    list_row::Root { "data-aeon-layout": "control",
                                        list_row::Leading {
                                            span { class: "settings-row-icon", "data-tone": "default",
                                                AppsIcon { size: 20 }
                                            }
                                        }
                                        list_row::Label { "{app.name}" }
                                        list_row::Description { "{app.summary}" }
                                        list_row::Trailing {
                                            div { class: "actions", style: "display: flex; gap: 6px;",
                                                button::Root {
                                                    variant: button::ButtonVariant::Ghost,
                                                    class: "btn btn-ghost settings-action-btn",
                                                    onclick: move |_| {
                                                        reviewing.set(true);
                                                        selected_app.set(Some(app_review.clone()));
                                                    },
                                                    button::Label { "Review" }
                                                }
                                                button::Root {
                                                    variant: button::ButtonVariant::Solid,
                                                    class: "btn btn-primary settings-action-btn",
                                                    onclick: move |_| {
                                                        active_state.set(initial.clone());
                                                        reviewing.set(false);
                                                        selected_app.set(Some(app_open.clone()));
                                                    },
                                                    button::Label { "Open" }
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
