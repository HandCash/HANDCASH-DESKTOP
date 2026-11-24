// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop Friends, Contacts & Peer Messages surfaces:
//! - `src/components/FriendsPanel.tsx`
//! - `src/components/AddFriendPanel.tsx`
//! - `src/components/FriendDetailsPanel.tsx`
//! - `src/components/MessagesPanel.tsx`

use crate::icons::{CopyIcon, MessagesIcon, PersonAddIcon};
use crate::machines::{classify_recipient, CollectionView, NavChild, ToastNotice};
use crate::state::{
    copy_to_clipboard, truncate_mid, AppServices, FriendRecord,
};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use crate::ui::collectables::CollectionViewToggle;
use crate::ui::primitives::{PeerAvatar, ProfileFingerprint};
use crate::ui::EmptyState;
use aeon_ui::button;
use dioxus::prelude::*;
use std::sync::Arc;

/// 1:1 port of `src/components/FriendsPanel.tsx`.
#[component]
pub fn FriendsPanel(
    #[props(default = "main".to_string())] chain: String,
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

            div { class: "connected-panel-head friends-panel-head",
                h2 {
                    "Friends"
                    span {
                        class: "friends-count",
                        aria_label: "{friends.len()} friends",
                        "{friends.len()}"
                    }
                }
                crate::ui::primitives::TitlebarActions {
                    section: crate::machines::NavSection::Friends,
                    class: "friends-panel-head-actions panel-icon-toolbar",
                    if !friends.is_empty() {
                        crate::ui::primitives::PanelFilter {
                            id: "friends-search-input".to_string(),
                            label: "Search friends by name or wallet key".to_string(),
                            placeholder: "Name or wallet key".to_string(),
                            value: query.read().clone(),
                            on_value_change: move |next| query.set(next),
                            shown: filtered.len(),
                            total: friends.len(),
                        }
                    }
                    button {
                        r#type: "button",
                        class: "wallet-nav-chrome-btn",
                        aria_label: "Open messages",
                        title: "Messages",
                        onclick: move |_| nav_child.set(Some(NavChild::Messages(None))),
                        MessagesIcon { size: 16 }
                    }
                    button {
                        r#type: "button",
                        class: "wallet-nav-chrome-btn",
                        aria_label: "Add friend",
                        title: "Add friend",
                        onclick: move |_| nav_child.set(Some(NavChild::AddFriend)),
                        PersonAddIcon { size: 16 }
                    }
                    CollectionViewToggle { view }
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
                                    let peer_prof = services.peer_identity_for(&chain, &friend.identity_key);
                                    let img_url = peer_prof.as_ref().and_then(|p| p.image_data_url.clone());
                                    rsx! {
                                        li { key: "{friend.id}", class: "collection-grid-card friend-grid-card",
                                            button {
                                                r#type: "button",
                                                class: "collection-grid-main",
                                                onclick: move |_| nav_child.set(Some(NavChild::FriendDetails(fid.clone()))),
                                                PeerAvatar {
                                                    label: friend.label.clone(),
                                                    class: "friend-avatar friend-avatar-lg",
                                                    image_url: img_url,
                                                }
                                                strong { class: "collection-grid-name", "{friend.label}" }
                                                if let Some(ref prof) = peer_prof {
                                                    span { class: "collection-grid-host friend-key",
                                                        "{prof.name}"
                                                    }
                                                } else {
                                                    span {
                                                        class: "collection-grid-host friend-key mono",
                                                        title: "{friend.identity_key}",
                                                        "{truncate_mid(&friend.identity_key, 8)}"
                                                    }
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
                                    let peer_prof = services.peer_identity_for(&chain, &friend.identity_key);
                                    let img_url = peer_prof.as_ref().and_then(|p| p.image_data_url.clone());
                                    rsx! {
                                        li { key: "{friend.id}", class: "friend-row",
                                            button {
                                                r#type: "button",
                                                class: "friend-row-main",
                                                onclick: move |_| nav_child.set(Some(NavChild::FriendDetails(fid.clone()))),
                                                PeerAvatar {
                                                    label: friend.label.clone(),
                                                    image_url: img_url,
                                                }
                                                div { class: "friend-row-body",
                                                    strong { class: "friend-label", "{friend.label}" }
                                                    if let Some(ref prof) = peer_prof {
                                                        span { class: "friend-key",
                                                            "{prof.name}"
                                                        }
                                                    } else {
                                                        span {
                                                            class: "friend-key mono",
                                                            title: "{friend.identity_key}",
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

    let svc_form = Arc::clone(&services);
    let current_err = err_text.read().clone();
    let state_attr: &'static str = if current_err.is_some() { "failure" } else { "idle" };
    let on_form_submit = move |e: FormEvent| {
        e.prevent_default();
        if !can_submit {
            return;
        }
        err_text.set(None);
        let rec_val = recipient.read().clone();
        let lbl_val = label.read().clone();
        match svc_form.add_friend(&rec_val, Some(lbl_val.as_str())) {
            Ok(added) => {
                toast.set(Some(ToastNotice {
                    title: "Friend added".into(),
                    body: Some(added.label),
                    tone: "success",
                }));
                dock_spec.set(None);
                nav_child.set(None);
            }
            Err(err) => {
                err_text.set(Some(err.clone()));
                toast.set(Some(ToastNotice {
                    title: "Couldn't add friend".into(),
                    body: Some(err),
                    tone: "error",
                }));
            }
        }
    };
    rsx! {
        div { class: "nav-child-panel add-friend-panel", "data-aeon-scope": "add-friend",
            crate::ui::primitives::ExclusiveActionRegion {
                scope: "add-friend",
                part: "add-friend-form",
                state_attr,
                class: "friends-add-form",
                actions_class: "actions add-friend-actions".to_string(),
                error: current_err,
                idle_label: "Add friend".to_string(),
                pending_label: "Adding…".to_string(),
                primary_disabled: !can_submit,
                secondary_label: Some("Cancel".to_string()),
                on_secondary: move |_| {
                    dock_spec.set(None);
                    nav_child.set(None);
                },
                on_submit: on_form_submit,
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

                    aeon_ui::field::Root { class: "field",
                        aeon_ui::field::Label { r#for: "friend-key", "Handle or wallet key" }
                        input {
                            id: "friend-key",
                            class: "mono",
                            "data-aeon-part": "control",
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
                        aeon_ui::field::Root { class: "field",
                            aeon_ui::field::Label { r#for: "friend-label", "Label (optional)" }
                            input {
                                id: "friend-label",
                                "data-aeon-part": "control",
                                placeholder: "How you'll recognize this peer",
                                value: "{label}",
                                oninput: move |e| label.set(e.value()),
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/FriendDetailsPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn FriendDetailsPanel(
    friend_id: String,
    #[props(default = "main".to_string())] chain: String,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut rev = use_signal(|| 0u64);
    let _ = *rev.read();
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
            p { class: "connected-empty-line", "Friend not found" }
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

    let peer_prof = services.peer_identity_for(&chain, &friend.identity_key);
    let img_url = peer_prof.as_ref().and_then(|p| p.image_data_url.clone());
    let key_copy = friend.identity_key.clone();
    let friend_ik_import = friend.identity_key.clone();
    let chain_import = chain.clone();
    let svc_save = Arc::clone(&services);
    let svc_import = Arc::clone(&services);
    let fid_save = friend.id.clone();
    let fid_msg = friend.id.clone();

    rsx! {
        div { class: "nav-child-panel friend-details", "data-aeon-scope": "friend-details",
            section { class: "friend-details-overview", aria_labelledby: "friend-overview-name",
                PeerAvatar {
                    label: friend.label.clone(),
                    class: "friend-avatar friend-avatar-lg",
                    image_url: img_url,
                }
                div {
                    h3 { id: "friend-overview-name", "{friend.label}" }
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

            section {
                class: "friend-copy-row friend-identity-card",
                "data-aeon-part": "peer-identity-card",
                "data-aeon-state": "idle",
                aria_label: "Shared identity",
                div {
                    span { class: "field-static-label", "Shared identity" }
                    if let Some(ref prof) = peer_prof {
                        div { style: "display: flex; align-items: center; gap: 6px; margin-top: 4px;",
                            strong { "{prof.name}" }
                            ProfileFingerprint { id: prof.identity_key.clone() }
                        }
                        if !prof.description.is_empty() {
                            p { class: "friend-identity-bio", "{prof.description}" }
                        }
                    } else {
                        p { class: "friend-identity-bio",
                            "Not shared with you. A contact can send a signed identity card from their wallet."
                        }
                    }
                }
                div { class: "friend-identity-actions",
                    button {
                        r#type: "button",
                        class: "friend-copy-action",
                        onclick: move |_| {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("HandCash Identity Card (.json)", &["json"])
                                .pick_file()
                            {
                                match std::fs::read_to_string(&path)
                                    .map_err(|e| e.to_string())
                                    .and_then(|raw| svc_import.import_peer_identity_card_json(&chain_import, &friend_ik_import, &raw))
                                {
                                    Ok(name) => {
                                        let next = *rev.read() + 1;
                                        rev.set(next);
                                        toast.set(Some(ToastNotice {
                                            title: "Identity card verified".into(),
                                            body: Some(name),
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
                        "Import card"
                    }
                }
            }

            div { class: "friend-copy-row",
                div {
                    span { class: "field-static-label", "Wallet key" }
                    span {
                        class: "mono wallet-detail-value",
                        title: "{friend.identity_key}",
                        "{friend.identity_key}"
                    }
                }
                button {
                    r#type: "button",
                    class: "friend-copy-action",
                    aria_label: "Copy wallet key",
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
                    CopyIcon { size: 16 }
                    span { "Copy" }
                }
            }

            div { class: "actions friend-details-actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    onclick: move |_| {
                        dock_spec.set(None);
                        nav_child.set(Some(NavChild::Messages(Some(fid_msg.clone()))));
                    },
                    MessagesIcon { size: 16 }
                    button::Label { "Message" }
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

/// 1:1 port of `src/components/MessagesPanel.tsx`.
#[component]
pub fn MessagesPanel(
    #[props(default = "main".to_string())] chain: String,
    #[props(default)] initial_peer_id: Option<String>,
    mut nav_child: Signal<Option<NavChild>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let friends = services.list_friends();
    let default_peer = initial_peer_id.or_else(|| friends.first().map(|f| f.id.clone()));
    let mut active_peer_id = use_signal(move || default_peer);
    let mut query = use_signal(String::new);
    let mut draft = use_signal(String::new);
    let mut msg_rev = use_signal(|| 0u64);
    let _ = *msg_rev.read();

    let q = query.read().trim().to_ascii_lowercase();
    let filtered_friends: Vec<FriendRecord> = friends
        .iter()
        .filter(|f| {
            q.is_empty()
                || f.label.to_ascii_lowercase().contains(&q)
                || f.identity_key.to_ascii_lowercase().contains(&q)
        })
        .cloned()
        .collect();

    let mut unread_only = use_signal(|| false);
    let mut thread_section = use_signal(|| crate::ui::messages::ChatThreadSection::Messages);
    let cur_peer_id = active_peer_id.read().clone();
    let active_friend = cur_peer_id
        .as_ref()
        .and_then(|pid| friends.iter().find(|f| &f.id == pid).cloned());
    let raw_messages = cur_peer_id
        .as_ref()
        .map(|pid| services.list_chat_messages(pid))
        .unwrap_or_default();
    let visible_messages: Vec<crate::ui::messages::ChatMessageView> = raw_messages
        .iter()
        .filter(|m| match *thread_section.read() {
            crate::ui::messages::ChatThreadSection::Messages => true,
            crate::ui::messages::ChatThreadSection::Files => false,
            crate::ui::messages::ChatThreadSection::Payments => m.text.starts_with("/pay") || m.text.starts_with("/tip"),
        })
        .map(|m| crate::ui::messages::ChatMessageView {
            id: m.id.clone(),
            direction: m.direction.clone(),
            kind: "text".to_string(),
            text: m.text.clone(),
            created_at: m.at,
            amount_label: None,
            sats_line: None,
            pay_status: None,
            memo: None,
            bound_message_id: None,
            attachment: None,
        })
        .collect();
    let sidebar_peers: Vec<crate::ui::messages::ChatPeerView> = filtered_friends
        .iter()
        .map(|f| {
            let peer_prof = services.peer_identity_for(&chain, &f.identity_key);
            let thread_msgs = services.list_chat_messages(&f.id);
            let last = thread_msgs.last();
            crate::ui::messages::ChatPeerView {
                peer_id: f.id.clone(),
                label: f.label.clone(),
                identity_key: f.identity_key.clone(),
                image_url: peer_prof.and_then(|p| p.image_data_url),
                last_preview: last.map(|m| m.text.clone()).unwrap_or_default(),
                updated_at: last.map(|m| m.at),
                unread: 0,
            }
        })
        .filter(|p| !*unread_only.read() || p.unread > 0)
        .collect();
    let svc_send = Arc::clone(&services);

    rsx! {
        div {
            class: "chat-shell chat-shell--nested",
            "data-aeon-scope": "messages",
            "data-aeon-state": if active_friend.is_some() { "thread" } else { "empty" },

            crate::ui::messages::ChatSidebar {
                nested_in_nav: true,
                total_peers: friends.len(),
                filtered_peers: sidebar_peers,
                active_peer_id: cur_peer_id,
                query: query.read().clone(),
                on_query_change: move |next| query.set(next),
                unread_only: *unread_only.read(),
                on_unread_only_change: move |next| unread_only.set(next),
                on_select_peer: move |pid| active_peer_id.set(Some(pid)),
                on_add_friend: move |_| nav_child.set(Some(NavChild::AddFriend)),
            }

            section { class: "chat-thread",
                if let Some(ref friend) = active_friend {
                    {
                        let fid_send = friend.id.clone();
                        let fik_pay = friend.identity_key.clone();
                        let peer_prof = services.peer_identity_for(&chain, &friend.identity_key);
                        let img_url = peer_prof.as_ref().and_then(|p| p.image_data_url.clone());
                        let cur_sec = *thread_section.read();
                        rsx! {
                            crate::ui::messages::ChatThreadHeader {
                                friend: friend.clone(),
                                image_url: img_url.clone(),
                                on_pay: move |_| nav_child.set(Some(NavChild::Send(Some(fik_pay.clone())))),
                            }
                            crate::ui::messages::ChatThreadTabs {
                                section: cur_sec,
                                on_section_change: move |sec| thread_section.set(sec),
                            }
                            crate::ui::messages::ChatThreadList {
                                section: cur_sec,
                                visible_messages,
                                peer_label: friend.label.clone(),
                                peer_image_url: img_url,
                            }
                            crate::ui::messages::ChatComposer {
                                draft: draft.read().clone(),
                                peer_label: friend.label.clone(),
                                can_attach: false,
                                on_draft_change: move |next| draft.set(next),
                                on_submit: move |_| {
                                    let text = draft.read().clone();
                                    if text.trim().is_empty() {
                                        return;
                                    }
                                    match svc_send.send_chat_message(&fid_send, &text) {
                                        Ok(_) => {
                                            draft.set(String::new());
                                            let next = *msg_rev.read() + 1;
                                            msg_rev.set(next);
                                        }
                                        Err(err) => toast.set(Some(ToastNotice {
                                            title: "Send failed".into(),
                                            body: Some(err),
                                            tone: "error",
                                        })),
                                    }
                                },
                            }
                        }
                    }
                } else {
                    div { class: "chat-placeholder",
                        EmptyState {
                            title: "Messages",
                            body: Some("Pick a friend to open a thread.".into()),
                            action: Some(rsx! {
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    onclick: move |_| nav_child.set(Some(NavChild::AddFriend)),
                                    button::Label { "Add friend" }
                                }
                            }),
                        }
                    }
                }
            }
        }
    }
}
