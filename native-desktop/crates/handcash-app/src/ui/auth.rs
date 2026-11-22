// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/AuthShell.tsx`, `src/components/OnboardEntryPanel.tsx`,
//! `src/components/AuthScreen.tsx`, `src/components/PasswordField.tsx`, and
//! `src/components/auth/AuthEntryTaglines.tsx`.

use crate::icons::{EyeIcon, EyeOffIcon};
use crate::machines::{AppSessionEvent, AppSessionMachine, AuthFormMode, ToastNotice, UnlockState};
use crate::state::{AppServices, WalletSnapshot};
use crate::ui::BrandLogo;
use aeon_ui::{button, field};
use dioxus::prelude::*;
use handcash_primitives::keys::MnemonicScheme;
use std::sync::Arc;

const AUTH_ENTRY_TAGLINES: &[&str] = &[
    "Exchange directly with peers.",
    "Value that moves between people.",
    "Settle with anyone, anywhere.",
    "Send and receive as equals.",
    "Define your own business.",
    "Shape how your business appears.",
    "Set the terms of your trade.",
    "Present your business your way.",
];

/// 1:1 port of `src/components/AuthShell.tsx` + `AuthMeshBackground.tsx`.
#[component]
pub fn AuthShell(
    #[props(default = "")] state: &'static str,
    #[props(default = true)] dark_mode: bool,
    children: Element,
) -> Element {
    let edge_stroke = if dark_mode {
        "rgba(100, 255, 160, 0.14)"
    } else {
        "rgba(0, 0, 0, 0.08)"
    };
    let node_fill = if dark_mode {
        "rgba(100, 255, 160, 0.42)"
    } else {
        "rgba(56, 203, 123, 0.55)"
    };

    rsx! {
        div {
            class: "auth-shell",
            "data-aeon-scope": "auth-shell",
            "data-aeon-state": state,

            // Geometric payment-mesh SVG backdrop mirroring `AuthMeshBackground.tsx`
            div { class: "auth-shell-mesh", "data-aeon-part": "backdrop",
                svg {
                    view_box: "0 0 1200 800",
                    width: "100%",
                    height: "100%",
                    preserve_aspect_ratio: "xMidYMid slice",
                    fill: "none",
                    // Mesh edges
                    g { stroke: "{edge_stroke}", stroke_width: "1",
                        line { x1: "90", y1: "120", x2: "260", y2: "190" }
                        line { x1: "260", y1: "190", x2: "430", y2: "110" }
                        line { x1: "430", y1: "110", x2: "640", y2: "180" }
                        line { x1: "640", y1: "180", x2: "860", y2: "120" }
                        line { x1: "860", y1: "120", x2: "1080", y2: "200" }
                        line { x1: "90", y1: "120", x2: "160", y2: "360" }
                        line { x1: "260", y1: "190", x2: "340", y2: "390" }
                        line { x1: "430", y1: "110", x2: "340", y2: "390" }
                        line { x1: "640", y1: "180", x2: "580", y2: "380" }
                        line { x1: "640", y1: "180", x2: "820", y2: "340" }
                        line { x1: "860", y1: "120", x2: "820", y2: "340" }
                        line { x1: "1080", y1: "200", x2: "1020", y2: "430" }
                        line { x1: "160", y1: "360", x2: "340", y2: "390" }
                        line { x1: "340", y1: "390", x2: "580", y2: "380" }
                        line { x1: "580", y1: "380", x2: "820", y2: "340" }
                        line { x1: "820", y1: "340", x2: "1020", y2: "430" }
                        line { x1: "160", y1: "360", x2: "110", y2: "620" }
                        line { x1: "340", y1: "390", x2: "290", y2: "640" }
                        line { x1: "580", y1: "380", x2: "510", y2: "610" }
                        line { x1: "580", y1: "380", x2: "740", y2: "650" }
                        line { x1: "820", y1: "340", x2: "740", y2: "650" }
                        line { x1: "1020", y1: "430", x2: "980", y2: "670" }
                        line { x1: "110", y1: "620", x2: "290", y2: "640" }
                        line { x1: "290", y1: "640", x2: "510", y2: "610" }
                        line { x1: "510", y1: "610", x2: "740", y2: "650" }
                        line { x1: "740", y1: "650", x2: "980", y2: "670" }
                    }
                    // Mesh nodes
                    g { fill: "{node_fill}",
                        circle { cx: "90", cy: "120", r: "2.5" }
                        circle { cx: "260", cy: "190", r: "3" }
                        circle { cx: "430", cy: "110", r: "2" }
                        circle { cx: "640", cy: "180", r: "3.2" }
                        circle { cx: "860", cy: "120", r: "2.5" }
                        circle { cx: "1080", cy: "200", r: "2.5" }
                        circle { cx: "160", cy: "360", r: "2.8" }
                        circle { cx: "340", cy: "390", r: "3" }
                        circle { cx: "580", cy: "380", r: "2.4" }
                        circle { cx: "820", cy: "340", r: "3.2" }
                        circle { cx: "1020", cy: "430", r: "2.6" }
                        circle { cx: "110", cy: "620", r: "2.5" }
                        circle { cx: "290", cy: "640", r: "3" }
                        circle { cx: "510", cy: "610", r: "2.5" }
                        circle { cx: "740", cy: "650", r: "3" }
                        circle { cx: "980", cy: "670", r: "2.5" }
                    }
                }
            }

            div { class: "auth-shell-scrim", "data-aeon-part": "scrim" }
            div { class: "auth-shell-content", "data-aeon-part": "content",
                {children}
            }
        }
    }
}

/// 1:1 port of `src/components/OnboardEntryPanel.tsx` + `src/components/AuthScreen.tsx`.
#[component]
pub fn AuthFlow(
    is_locked: bool,
    mut auth_mode: Signal<AuthFormMode>,
    mut app_machine: Signal<AppSessionMachine>,
    mut snapshot: Signal<WalletSnapshot>,
    mut fresh_mnemonic: Signal<Option<String>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();

    let mut unlock_state = use_signal(|| UnlockState::Idle);
    let mut error_msg = use_signal(|| Option::<String>::None);
    let mut password = use_signal(String::new);
    let mut confirm_password = use_signal(String::new);
    let mut handle = use_signal(String::new);
    let mut mnemonic_input = use_signal(String::new);
    let passphrase_input = use_signal(String::new);
    let mut scheme = use_signal(|| "brc157".to_string());
    let mut chain = use_signal(|| "main".to_string());

    let mode = *auth_mode.read();

    // ── OnboardEntryPanel (`src/components/OnboardEntryPanel.tsx`) ──
    if !is_locked && mode == AuthFormMode::Entry {
        let tagline = AUTH_ENTRY_TAGLINES[0];
        return rsx! {
            section {
                class: "auth-screen",
                "data-aeon-scope": "auth",
                "data-aeon-state": "onboard-entry",
                div { class: "auth-entry-brand", "data-aeon-part": "entry-brand",
                    BrandLogo { size: 48, show_wordmark: true }
                }
                div { class: "auth-entry-actions", "data-aeon-part": "entry-actions",
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary auth-entry-primary",
                        "data-aeon-part": "sign-in",
                        onclick: move |_| {
                            error_msg.set(None);
                            auth_mode.set(AuthFormMode::Phrase);
                        },
                        button::Label { "Sign in" }
                    }
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost auth-entry-secondary",
                        "data-aeon-part": "create",
                        onclick: move |_| {
                            error_msg.set(None);
                            auth_mode.set(AuthFormMode::Create);
                        },
                        button::Label { "Create new wallet" }
                    }
                }
                p { class: "auth-alt",
                    button {
                        r#type: "button",
                        class: "auth-alt-link",
                        "data-aeon-part": "migrate",
                        onclick: move |_| {
                            error_msg.set(None);
                            auth_mode.set(AuthFormMode::Phrase);
                        },
                        "Recover an old HandCash wallet"
                    }
                }
                p {
                    class: "auth-entry-tagline is-in",
                    "data-aeon-part": "entry-tagline",
                    "{tagline}"
                }
            }
        };
    }

    let title = match mode {
        AuthFormMode::Phrase => "Restore on this device",
        AuthFormMode::Create => "Create wallet",
        AuthFormMode::Unlock | AuthFormMode::Entry => "Welcome back",
    };

    let lede = match mode {
        AuthFormMode::Phrase => {
            "Enter your recovery phrase, 12 or 24 words. Same phrase = same identity on Desktop or Mobile."
        }
        AuthFormMode::Create => "Your keys stay on this device.",
        AuthFormMode::Unlock | AuthFormMode::Entry => "Enter your HandCash password to unlock.",
    };

    let primary_label = match mode {
        AuthFormMode::Phrase => "Restore",
        AuthFormMode::Create => "Create",
        AuthFormMode::Unlock | AuthFormMode::Entry => "Unlock",
    };

    let submitting = *unlock_state.read() == UnlockState::Opening;
    let submit_label = if submitting {
        "Working…"
    } else {
        primary_label
    };
    let svc_submit = Arc::clone(&services);

    rsx! {
        section {
            class: "auth-screen",
            "data-aeon-scope": "auth",
            "data-aeon-state": unlock_state.read().as_attr(),

            div { class: "auth-copy",
                h1 { class: "auth-title", "{title}" }
                p { class: "auth-lede", "{lede}" }
            }

            form {
                class: "auth-form",
                "data-aeon-part": "form",
                onsubmit: move |e| {
                    e.prevent_default();
                    error_msg.set(None);
                    unlock_state.set(UnlockState::Opening);

                    match mode {
                        AuthFormMode::Unlock | AuthFormMode::Entry => {
                            let pw = password.read().clone();
                            match svc_submit.unlock_with_password(&pw) {
                                Ok(sum) => {
                                    password.set(String::new());
                                    unlock_state.set(UnlockState::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    app_machine.write().send(AppSessionEvent::Unlocked {
                                        profile: sum,
                                        balance_sats: sats,
                                    });
                                }
                                Err(err) => {
                                    unlock_state.set(UnlockState::Failed);
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Create => {
                            let h = handle.read().trim().to_string();
                            let pw = password.read().clone();
                            let cpw = confirm_password.read().clone();
                            let c = chain.read().clone();
                            if !cpw.is_empty() && pw != cpw {
                                unlock_state.set(UnlockState::Failed);
                                error_msg.set(Some("Passwords do not match.".into()));
                                return;
                            }
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            match svc_submit.create_vault(&eff_handle, &pw, &c) {
                                Ok((sum, phrase)) => {
                                    password.set(String::new());
                                    confirm_password.set(String::new());
                                    fresh_mnemonic.set(phrase);
                                    unlock_state.set(UnlockState::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    app_machine.write().send(AppSessionEvent::Created {
                                        profile: sum,
                                        balance_sats: sats,
                                    });
                                    toast.set(Some(ToastNotice {
                                        title: "Wallet created".into(),
                                        body: Some("Save your 24-word recovery phrase in Settings → Recovery backup.".into()),
                                        tone: "success",
                                    }));
                                }
                                Err(err) => {
                                    unlock_state.set(UnlockState::Failed);
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Phrase => {
                            let h = handle.read().trim().to_string();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            let m = mnemonic_input.read().clone();
                            let pass = passphrase_input.read().clone();
                            let pw = password.read().clone();
                            let c = chain.read().clone();
                            let sch = match scheme.read().as_str() {
                                "brc75" => MnemonicScheme::Brc75,
                                "legacy" => MnemonicScheme::LegacyHd,
                                _ => MnemonicScheme::Brc157,
                            };
                            match svc_submit.restore_vault(&eff_handle, &m, &pass, &pw, &c, sch) {
                                Ok(sum) => {
                                    password.set(String::new());
                                    mnemonic_input.set(String::new());
                                    unlock_state.set(UnlockState::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    app_machine.write().send(AppSessionEvent::Unlocked {
                                        profile: sum,
                                        balance_sats: sats,
                                    });
                                }
                                Err(err) => {
                                    unlock_state.set(UnlockState::Failed);
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                    }
                },

                // Mode switch on locked screen (Unlock / Restore)
                if is_locked {
                    div { class: "auth-mode-switch", role: "tablist", aria_label: "Wallet access",
                        button {
                            r#type: "button",
                            role: "tab",
                            class: "auth-mode-tab",
                            "data-aeon-state": if mode == AuthFormMode::Unlock { "selected" } else { "idle" },
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Unlock);
                            },
                            "Unlock"
                        }
                        button {
                            r#type: "button",
                            role: "tab",
                            class: "auth-mode-tab",
                            "data-aeon-state": if mode == AuthFormMode::Phrase { "selected" } else { "idle" },
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Phrase);
                            },
                            "Restore"
                        }
                    }
                }

                // Recovery phrase field
                if mode == AuthFormMode::Phrase {
                    field::Root { class: "field",
                        field::Label { "Recovery phrase" }
                        textarea {
                            rows: "3",
                            placeholder: "12 or 24 words separated by spaces",
                            value: "{mnemonic_input}",
                            oninput: move |e| mnemonic_input.set(e.value()),
                        }
                    }
                    field::Root { class: "field",
                        field::Label { "Handle" }
                        input {
                            placeholder: "satoshi",
                            value: "{handle}",
                            oninput: move |e| handle.set(e.value()),
                        }
                    }
                    field::Root { class: "field",
                        field::Label { "Derivation scheme" }
                        select {
                            value: "{scheme}",
                            onchange: move |e| scheme.set(e.value()),
                            option { value: "brc157", "BRC-157 (HandCash Default)" }
                            option { value: "brc75", "BRC-75 (SHA-256 Seed)" }
                            option { value: "legacy", "Legacy HD (BIP-32)" }
                        }
                    }
                    PasswordField {
                        id: "restore-passphrase",
                        label: "Optional BIP-39 passphrase",
                        placeholder: "Leave blank if none",
                        value: passphrase_input,
                    }
                }

                // Create handle + network
                if mode == AuthFormMode::Create {
                    field::Root { class: "field",
                        field::Label { "Handle" }
                        input {
                            placeholder: "satoshi",
                            value: "{handle}",
                            oninput: move |e| handle.set(e.value()),
                        }
                    }
                    field::Root { class: "field",
                        field::Label { "Network" }
                        select {
                            value: "{chain}",
                            onchange: move |e| chain.set(e.value()),
                            option { value: "main", "Bitcoin SV Mainnet" }
                            option { value: "test", "Bitcoin SV Testnet" }
                        }
                    }
                }

                // Password field (Unlock / Create / Restore)
                PasswordField {
                    id: "password",
                    label: "HandCash password",
                    placeholder: if mode == AuthFormMode::Unlock {
                        "Your password"
                    } else {
                        "8+ characters"
                    },
                    value: password,
                }

                if mode == AuthFormMode::Create {
                    p { class: "password-hint",
                        "Encrypts your local vault on this device."
                    }
                    PasswordField {
                        id: "password-confirm",
                        label: "Confirm password",
                        placeholder: "Type it again",
                        value: confirm_password,
                    }
                }

                if let Some(ref err) = *error_msg.read() {
                    p { class: "error auth-error", role: "alert", "{err}" }
                }

                button::Root {
                    variant: button::ButtonVariant::Solid,
                    button_type: "submit",
                    class: "btn btn-primary auth-submit",
                    "data-aeon-part": "trigger",
                    "data-aeon-state": unlock_state.read().as_attr(),
                    disabled: submitting,
                    button::Label { "{submit_label}" }
                }

                if !is_locked && mode == AuthFormMode::Create {
                    p { class: "auth-alt",
                        "Already have a wallet? "
                        button {
                            r#type: "button",
                            class: "auth-alt-link",
                            "data-aeon-part": "existing-wallet",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Phrase);
                            },
                            "Sign in"
                        }
                    }
                }

                if !is_locked && mode == AuthFormMode::Phrase {
                    p { class: "auth-alt",
                        "New here? "
                        button {
                            r#type: "button",
                            class: "auth-alt-link",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Create);
                            },
                            "Create a wallet"
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/PasswordField.tsx`.
#[component]
pub fn PasswordField(
    id: String,
    label: String,
    placeholder: String,
    mut value: Signal<String>,
) -> Element {
    let mut visible = use_signal(|| false);
    let is_vis = *visible.read();

    rsx! {
        field::Root { class: "field",
            field::Label { "{label}" }
            div { class: "password-field",
                input {
                    id: "{id}",
                    r#type: if is_vis { "text" } else { "password" },
                    placeholder: "{placeholder}",
                    value: "{value}",
                    oninput: move |e| value.set(e.value()),
                }
                button {
                    r#type: "button",
                    class: "password-field-toggle",
                    aria_label: if is_vis { "Hide password" } else { "Show password" },
                    onclick: move |_| visible.set(!is_vis),
                    if is_vis {
                        EyeOffIcon { size: 18 }
                    } else {
                        EyeIcon { size: 18 }
                    }
                }
            }
        }
    }
}
