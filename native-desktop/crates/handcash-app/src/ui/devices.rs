// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Phase 4 Devices & Recovery UI components.
//! 1:1 port of:
//! - `src/components/QrScanner.tsx`
//! - `src/components/PairDevicePanel.tsx`
//! - `src/components/GoogleLoginPanel.tsx`
//! - `src/components/GoogleEmailRecoveryMethods.tsx`

use crate::icons::{DevicesIcon, ScanQrIcon};
use crate::state::{render_qr_svg, AppServices};
use crate::ui::EmptyState;
use aeon_dioxus::use_aeon_machine;
use aeon_ui::{button, field, status_banner};
use dioxus::prelude::*;
use handcash_machines::device_backup::{
    DeviceBackupEvent, DeviceBackupMachine, DeviceBackupState,
};
use handcash_machines::qr_scanner::{QrScannerEvent, QrScannerMachine, QrScannerState};
use std::sync::Arc;

/// 1:1 port of `src/components/QrScanner.tsx`.
/// Supports native image/clipboard QR scanning alongside direct paste fallback.
#[component]
pub fn QrScanner(
    #[props(default = "Point your camera at a QR code".to_string())] hint: String,
    #[props(default = "default".to_string())] layout: String,
    #[props(default)] show_cancel: Option<bool>,
    on_scan: EventHandler<String>,
    on_cancel: EventHandler<()>,
) -> Element {
    let scanner = use_aeon_machine::<QrScannerMachine>();
    let mut manual = use_signal(String::new);
    let cancel_visible = show_cancel.unwrap_or(layout != "fill");
    let trimmed = manual.read().trim().to_string();
    let can_submit = !trimmed.is_empty();
    let submit_val = trimmed.clone();
    let scanner_state = match scanner.state() {
        QrScannerState::Error => "error",
        other => other.as_str(),
    };
    rsx! {
        div {
            class: "qr-scanner",
            "data-aeon-scope": "qr-scanner",
            "data-aeon-state": "{scanner_state}",
            "data-layout": "{layout}",
            status_banner::Root { tone: status_banner::StatusTone::Info, status: Some("ready".to_string()),
                status_banner::Copy {
                    status_banner::Title { "Scan QR from image or paste payload" }
                    status_banner::Body { "{hint} — choose a QR image file, read from clipboard, or paste below." }
                }
            }
            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| {
                        match crate::native_media_auth::scan_qr_from_file_or_clipboard() {
                            Ok(decoded) => {
                                scanner.send(QrScannerEvent::Scanned);
                                on_scan.call(decoded);
                            }
                            Err(err) => {
                                scanner.send(QrScannerEvent::Fail { error: err });
                            }
                        }
                    },
                    button::Label { "Scan image / clipboard" }
                }
            }
            field::Root { class: "field",
                field::Label { r#for: "qr-scanner-paste", "Paste QR code text" }
                textarea {
                    id: "qr-scanner-paste",
                    class: "input mono",
                    rows: 3,
                    placeholder: "Paste pair code, peerpay link, or address…",
                    value: "{manual}",
                    oninput: move |e| manual.set(e.value()),
                }
            }
            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: !can_submit,
                    onclick: move |_| {
                        if !submit_val.is_empty() {
                            scanner.send(QrScannerEvent::Scanned);
                            on_scan.call(submit_val.clone());
                            manual.set(String::new());
                        }
                    },
                    button::Label { "Use code" }
                }
                if cancel_visible {
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| on_cancel.call(()),
                        button::Label { "Cancel" }
                    }
                }
            }
        }
    }
}

/// Human-readable platform label matching `platformLabel` in `src/components/PairDevicePanel.tsx`.
pub fn format_device_platform(raw: Option<&str>) -> String {
    let norm = raw.unwrap_or("").trim().to_ascii_lowercase();
    match norm.as_str() {
        "darwin" | "mac" => "Mac".to_string(),
        "win32" | "windows" => "Windows".to_string(),
        "linux" => "Linux".to_string(),
        "android" => "Android".to_string(),
        "ios" => "iPhone or iPad".to_string(),
        "" => "Device".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => "Device".to_string(),
            }
        }
    }
}

/// 1:1 port of `src/components/PairDevicePanel.tsx`.
#[component]
pub fn PairDevicePanel() -> Element {
    let services = use_context::<Arc<AppServices>>();
    let backup = use_aeon_machine::<DeviceBackupMachine>();
    let mut status_msg = use_signal(|| Option::<String>::None);

    let backup_state = backup.state();
    let backup_ctx = backup.context();
    let state_attr = backup.state_attr();
    let peers = services.list_peer_devices();
    let pair_json = services.build_local_pair_qr_json().unwrap_or_default();
    let qr_svg = if pair_json.is_empty() {
        None
    } else {
        Some(render_qr_svg(&pair_json))
    };

    if matches!(backup_state, DeviceBackupState::Scanning) {
        let svc_scan = Arc::clone(&services);
        return rsx! {
            div { class: "device-backup", "data-aeon-scope": "device-backup", "data-aeon-state": "{state_attr}",
                QrScanner {
                    hint: "Point at the other device’s code".to_string(),
                    on_cancel: move |_| backup.send(DeviceBackupEvent::ScanCancel),
                    on_scan: move |raw: String| {
                        match svc_scan.link_peer_from_json(&raw) {
                            Ok(row) => {
                                status_msg.set(Some(format!("Linked {}", row.label)));
                                backup.send(DeviceBackupEvent::Scanned {
                                    peer_device_id: None,
                                });
                            }
                            Err(err) => {
                                backup.send(DeviceBackupEvent::ScanCancel);
                                backup.send(DeviceBackupEvent::Fail { error: err });
                            }
                        }
                    },
                }
            }
        };
    }

    rsx! {
        div { class: "device-backup", "data-aeon-scope": "device-backup", "data-aeon-state": "{state_attr}",
            header { class: "device-backup-head",
                h3 { "Pair a device" }
                p { "Link devices, then give one wallet a sealed recovery copy." }
            }
            if let Some(msg) = status_msg.read().as_ref() {
                status_banner::Root { tone: status_banner::StatusTone::Success, status: Some("linked".to_string()),
                    status_banner::Copy { status_banner::Body { "{msg}" } }
                }
            }
            if let Some(err) = backup_ctx.error.as_ref() {
                status_banner::Root { tone: status_banner::StatusTone::Danger, status: Some("failed".to_string()),
                    status_banner::Copy { status_banner::Body { "{err}" } }
                }
            }
            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    onclick: move |_| backup.send(DeviceBackupEvent::Scan),
                    ScanQrIcon { size: 16 }
                    button::Label { "Add device" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| backup.send(DeviceBackupEvent::ToggleMyCode),
                    button::Label { if backup_ctx.show_my_code { "Hide my code" } else { "Show my code" } }
                }
            }
            if backup_ctx.show_my_code {
                div { class: "qr-card",
                    if let Some(svg) = qr_svg {
                        div { class: "qr-svg", dangerous_inner_html: "{svg}" }
                    }
                    p { class: "settings-hint mono", "{pair_json}" }
                }
            }
            if peers.is_empty() {
                EmptyState {
                    icon: rsx! { DevicesIcon { size: 28 } },
                    title: "No linked devices yet".to_string(),
                    body: Some("Scan or paste another device’s pairing code to link it.".to_string()),
                }
            } else {
                ul { class: "settings-list",
                    for peer in peers {
                        li { key: "{peer.device_id}", class: "settings-row",
                            strong { "{peer.label}" }
                            span { class: "settings-row-desc", "{format_device_platform(Some(peer.platform.as_str()))}" }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/GoogleLoginPanel.tsx`.
/// Uses native loopback PKCE OAuth (`native_media_auth::launch_google_oauth_recovery`).
#[component]
pub fn GoogleLoginPanel(
    #[props(default)] stage: Option<String>,
    #[props(default)] comparison_code: Option<String>,
    #[props(default)] error: Option<String>,
    on_cancel: EventHandler<()>,
) -> Element {
    let st = stage.unwrap_or_else(|| "ready".to_string());
    let err_text = error.unwrap_or_default();
    rsx! {
        div {
            class: "wallet-setup-config",
            "data-aeon-scope": "google-login",
            "data-aeon-state": "{st}",
            h2 { "Continue with Google" }
            p { class: "auth-lede",
                "Choose the Google account already registered to this vault. HandCash never asks you to type the email address."
            }
            if st == "comparing" {
                if let Some(code) = comparison_code {
                    div { class: "split-backup-shares",
                        h3 { "Compare this code" }
                        p { "data-aeon-part": "comparison-code", "{code}" }
                        p { class: "settings-hint", "Approve only if the existing device shows the same eight digits." }
                    }
                }
            } else if st == "failed" {
                status_banner::Root { tone: status_banner::StatusTone::Danger, status: Some("failed".to_string()),
                    status_banner::Copy {
                        status_banner::Title { "Google login stopped" }
                        status_banner::Body { "{err_text}" }
                    }
                }
            } else {
                status_banner::Root { tone: status_banner::StatusTone::Info, status: Some("ready".to_string()),
                    status_banner::Copy {
                        status_banner::Title { "Continue in your browser" }
                        status_banner::Body { "Opens Google OAuth via a local loopback callback to complete BRC-250 recovery." }
                    }
                }
            }
            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    onclick: move |_| {
                        let _ = crate::native_media_auth::launch_google_oauth_recovery();
                    },
                    button::Label { "Open Google" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| on_cancel.call(()),
                    button::Label { "Back" }
                }
            }
        }
    }
}

/// 1:1 port of `RecoveryMethod` + `GoogleEmailRecoveryMethods` in `src/components/GoogleEmailRecoveryMethods.tsx`.
#[component]
pub fn GoogleEmailRecoveryMethods(
    #[props(default)] enrolled_email: Option<String>,
) -> Element {
    let (stage, google_tone, google_text, email_tone, email_text) = match enrolled_email.as_deref() {
        Some(email) if !email.is_empty() => (
            "ready",
            "ok",
            format!("Verified · {email}"),
            "ok",
            format!("Saved · {email}"),
        ),
        _ => (
            "idle",
            "ready",
            "Ready to link Google".to_string(),
            "idle",
            "Waiting for Google".to_string(),
        ),
    };
    rsx! {
        div {
            class: "split-backup-shares",
            "data-aeon-scope": "handcash-recovery",
            "data-aeon-state": "{stage}",
            p { class: "settings-hint",
                "HandCash provides this recovery, not Google or your email provider. Your wallet key is split into shares: HandCash’s recovery server keeps one, your email keeps another, and neither opens the wallet alone."
            }
            ul { class: "recovery-methods",
                li { class: "recovery-method", "data-aeon-part": "recovery-google", "data-aeon-state": "{google_tone}",
                    div { class: "recovery-method-head",
                        strong { "Google" }
                        span { class: "recovery-method-status", "{google_text}" }
                    }
                    p { class: "settings-hint",
                        "Proves it’s you with the Google account already signed in to your browser. HandCash’s recovery server checks the sign-in; Google never holds a share."
                    }
                    if enrolled_email.is_none() {
                        div { class: "actions",
                            button::Root {
                                variant: button::ButtonVariant::Solid,
                                class: "btn btn-primary",
                                disabled: true,
                                button::Label { "Continue with Google" }
                            }
                        }
                    }
                }
                li { class: "recovery-method", "data-aeon-part": "recovery-email", "data-aeon-state": "{email_tone}",
                    div { class: "recovery-method-head",
                        strong { "Email" }
                        span { class: "recovery-method-status", "{email_text}" }
                    }
                    p { class: "settings-hint",
                        "Holds the second share. HandCash puts it in a draft to your Google address; send it, then paste the share back once to prove it arrived."
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
    fn format_device_platform_matches_ts() {
        assert_eq!(format_device_platform(Some("darwin")), "Mac");
        assert_eq!(format_device_platform(Some("win32")), "Windows");
        assert_eq!(format_device_platform(Some("linux")), "Linux");
        assert_eq!(format_device_platform(Some("ios")), "iPhone or iPad");
        assert_eq!(format_device_platform(None), "Device");
    }
}
