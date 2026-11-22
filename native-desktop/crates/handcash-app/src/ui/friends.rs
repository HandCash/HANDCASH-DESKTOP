// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop Friends & Contacts surfaces:
//! - `src/components/FriendsPanel.tsx`
//! - `src/components/AddFriendPanel.tsx`
//! - `src/components/FriendDetailsPanel.tsx`

use crate::icons::{CopyIcon, FriendsIcon, PersonAddIcon};
use crate::machines::{classify_recipient, CollectionView, NavChild, ToastNotice};
use crate::state::{copy_to_clipboard, truncate_mid, AppServices, FriendRecord};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use crate::ui::EmptyState;
use aeon_ui::button;
use dioxus::prelude::*;
use std::sync::Arc;

/// 1:1 port of `src/components/FriendsPanel.tsx`.
#[component]
pub fn FriendsPanel(
    view: Signal<CollectionView>,
    mut nav_child: Signal<Option<NavChild>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut query = use_signal(String::new);

    let friends = services.list_friends();
    let q = query.read().trim().to_ascii_lowercase();
    let cur_view = *view.read();
    let filtered: Vec<FriendRecord> = friends
        .iter()
        .filter(|f| {
            q.is_empty()
                || f.label.to_ascii_lowercase().contains(&q)
                || f.identity_key.to_ascii_lowercase().contains(&q)
                || f.handle
                    .as_deref()
                    .map(|h| h.to_ascii_lowercase().contains(&q))
                    .unwrap_or(false)
        })
        .cloned()
        .collect();

    rsx! {
        div {
            class: "nav-section-body nav-section-with-scroll",
            "data-aeon-scope": "friends",
            "data-aeon-state": cur_view.as_str(),

            if !friends.is_empty() {
                div { class: "field", style: "margin-bottom: 10px;",
                    input {
                        placeholder: "Search friends by name or wallet key…",
                        value: "{query}",
                        oninput: move |e| query.set(e.value()),
                    }
                }
            }

            if friends.is_empty() {
                EmptyState {
                    icon: Some(rsx! { PersonAddIcon { size: 28 } }),
                    title: "No friends yet",
                    body: Some("Add someone by $handle or wallet key.".into()),
                    action: Some(rsx! {
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            onclick: move |_| nav_child.set(Some(NavChild::AddFriend)),
                            button::Label { "Add friend" }
                        }
                    }),
                }
            } else if filtered.is_empty() {
                div { class: "friends-empty",
                    strong { "No friends found" }
                    span { "Try another name or wallet key." }
                }
            } else {
                div { class: "nav-section-scroll-body",
                    if cur_view == CollectionView::Grid {
                        ul { class: "collection-grid friends-grid",
                            for friend in filtered.iter() {
                                {
                                    let fid = friend.id.clone();
                                    rsx! {
                                        li { key: "{friend.id}", class: "collection-grid-card friend-grid-card",
                                            button {
                                                r#type: "button",
                                                class: "collection-grid-main",
                                                onclick: move |_| nav_child.set(Some(NavChild::FriendDetails(fid.clone()))),
                                                span { class: "friend-avatar friend-avatar-lg",
                                                    FriendsIcon { size: 22 }
                                                }
                                                strong { class: "collection-grid-name", "{friend.label}" }
                                                span { class: "collection-grid-host friend-key mono",
                                                    "{truncate_mid(&friend.identity_key, 8)}"
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        ul { class: "friends-list",
                            for friend in filtered.iter() {
                                {
                                    let fid = friend.id.clone();
                                    rsx! {
                                        li { key: "{friend.id}", class: "friend-row",
                                            button {
                                                r#type: "button",
                                                class: "friend-row-main",
                                                onclick: move |_| nav_child.set(Some(NavChild::FriendDetails(fid.clone()))),
                                                span { class: "friend-avatar",
                                                    FriendsIcon { size: 18 }
                                                }
                                                div { class: "friend-row-body",
                                                    strong { class: "friend-label", "{friend.label}" }
                                                    span { class: "friend-key mono",
                                                        "{truncate_mid(&friend.identity_key, 12)}"
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
}

/// 1:1 port of `src/components/AddFriendPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn AddFriendPanel(
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut recipient = use_signal(String::new);
    let mut label = use_signal(String::new);
    let mut err_text = use_signal(|| Option::<String>::None);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let raw_recipient = recipient.read().clone();
    let trimmed = raw_recipient.trim();
    let parsed = classify_recipient(trimmed);
    let is_handle = trimmed.starts_with('$');
    let can_submit = parsed.is_some();

    let desired_dock = DockSpec {
        aria_label: "Add friend actions",
        secondary: Some(DockActionSpec::new(
            "cancel",
            "Cancel",
            ActionTone::Danger,
            ActionIcon::Close,
        )),
        primary: DockActionSpec::new(
            "add-friend",
            "Add friend",
            ActionTone::Primary,
            ActionIcon::PersonAdd,
        )
        .disabled(!can_submit),
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let svc_add = Arc::clone(&services);
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "cancel" => {
                    dock_spec.set(None);
                    nav_child.set(None);
                }
                "add-friend" => {
                    err_text.set(None);
                    let rec_val = recipient.read().clone();
                    let lbl_val = label.read().clone();
                    match svc_add.add_friend(&rec_val, Some(&lbl_val)) {
                        Ok(added) => {
                            toast.set(Some(ToastNotice {
                                title: "Friend added".into(),
                                body: Some(added.label),
                                tone: "success",
                            }));
                            dock_spec.set(None);
                            nav_child.set(None);
                        }
                        Err(e) => {
                            err_text.set(Some(e.clone()));
                            toast.set(Some(ToastNotice {
                                title: "Couldn't add friend".into(),
                                body: Some(e),
                                tone: "error",
                            }));
                        }
                    }
                }
                _ => {}
            }
        });
    }

    rsx! {
        div { class: "nav-child-panel add-friend-panel", "data-aeon-scope": "add-friend",
            div { class: "add-friend-content",
                header { class: "add-friend-intro",
                    span { class: "add-friend-intro-icon", aria_hidden: true,
                        PersonAddIcon { size: 20 }
                    }
                    div {
                        h3 { "Add someone you trust" }
                        p { "Use their $handle, peer payment link, or wallet key." }
                    }
                }

                div { class: "field",
                    label { r#for: "friend-key", "Handle or wallet key" }
                    input {
                        id: "friend-key",
                        class: "mono",
                        placeholder: "$alice, peerpay:…, or 02… / 03…",
                        value: "{raw_recipient}",
                        oninput: move |e| {
                            err_text.set(None);
                            recipient.set(e.value());
                        },
                    }
                    if !trimmed.is_empty() && parsed.is_none() {
                        p { class: "error", role: "alert",
                            "Enter a valid $handle, peerpay: URI, or 66-hex wallet key."
                        }
                    }
                }

                if !trimmed.is_empty() && !is_handle {
                    div { class: "field",
                        label { r#for: "friend-label", "Label (optional)" }
                        input {
                            id: "friend-label",
                            placeholder: "How you'll recognize this peer",
                            value: "{label}",
                            oninput: move |e| label.set(e.value()),
                        }
                    }
                }

                if let Some(ref e) = *err_text.read() {
                    p { class: "error", role: "alert", "{e}" }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/FriendDetailsPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn FriendDetailsPanel(
    friend_id: String,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let friend_opt = services
        .list_friends()
        .into_iter()
        .find(|f| f.id == friend_id);
    let initial_label = friend_opt
        .as_ref()
        .map(|f| f.label.clone())
        .unwrap_or_default();
    let mut edit_label = use_signal(move || initial_label);
    let mut confirming_remove = use_signal(|| false);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let Some(friend) = friend_opt else {
        if dock_spec.read().is_some() {
            dock_spec.set(None);
        }
        return rsx! {
            div { class: "nav-child-panel friend-details", "data-aeon-scope": "friend-details",
                p { class: "connected-empty-line", "Friend not found" }
            }
        };
    };

    let handle_fixed = friend.handle.is_some();
    let is_confirming_remove = *confirming_remove.read();
    let desired_dock = if is_confirming_remove {
        DockSpec {
            aria_label: "Confirm remove friend",
            secondary: Some(DockActionSpec::new(
                "cancel-remove",
                "Cancel",
                ActionTone::Secondary,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "confirm-remove",
                "Remove",
                ActionTone::Danger,
                ActionIcon::Close,
            ),
        }
    } else {
        DockSpec {
            aria_label: "Friend actions",
            secondary: Some(DockActionSpec::new(
                "ask-remove",
                "Remove",
                ActionTone::Danger,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "send-to-friend",
                "Send BSV",
                ActionTone::Primary,
                ActionIcon::Send,
            ),
        }
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let svc_act = Arc::clone(&services);
        let fid_remove = friend.id.clone();
        let target_send = friend.identity_key.clone();
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "ask-remove" => confirming_remove.set(true),
                "cancel-remove" => confirming_remove.set(false),
                "confirm-remove" => match svc_act.remove_friend(&fid_remove) {
                    Ok(()) => {
                        toast.set(Some(ToastNotice {
                            title: "Friend removed".into(),
                            body: None,
                            tone: "success",
                        }));
                        dock_spec.set(None);
                        nav_child.set(None);
                    }
                    Err(e) => toast.set(Some(ToastNotice {
                        title: "Remove failed".into(),
                        body: Some(e),
                        tone: "error",
                    })),
                },
                "send-to-friend" => {
                    dock_spec.set(None);
                    nav_child.set(Some(NavChild::Send(Some(target_send.clone()))));
                }
                _ => {}
            }
        });
    }

    let key_copy = friend.identity_key.clone();
    let svc_save = Arc::clone(&services);
    let fid_save = friend.id.clone();

    rsx! {
        div { class: "nav-child-panel friend-details", "data-aeon-scope": "friend-details",
            section { class: "friend-details-overview",
                span { class: "friend-avatar friend-avatar-lg",
                    FriendsIcon { size: 22 }
                }
                div {
                    h3 { "{friend.label}" }
                    if handle_fixed {
                        p { class: "history-when", "Handle contact" }
                    }
                }
            }

            if !handle_fixed {
                div { class: "field",
                    label { r#for: "friend-edit-label", "Contact name" }
                    div { style: "display: flex; gap: 8px;",
                        input {
                            id: "friend-edit-label",
                            value: "{edit_label}",
                            oninput: move |e| edit_label.set(e.value()),
                        }
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            onclick: move |_| {
                                let next_lbl = edit_label.read().clone();
                                match svc_save.update_friend_label(&fid_save, &next_lbl) {
                                    Ok(updated) => toast.set(Some(ToastNotice {
                                        title: "Friend saved".into(),
                                        body: Some(updated.label),
                                        tone: "success",
                                    })),
                                    Err(e) => toast.set(Some(ToastNotice {
                                        title: "Save failed".into(),
                                        body: Some(e),
                                        tone: "error",
                                    })),
                                }
                            },
                            button::Label { "Save" }
                        }
                    }
                }
            }

            div { class: "friend-copy-row",
                div {
                    span { class: "field-static-label", "Wallet key" }
                    p { class: "mono", "{truncate_mid(&friend.identity_key, 16)}" }
                }
                button {
                    r#type: "button",
                    class: "friend-copy-action",
                    onclick: move |_| match copy_to_clipboard(&key_copy) {
                        Ok(()) => toast.set(Some(ToastNotice {
                            title: "Copied".into(),
                            body: Some("Wallet key copied.".into()),
                            tone: "success",
                        })),
                        Err(e) => toast.set(Some(ToastNotice {
                            title: "Copy failed".into(),
                            body: Some(e),
                            tone: "error",
                        })),
                    },
                    CopyIcon { size: 14 }
                    span { "Copy" }
                }
            }

            if is_confirming_remove {
                p { class: "error", role: "alert",
                    "Remove {friend.label} from your friends list? Confirm in the action bar above."
                }
            }
        }
    }
}
