// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Phase 10 Platform Extras.
//! 1:1 port of:
//! - `src/components/UpdatePrompt.tsx`
//! - `src/components/ScreenshotToast.tsx`
//! - `src/components/calls/CallDock.tsx`

use aeon_dioxus::use_aeon_machine;
use aeon_ui::{button, prompt};
use dioxus::prelude::*;
use handcash_machines::update::{UpdateEvent, UpdateMachine, UpdateMode, UpdatePhase, UpdateStatus};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateToastCopy {
    pub title: String,
    pub body: String,
    pub action: Option<&'static str>,
    pub dismissable: bool,
    pub sticky: bool,
}

/// 1:1 port of `toastCopy` in `src/components/UpdatePrompt.tsx`.
pub fn update_toast_copy(
    phase: &str,
    version: Option<&str>,
    percent: Option<u8>,
    error: Option<&str>,
    from_check: bool,
    sideload_manual: bool,
    product_name: &str,
) -> Option<UpdateToastCopy> {
    let ver = version.unwrap_or("");
    match phase {
        "ready" => Some(UpdateToastCopy {
            title: "Update ready".to_string(),
            body: format!("{product_name} {ver} is ready to install."),
            action: Some("restart"),
            dismissable: true,
            sticky: true,
        }),
        "downloading" => Some(UpdateToastCopy {
            title: if sideload_manual {
                "Opening installer…".to_string()
            } else {
                "Downloading update…".to_string()
            },
            body: if sideload_manual {
                format!("{product_name} {ver} — follow the download prompt to install.")
            } else {
                format!("{} — {}%", version.unwrap_or("Update"), percent.unwrap_or(0))
            },
            action: None,
            dismissable: false,
            sticky: true,
        }),
        "available" => Some(UpdateToastCopy {
            title: "Update available".to_string(),
            body: if sideload_manual {
                error
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{product_name} {ver} is ready. Download and install the new build."))
            } else {
                format!("{product_name} {ver} is available.")
            },
            action: Some("download"),
            dismissable: true,
            sticky: true,
        }),
        "checking" => Some(UpdateToastCopy {
            title: "Checking for updates…".to_string(),
            body: "Looking for a newer HandCash Desktop build.".to_string(),
            action: None,
            dismissable: false,
            sticky: true,
        }),
        "error" => Some(UpdateToastCopy {
            title: "Update check failed".to_string(),
            body: error
                .unwrap_or("Something went wrong while checking for updates.")
                .to_string(),
            action: None,
            dismissable: true,
            sticky: false,
        }),
        "not-available" if from_check => Some(UpdateToastCopy {
            title: "Up to date".to_string(),
            body: error
                .map(str::to_string)
                .unwrap_or_else(|| format!("You're on the latest {product_name}.")),
            action: None,
            dismissable: true,
            sticky: false,
        }),
        _ => None,
    }
}

/// 1:1 port of `src/components/UpdatePrompt.tsx`.
#[component]
pub fn UpdatePrompt(
    #[props(default = "idle".to_string())] phase: String,
    #[props(default)] available_version: Option<String>,
    #[props(default)] percent: Option<u8>,
    #[props(default)] error: Option<String>,
    #[props(default)] prompt_open: bool,
    #[props(default)] from_check: bool,
    #[props(default)] sideload_manual: bool,
    #[props(default)] on_download: Option<EventHandler<()>>,
    #[props(default)] on_install: Option<EventHandler<()>>,
    #[props(default)] on_dismiss: Option<EventHandler<()>>,
) -> Element {
    let update_chart = use_aeon_machine::<UpdateMachine>();
    let dismiss_key = available_version
        .clone()
        .unwrap_or_else(|| phase.clone());
    let sync_phase = phase.clone();
    let sync_key = dismiss_key.clone();
    use_hook(move || {
        let mapped_phase = match sync_phase.as_str() {
            "checking" => UpdatePhase::Checking,
            "available" => UpdatePhase::Available,
            "not-available" => UpdatePhase::NotAvailable,
            "downloading" => UpdatePhase::Downloading,
            "ready" => UpdatePhase::Ready,
            "error" => UpdatePhase::Error,
            _ => UpdatePhase::Idle,
        };
        update_chart.send(UpdateEvent::Sync {
            status: UpdateStatus {
                phase: mapped_phase,
                mode: UpdateMode::Default,
                current_version: String::new(),
                available_version: Some(sync_key),
                percent: None,
                error: None,
                can_install: false,
            },
        });
    });
    let is_dismissed = update_chart
        .context()
        .prompt_dismissed_version
        .as_deref()
        == Some(dismiss_key.as_str());
    let copy = update_toast_copy(
        &phase,
        available_version.as_deref(),
        percent,
        error.as_deref(),
        from_check,
        sideload_manual,
        "HandCash Desktop",
    );
    rsx! {
        div { "data-aeon-scope": "app-update", "data-aeon-state": "{phase}",
            if !is_dismissed {
                if let Some(c) = copy {
                    div {
                        class: "aeonToast__viewport update-toast-viewport",
                        "data-aeon-scope": "toast",
                        "data-aeon-part": "viewport",
                        "data-aeon-state": "active",
                        "data-placement": "bottom-end",
                        div {
                            class: "aeonToast__root update-toast",
                            role: "status",
                            aria_live: "polite",
                            "data-aeon-scope": "toast",
                            "data-aeon-part": "root",
                            "data-aeon-state": "{phase}",
                            p { class: "aeonToast__title", "data-aeon-scope": "toast", "data-aeon-part": "title", "{c.title}" }
                            p { class: "aeonToast__description", "data-aeon-scope": "toast", "data-aeon-part": "description", "{c.body}" }
                            if let Some(act) = c.action {
                                div { class: "update-toast-actions",
                                    if act == "download" {
                                        button::Root {
                                            variant: button::ButtonVariant::Solid,
                                            class: "btn btn-primary",
                                            onclick: move |_| {
                                                if let Some(cb) = on_download { cb.call(()); }
                                            },
                                            button::Label { if sideload_manual { "Get update" } else { "Update" } }
                                        }
                                    } else if act == "restart" {
                                        button::Root {
                                            variant: button::ButtonVariant::Solid,
                                            class: "btn btn-primary",
                                            onclick: move |_| {
                                                if let Some(cb) = on_install { cb.call(()); }
                                            },
                                            button::Label { "Restart to Update" }
                                        }
                                    }
                                }
                            }
                            if c.dismissable {
                                button {
                                    r#type: "button",
                                    class: "aeonToast__closeTrigger",
                                    "data-aeon-scope": "toast",
                                    "data-aeon-part": "closeTrigger",
                                    aria_label: "Dismiss",
                                    onclick: move |_| {
                                        update_chart.send(UpdateEvent::DismissPrompt);
                                        if let Some(cb) = on_dismiss { cb.call(()); }
                                    },
                                    "×"
                                }
                            }
                        }
                    }
                }
            }
            if prompt_open {
                div { class: "permission-backdrop",
                    prompt::Root {
                        status: prompt::PromptStatus::Pending,
                        class: "panel modal update-prompt-modal",
                        prompt::Eyebrow { "Security" }
                        h2 { "Restart to Update" }
                        p {
                            "HandCash Desktop "
                            strong { "{available_version.clone().unwrap_or_default()}" }
                            " has been downloaded and is ready to install."
                        }
                        prompt::Actions {
                            prompt::Secondary {
                                class: "btn btn-ghost",
                                onclick: move |_| {
                                    if let Some(cb) = on_dismiss { cb.call(()); }
                                },
                                "Later"
                            }
                            prompt::Primary {
                                class: "btn btn-primary",
                                onclick: move |_| {
                                    if let Some(cb) = on_install { cb.call(()); }
                                },
                                "Restart to Update"
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/ScreenshotToast.tsx`.
/// Native window capture is not wired in Blitz yet; surfaces nothing until a capture event arrives.
#[component]
pub fn ScreenshotToast(#[props(default)] copied_version: Option<String>) -> Element {
    let Some(version) = copied_version else {
        return rsx! {};
    };
    rsx! {
        div {
            class: "aeonToast__root",
            role: "status",
            "data-aeon-scope": "screenshot-toast",
            "data-aeon-state": "copied",
            strong { "Screenshot copied" }
            span { "v{version} BETA" }
        }
    }
}

/// 1:1 port of `clock` in `src/components/calls/CallDock.tsx`.
pub fn format_call_clock(elapsed_ms: u64) -> String {
    let s = elapsed_ms / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

/// 1:1 port of `src/components/calls/CallDock.tsx`.
/// Renders null in `idle`; gated cleanly with `data-aeon-state="unavailable"` when calls service is absent.
#[component]
pub fn CallDock(
    #[props(default = "idle".to_string())] state: String,
    #[props(default)] peer_label: String,
    #[props(default)] status_label: String,
    #[props(default)] elapsed_ms: u64,
    #[props(default)] muted: bool,
    #[props(default)] camera_on: bool,
    #[props(default)] encrypted: bool,
    #[props(default)] on_accept: Option<EventHandler<()>>,
    #[props(default)] on_decline: Option<EventHandler<()>>,
    #[props(default)] on_toggle_mute: Option<EventHandler<()>>,
    #[props(default)] on_toggle_camera: Option<EventHandler<()>>,
    #[props(default)] on_hang_up: Option<EventHandler<()>>,
    #[props(default)] on_dismiss: Option<EventHandler<()>>,
) -> Element {
    if state == "idle" {
        return rsx! {};
    }
    let incoming = state == "incoming";
    let ended = state == "ended";
    let live = state == "active";
    rsx! {
        aside {
            class: "call-dock",
            role: "region",
            aria_label: "Call",
            "data-aeon-scope": "call-dock",
            "data-aeon-state": "{state}",
            div { class: "call-dock-info", "data-aeon-part": "info",
                strong { "{peer_label}" }
                span {
                    if live {
                        "{status_label} · {format_call_clock(elapsed_ms)}"
                    } else {
                        "{status_label}"
                    }
                }
                if live && encrypted {
                    span { title: "Media is end-to-end encrypted", "Encrypted" }
                }
            }
            div { class: "call-dock-actions", "data-aeon-part": "actions",
                if incoming {
                    button::Root {
                        class: "btn",
                        onclick: move |_| { if let Some(cb) = on_accept { cb.call(()); } },
                        button::Label { "Answer" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| { if let Some(cb) = on_decline { cb.call(()); } },
                        button::Label { "Decline" }
                    }
                } else if ended {
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| { if let Some(cb) = on_dismiss { cb.call(()); } },
                        button::Label { "Close" }
                    }
                } else {
                    if live {
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            aria_pressed: if muted { "true" } else { "false" },
                            onclick: move |_| { if let Some(cb) = on_toggle_mute { cb.call(()); } },
                            button::Label { if muted { "Unmute" } else { "Mute" } }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            aria_pressed: if camera_on { "true" } else { "false" },
                            onclick: move |_| { if let Some(cb) = on_toggle_camera { cb.call(()); } },
                            button::Label { if camera_on { "Camera off" } else { "Camera on" } }
                        }
                    }
                    button::Root {
                        class: "btn",
                        onclick: move |_| { if let Some(cb) = on_hang_up { cb.call(()); } },
                        button::Label { if live { "Hang up" } else { "Cancel" } }
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
    fn update_toast_copy_and_call_clock_match_ts() {
        let ready = update_toast_copy("ready", Some("1.3.722"), None, None, false, false, "HandCash Desktop").unwrap();
        assert_eq!(ready.title, "Update ready");
        assert_eq!(ready.action, Some("restart"));
        let dl = update_toast_copy("downloading", Some("1.3.722"), Some(42), None, false, false, "HandCash Desktop").unwrap();
        assert_eq!(dl.body, "1.3.722 — 42%");
        assert!(update_toast_copy("not-available", None, None, None, false, false, "HandCash Desktop").is_none());
        assert!(update_toast_copy("not-available", None, None, None, true, false, "HandCash Desktop").is_some());
        assert_eq!(format_call_clock(0), "0:00");
        assert_eq!(format_call_clock(65_000), "1:05");
    }
}
