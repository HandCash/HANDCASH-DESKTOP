// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Phase 5 Legacy Wallet Import UI components.
//! 1:1 port of:
//! - `src/components/import/importSourceIcons.tsx`
//! - `src/components/import/ImportSecretForm.tsx`
//! - `src/components/import/ImportSourceView.tsx`
//! - `src/components/import/ImportItemBrowser.tsx`
//! - `src/components/import/ImportPanel.tsx`

use crate::icons::{FileIcon, KeyIcon};
use crate::ui::primitives::{DeferredImage, SearchField, SettingsSection};
use aeon_ui::{button, field, status_banner};
use dioxus::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImportSourceKind {
    HandCash,
    Twetch,
    Yours,
    Phrase,
    Wif,
}

impl ImportSourceKind {
    pub const ALL: &'static [Self] = &[
        Self::HandCash,
        Self::Twetch,
        Self::Yours,
        Self::Phrase,
        Self::Wif,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HandCash => "handcash",
            Self::Twetch => "twetch",
            Self::Yours => "yours",
            Self::Phrase => "phrase",
            Self::Wif => "wif",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::HandCash => "HandCash (legacy)",
            Self::Twetch => "Twetch",
            Self::Yours => "Yours Wallet",
            Self::Phrase => "Recovery phrase",
            Self::Wif => "Private keys (WIF)",
        }
    }

    pub const fn hint(self) -> &'static str {
        match self {
            Self::HandCash => "Two xprv keys exported from a legacy HandCash account",
            Self::Twetch => "12-word recovery phrase from Twetch",
            Self::Yours => "Backup JSON exported from Yours Wallet",
            Self::Phrase => "12- or 24-word BIP39 recovery phrase",
            Self::Wif => "One or more WIF private keys",
        }
    }

    pub const fn is_wallet_brand(self) -> bool {
        matches!(self, Self::HandCash | Self::Twetch | Self::Yours)
    }
}

/// 1:1 port of `src/components/import/importSourceIcons.tsx`.
#[component]
pub fn ImportSourceIcon(
    kind: ImportSourceKind,
    #[props(default = "md".to_string())] size: String,
) -> Element {
    let px = if size == "lg" { 24 } else { 20 };
    if kind.is_wallet_brand() {
        rsx! {
            span {
                class: "import-source-mark",
                "data-kind": kind.as_str(),
                "data-size": "{size}",
                aria_hidden: "true",
                DeferredImage {
                    src: None,
                    alt: String::new(),
                    fallback: Some(rsx! {
                        span { class: "import-source-glyph", "data-size": "{size}",
                            KeyIcon { size: px }
                        }
                    }),
                }
            }
        }
    } else {
        rsx! {
            span { class: "import-source-glyph", "data-size": "{size}", aria_hidden: "true",
                if matches!(kind, ImportSourceKind::Phrase) {
                    FileIcon { size: px }
                } else {
                    KeyIcon { size: px }
                }
            }
        }
    }
}

/// Fields submitted by `ImportSecretForm`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SecretFields {
    pub primary: String,
    pub secondary: String,
    pub passphrase: String,
    pub label: String,
}

pub fn secret_fields_ready(kind: ImportSourceKind, fields: &SecretFields) -> bool {
    if fields.primary.trim().is_empty() {
        return false;
    }
    if kind == ImportSourceKind::HandCash {
        let has_second = !fields.secondary.trim().is_empty();
        let has_two_xprvs = fields.primary.matches("xprv").count() >= 2;
        return has_second || has_two_xprvs;
    }
    true
}

/// 1:1 port of `src/components/import/ImportSecretForm.tsx`.
#[component]
pub fn ImportSecretForm(
    kind: ImportSourceKind,
    #[props(default)] saving: bool,
    #[props(default)] error: Option<String>,
    #[props(default = true)] scan_gated: bool,
    on_submit: EventHandler<SecretFields>,
    on_back: EventHandler<()>,
) -> Element {
    let mut primary = use_signal(String::new);
    let mut secondary = use_signal(String::new);
    let mut passphrase = use_signal(String::new);
    let mut label = use_signal(String::new);

    let fields = SecretFields {
        primary: primary.read().clone(),
        secondary: secondary.read().clone(),
        passphrase: passphrase.read().clone(),
        label: label.read().clone(),
    };
    let ready = secret_fields_ready(kind, &fields);
    let submit_fields = fields.clone();

    rsx! {
        div {
            class: "settings-form",
            "data-aeon-part": "secret-form",
            "data-aeon-state": if scan_gated { "unavailable" } else { kind.as_str() },
            header { class: "import-source-head", "data-aeon-part": "head",
                ImportSourceIcon { kind, size: "lg".to_string() }
                div {
                    h3 { class: "confirm-password-title", "{kind.label()}" }
                    p { class: "confirm-password-lede", "{kind.hint()}" }
                }
            }
            if kind == ImportSourceKind::HandCash {
                field::Root { class: "field",
                    field::Label { r#for: "import-hc-first", "First key" }
                    textarea {
                        id: "import-hc-first",
                        class: "input mono",
                        rows: 3,
                        value: "{primary}",
                        placeholder: "xprv… — or paste the whole export here",
                        disabled: saving,
                        oninput: move |e| primary.set(e.value()),
                    }
                }
                field::Root { class: "field",
                    field::Label { r#for: "import-hc-second", "Second key" }
                    textarea {
                        id: "import-hc-second",
                        class: "input mono",
                        rows: 3,
                        value: "{secondary}",
                        placeholder: "xprv…",
                        disabled: saving,
                        oninput: move |e| secondary.set(e.value()),
                    }
                }
            } else if matches!(kind, ImportSourceKind::Phrase | ImportSourceKind::Twetch) {
                field::Root { class: "field",
                    field::Label { r#for: "import-phrase-words", "Recovery phrase" }
                    textarea {
                        id: "import-phrase-words",
                        class: "input mono",
                        rows: 3,
                        value: "{primary}",
                        placeholder: "twelve words separated by spaces",
                        disabled: saving,
                        oninput: move |e| primary.set(e.value()),
                    }
                }
                if kind == ImportSourceKind::Phrase {
                    field::Root { class: "field",
                        field::Label { r#for: "import-phrase-passphrase", "BIP39 passphrase (optional)" }
                        input {
                            id: "import-phrase-passphrase",
                            class: "input",
                            r#type: "password",
                            value: "{passphrase}",
                            disabled: saving,
                            oninput: move |e| passphrase.set(e.value()),
                        }
                    }
                }
            } else if kind == ImportSourceKind::Yours {
                field::Root { class: "field",
                    field::Label { r#for: "import-yours-json", "Paste backup JSON" }
                    textarea {
                        id: "import-yours-json",
                        class: "input mono",
                        rows: 4,
                        value: "{primary}",
                        placeholder: "{{\"mnemonic\": \"…\", \"payPk\": \"…\", \"ordPk\": \"…\"}}",
                        disabled: saving,
                        oninput: move |e| primary.set(e.value()),
                    }
                }
            } else {
                field::Root { class: "field",
                    field::Label { r#for: "import-wif", "Private keys" }
                    textarea {
                        id: "import-wif",
                        class: "input mono",
                        rows: 3,
                        value: "{primary}",
                        placeholder: "K… / L… / 5… — one per line",
                        disabled: saving,
                        oninput: move |e| primary.set(e.value()),
                    }
                }
            }
            field::Root { class: "field",
                field::Label { r#for: "import-label", "Name (optional)" }
                input {
                    id: "import-label",
                    class: "input",
                    value: "{label}",
                    placeholder: kind.label(),
                    disabled: saving,
                    oninput: move |e| label.set(e.value()),
                }
            }
            p { class: "settings-row-desc",
                "Saved encrypted on this device. It never becomes your HandCash identity or signs in to apps, and nothing moves until you choose Import."
            }
            if scan_gated {
                status_banner::Root { tone: status_banner::StatusTone::Warning, status: Some("unavailable".to_string()),
                    status_banner::Copy {
                        status_banner::Title { "Legacy source sweeping is not enabled in this build yet" }
                        status_banner::Body { "BRC-39 / BRC-38 history merge is available in Settings → Import." }
                    }
                }
            }
            if let Some(err) = error {
                p { class: "error", role: "alert", "{err}" }
            }
            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: !ready || saving || scan_gated,
                    onclick: move |_| on_submit.call(submit_fields.clone()),
                    button::Label { if saving { "Saving…" } else { "Save and scan" } }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    disabled: saving,
                    onclick: move |_| on_back.call(()),
                    button::Label { "Back" }
                }
            }
        }
    }
}

/// Item entry shown in `ImportItemBrowser`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportBrowserItem {
    pub outpoint: String,
    pub name: String,
    pub shelf_label: String,
}

/// 1:1 port of `src/components/import/ImportItemBrowser.tsx`.
#[component]
pub fn ImportItemBrowser(
    source_label: String,
    items: Vec<ImportBrowserItem>,
    #[props(default = true)] sweep_gated: bool,
    on_back: EventHandler<()>,
) -> Element {
    let mut query = use_signal(String::new);
    let q = query.read().trim().to_ascii_lowercase();
    let filtered: Vec<ImportBrowserItem> = items
        .into_iter()
        .filter(|it| {
            q.is_empty()
                || it.name.to_ascii_lowercase().contains(&q)
                || it.shelf_label.to_ascii_lowercase().contains(&q)
                || it.outpoint.to_ascii_lowercase().contains(&q)
        })
        .collect();
    rsx! {
        div {
            class: "nav-child-panel import-item-browser",
            "data-aeon-scope": "import-item-browser",
            "data-aeon-state": if sweep_gated { "unavailable" } else { "ready" },
            div { class: "connected-panel-head",
                h3 { "{source_label}" }
                span { class: "settings-row-desc", "{filtered.len()} items" }
            }
            div { class: "root-search friends-search", role: "search",
                SearchField {
                    id: "import-item-search".to_string(),
                    label: "Search items".to_string(),
                    placeholder: Some("Name, app or id".to_string()),
                    value: query.read().clone(),
                    on_value_change: move |next| query.set(next),
                }
            }
            if filtered.is_empty() {
                div { class: "friends-empty",
                    strong { if q.is_empty() { "No items left." } else { "No items found" } }
                    if !q.is_empty() {
                        span { "Try another name, app, or id." }
                    }
                }
            } else {
                ul { class: "connected-app-list", "data-aeon-part": "items",
                    for item in filtered {
                        li { key: "{item.outpoint}", class: "connected-app-row",
                            strong { "{item.name}" }
                            span { class: "settings-row-desc", "{item.shelf_label}" }
                        }
                    }
                }
            }
            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: sweep_gated,
                    button::Label { "Import selected" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| on_back.call(()),
                    button::Label { "Back" }
                }
            }
        }
    }
}

/// Summary of one saved legacy import source for `ImportSourceView`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedSourceView {
    pub id: String,
    pub kind: ImportSourceKind,
    pub label: String,
    pub cash_sats: u64,
    pub item_count: usize,
    pub scan_complete: bool,
}

/// 1:1 port of `src/components/import/ImportSourceView.tsx`.
#[component]
pub fn ImportSourceView(
    source: ImportedSourceView,
    #[props(default = true)] sweep_gated: bool,
    on_open_items: EventHandler<()>,
    on_back: EventHandler<()>,
) -> Element {
    rsx! {
        div {
            class: "nav-child-panel import-source-view",
            "data-aeon-scope": "import-source",
            "data-aeon-state": if sweep_gated { "unavailable" } else { "viewing" },
            header { class: "import-source-head", "data-aeon-part": "head",
                ImportSourceIcon { kind: source.kind, size: "lg".to_string() }
                div {
                    h3 { "{source.label}" }
                    p { class: "settings-row-desc", "{source.kind.label()}" }
                }
            }
            dl { class: "wallet-details",
                div { class: "wallet-detail",
                    span { "Coins" }
                    span { class: "wallet-detail-value mono", "{source.cash_sats} sats" }
                }
                div { class: "wallet-detail",
                    span { "Items" }
                    span { class: "wallet-detail-value", "{source.item_count}" }
                }
            }
            if sweep_gated {
                status_banner::Root { tone: status_banner::StatusTone::Warning, status: Some("unavailable".to_string()),
                    status_banner::Copy {
                        status_banner::Title { "Legacy sweep is not enabled in this build yet" }
                        status_banner::Body { "Coins and items remain untouched on the source keys." }
                    }
                }
            }
            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: sweep_gated || source.cash_sats == 0,
                    button::Label { "Import coins" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    disabled: source.item_count == 0,
                    onclick: move |_| on_open_items.call(()),
                    button::Label { "Browse items" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| on_back.call(()),
                    button::Label { "Back" }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/import/ImportPanel.tsx`.
#[component]
pub fn ImportPanel() -> Element {
    let mut picked_kind = use_signal(|| Option::<ImportSourceKind>::None);
    let mut selected_source = use_signal(|| Option::<ImportedSourceView>::None);
    let mut browsing_items = use_signal(|| false);

    if let Some(kind) = *picked_kind.read() {
        return rsx! {
            div { class: "nav-child-panel", "data-aeon-scope": "legacy-import", "data-aeon-state": "entering",
                ImportSecretForm {
                    kind,
                    on_submit: move |_| {},
                    on_back: move |_| picked_kind.set(None),
                }
            }
        };
    }

    if let Some(src) = selected_source.read().clone() {
        if *browsing_items.read() {
            return rsx! {
                ImportItemBrowser {
                    source_label: src.label,
                    items: Vec::new(),
                    on_back: move |_| browsing_items.set(false),
                }
            };
        }
        return rsx! {
            ImportSourceView {
                source: src,
                on_open_items: move |_| browsing_items.set(true),
                on_back: move |_| selected_source.set(None),
            }
        };
    }

    rsx! {
        div { class: "nav-child-panel", "data-aeon-scope": "legacy-import", "data-aeon-state": "picking",
            SettingsSection { title: "From a wallet".to_string(), part: Some("kinds".to_string()),
                ul { class: "settings-list",
                    for kind in [ImportSourceKind::HandCash, ImportSourceKind::Twetch, ImportSourceKind::Yours] {
                        li { key: "{kind.as_str()}",
                            button {
                                r#type: "button",
                                class: "settings-row",
                                onclick: move |_| picked_kind.set(Some(kind)),
                                ImportSourceIcon { kind }
                                div { class: "settings-row-copy",
                                    strong { "{kind.label()}" }
                                    span { class: "settings-row-desc", "{kind.hint()}" }
                                }
                            }
                        }
                    }
                }
            }
            SettingsSection { title: "From a phrase or key".to_string(), part: Some("kinds".to_string()),
                ul { class: "settings-list",
                    for kind in [ImportSourceKind::Phrase, ImportSourceKind::Wif] {
                        li { key: "{kind.as_str()}",
                            button {
                                r#type: "button",
                                class: "settings-row",
                                onclick: move |_| picked_kind.set(Some(kind)),
                                ImportSourceIcon { kind }
                                div { class: "settings-row-copy",
                                    strong { "{kind.label()}" }
                                    span { class: "settings-row-desc", "{kind.hint()}" }
                                }
                            }
                        }
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
    fn handcash_import_requires_two_keys_or_combined_export() {
        let one = SecretFields { primary: "xprv111".into(), ..Default::default() };
        assert!(!secret_fields_ready(ImportSourceKind::HandCash, &one));
        let combined = SecretFields { primary: "xprv111\nxprv222".into(), ..Default::default() };
        assert!(secret_fields_ready(ImportSourceKind::HandCash, &combined));
        let split = SecretFields { primary: "xprv111".into(), secondary: "xprv222".into(), ..Default::default() };
        assert!(secret_fields_ready(ImportSourceKind::HandCash, &split));
        assert!(secret_fields_ready(ImportSourceKind::Phrase, &one));
    }
}
