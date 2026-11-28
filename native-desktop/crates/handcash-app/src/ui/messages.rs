// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop peer-to-peer messaging components:
//! - `src/components/messages/ChatSidebar.tsx`
//! - `src/components/messages/ChatThread.tsx`
//! - `src/components/messages/MessageBubble.tsx`
//! - `src/components/messages/ChatComposer.tsx`

use crate::icons::{
    AttachFileIcon, FileIcon, PayIcon, PersonAddIcon, PhoneIcon, RequestMoneyIcon, SendIcon,
};
use crate::state::{format_relative_time, now_ms, FriendRecord};
use crate::ui::primitives::{PeerAvatar, SearchField};
use crate::ui::EmptyState;
use aeon_ui::button;
use dioxus::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatPeerView {
    pub peer_id: String,
    pub label: String,
    pub identity_key: String,
    pub image_url: Option<String>,
    pub last_preview: String,
    pub updated_at: Option<i64>,
    pub unread: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatThreadSection {
    Messages,
    Files,
    Payments,
}

impl ChatThreadSection {
    pub const ALL: [(Self, &'static str); 3] = [
        (Self::Messages, "Messages"),
        (Self::Files, "Files"),
        (Self::Payments, "Payments"),
    ];

    pub const fn empty_copy(self) -> (&'static str, &'static str) {
        match self {
            Self::Messages => (
                "No messages yet",
                "Messages are stored locally and delivered over BRC-33 messagebox when connected.",
            ),
            Self::Files => (
                "No files shared",
                "Files exchanged in this conversation appear here.",
            ),
            Self::Payments => (
                "No payments yet",
                "Tips, payments, and requests with this friend appear here.",
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatAttachmentView {
    pub name: String,
    pub url: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatMessageView {
    pub id: String,
    pub direction: String,
    pub kind: String,
    pub text: String,
    pub created_at: i64,
    pub amount_label: Option<String>,
    pub sats_line: Option<String>,
    pub pay_status: Option<String>,
    pub memo: Option<String>,
    pub bound_message_id: Option<String>,
    pub attachment: Option<ChatAttachmentView>,
}

pub fn unread_badge_label(count: usize) -> String {
    if count > 99 {
        "99+".to_string()
    } else {
        count.to_string()
    }
}

pub fn format_file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

pub const CHAT_COMMANDS: [(&str, &str); 3] = [
    ("pay", "Send BSV in chat"),
    ("tip", "Send a quick tip"),
    ("request", "Request payment"),
];

/// 1:1 port of `src/components/messages/ChatSidebar.tsx`.
#[component]
pub fn ChatSidebar(
    nested_in_nav: bool,
    total_peers: usize,
    filtered_peers: Vec<ChatPeerView>,
    active_peer_id: Option<String>,
    query: String,
    on_query_change: EventHandler<String>,
    unread_only: bool,
    on_unread_only_change: EventHandler<bool>,
    on_select_peer: EventHandler<String>,
    on_add_friend: EventHandler<()>,
) -> Element {
    let now = now_ms();
    let tools = rsx! {
        label { class: "chat-unread-toggle", title: "Unread only",
            input {
                r#type: "checkbox",
                checked: unread_only,
                onchange: move |e| on_unread_only_change.call(e.checked()),
            }
            span { "Unread" }
        }
        button::Root {
            variant: button::ButtonVariant::Ghost,
            class: "btn btn-ghost btn-icon",
            title: "Add friend",
            aria_label: "Add friend",
            onclick: move |_| on_add_friend.call(()),
            PersonAddIcon { size: 18 }
        }
    };

    rsx! {
        aside { class: "chat-sidebar",
            if !nested_in_nav {
                div { class: "chat-sidebar-head panel-label-bar",
                    h2 { "Messages" }
                    div { class: "chat-sidebar-tools", {tools} }
                }
            } else {
                div { class: "chat-sidebar-toolbar panel-label-bar", {tools} }
            }
            div { class: "root-search chat-search", role: "search",
                SearchField {
                    id: "chat-search-input".to_string(),
                    label: "Search conversations".to_string(),
                    placeholder: Some("Name or message".to_string()),
                    value: query,
                    on_value_change: move |next| on_query_change.call(next),
                }
            }
            ul { class: "chat-peer-list",
                if filtered_peers.is_empty() {
                    li { class: "chat-empty",
                        if total_peers == 0 {
                            "No chats yet — add a friend"
                        } else {
                            "No matches"
                        }
                    }
                } else {
                    for peer in filtered_peers {
                        {
                            let pid = peer.peer_id.clone();
                            let selected = active_peer_id.as_deref() == Some(peer.peer_id.as_str());
                            let preview = if peer.last_preview.is_empty() {
                                " ".to_string()
                            } else {
                                peer.last_preview.clone()
                            };
                            let when = peer.updated_at.map(|ts| format_relative_time(ts, now));
                            let unread = peer.unread;
                            rsx! {
                                li { key: "{peer.peer_id}",
                                    button {
                                        r#type: "button",
                                        class: "chat-peer-row",
                                        "data-selected": if selected { Some("") } else { None },
                                        onclick: move |_| on_select_peer.call(pid.clone()),
                                        PeerAvatar {
                                            label: peer.label.clone(),
                                            image_url: peer.image_url.clone(),
                                        }
                                        span { class: "chat-peer-body",
                                            span { class: "chat-peer-top",
                                                strong { class: "chat-peer-name", "{peer.label}" }
                                                if let Some(ref w) = when {
                                                    span { class: "chat-peer-when", "{w}" }
                                                }
                                            }
                                            span { class: "chat-peer-preview", "{preview}" }
                                        }
                                        if unread > 0 {
                                            span {
                                                class: "chat-unread-badge",
                                                aria_label: "{unread} unread",
                                                "{unread_badge_label(unread)}"
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

/// 1:1 port of `ChatThreadHeader` in `src/components/messages/ChatThread.tsx`.
#[component]
pub fn ChatThreadHeader(
    friend: FriendRecord,
    #[props(default)] image_url: Option<String>,
    #[props(default)] on_back: Option<EventHandler<()>>,
    #[props(default)] on_pay: Option<EventHandler<()>>,
    #[props(default)] on_call: Option<EventHandler<()>>,
) -> Element {
    let call_label = format!("Call {}", friend.label);
    let call_peer_id = friend.identity_key.clone();
    let call_peer_label = friend.label.clone();
    rsx! {
        header { class: "chat-thread-head panel-label-bar",
            if let Some(back_cb) = on_back {
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "chat-back-btn btn btn-ghost btn-icon",
                    aria_label: "Back to conversations",
                    onclick: move |_| back_cb.call(()),
                    button::Label { "←" }
                }
            }
            button::Root {
                variant: button::ButtonVariant::Ghost,
                class: "chat-call-btn btn btn-ghost",
                aria_label: call_label.clone(),
                title: call_label,
                "data-aeon-state": "ready",
                onclick: move |_| {
                    if let Some(cb) = on_call {
                        cb.call(());
                    } else {
                        let _ = crate::p2p_chat_calls::start_outgoing_call(&call_peer_id, &call_peer_label);
                    }
                },
                PhoneIcon { size: 16 }
                button::Label { "Call" }
            }
            div { class: "chat-thread-identity", style: "display: flex; align-items: center; gap: 10px;",
                PeerAvatar {
                    label: friend.label.clone(),
                    image_url,
                }
                div { class: "chat-thread-titles",
                    strong { "{friend.label}" }
                    span { class: "chat-thread-sub", "1:1 · Message · Tip · Pay · Files" }
                }
            }
            if let Some(pay_cb) = on_pay {
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| pay_cb.call(()),
                    SendIcon { size: 15 }
                    button::Label { "Pay" }
                }
            }
        }
    }
}

/// 1:1 port of `ChatThreadTabs` in `src/components/messages/ChatThread.tsx`.
#[component]
pub fn ChatThreadTabs(
    section: ChatThreadSection,
    on_section_change: EventHandler<ChatThreadSection>,
) -> Element {
    rsx! {
        nav { class: "chat-thread-tabs panel-label-bar", aria_label: "Thread sections",
            for (sec, label) in ChatThreadSection::ALL {
                button {
                    key: "{label}",
                    r#type: "button",
                    class: "chat-thread-tab",
                    "data-active": if section == sec { Some("") } else { None },
                    aria_current: if section == sec { Some("page") } else { None },
                    onclick: move |_| on_section_change.call(sec),
                    "{label}"
                }
            }
        }
    }
}

/// 1:1 port of `src/components/messages/MessageBubble.tsx`.
#[component]
pub fn MessageBubble(
    msg: ChatMessageView,
    peer_label: String,
    #[props(default)] peer_image_url: Option<String>,
    #[props(default)] on_confirm_pay: Option<EventHandler<String>>,
    #[props(default)] on_cancel_pay: Option<EventHandler<String>>,
    #[props(default)] on_bind_reply: Option<EventHandler<String>>,
) -> Element {
    let now = now_ms();
    let when = format_relative_time(msg.created_at, now);
    if msg.kind == "system" {
        return rsx! {
            div {
                class: "chat-system",
                role: "status",
                "data-aeon-scope": "thread",
                "data-aeon-part": "item",
                "data-aeon-state": "command-result",
                div { "data-aeon-part": "command-result",
                    pre { "{msg.text}" }
                }
            }
        };
    }
    let mine = msg.direction == "out";
    let item_cls = if mine { "chat-msg is-mine" } else { "chat-msg" };
    let is_card = matches!(msg.kind.as_str(), "pay-sent" | "tip" | "pay-request");
    let msg_id_confirm = msg.id.clone();
    let msg_id_cancel = msg.id.clone();
    let msg_id_reply = msg.id.clone();

    rsx! {
        div {
            class: "{item_cls}",
            "data-aeon-scope": "thread",
            "data-aeon-part": "item",
            "data-aeon-state": if mine { "outgoing" } else { "incoming" },
            if !mine {
                PeerAvatar { label: peer_label.clone(), image_url: peer_image_url }
            }
            div { class: "chat-msg-stack",
                if !mine {
                    div { class: "chat-msg-meta",
                        button { r#type: "button", class: "chat-msg-name", "{peer_label}" }
                        span { class: "chat-msg-origin", "HandCash" }
                        time { "{when}" }
                    }
                }
                if is_card {
                    div {
                        class: if mine { "chat-bubble is-card is-mine" } else { "chat-bubble is-card" },
                        "data-kind": "{msg.kind}",
                        "data-pay-status": msg.pay_status.clone(),
                        div { class: "chat-card-head",
                            span { class: "chat-card-badge",
                                if msg.kind == "pay-request" {
                                    "Request"
                                } else if msg.kind == "tip" {
                                    if mine { "Tip sent" } else { "Tip received" }
                                } else if mine {
                                    "Payment sent"
                                } else {
                                    "Payment received"
                                }
                            }
                            if let Some(ref st) = msg.pay_status {
                                span { class: "chat-card-status", "data-status": "{st}", "{st}" }
                            }
                        }
                        div { class: "chat-value-body",
                            span { class: "chat-value-mark", aria_hidden: true, PayIcon { size: 20 } }
                            div {
                                if let Some(ref amt) = msg.amount_label {
                                    p { class: "chat-card-amount", "{amt}" }
                                }
                                if let Some(ref sats) = msg.sats_line {
                                    p { class: "chat-card-sats", "{sats}" }
                                }
                                if let Some(ref memo) = msg.memo {
                                    p { class: "chat-card-memo", "{memo}" }
                                }
                                if let Some(ref bound) = msg.bound_message_id {
                                    p { class: "chat-card-memo", "Bound to {bound}" }
                                }
                            }
                        }
                        if msg.pay_status.as_deref() == Some("pending") {
                            div { class: "chat-card-actions",
                                button {
                                    r#type: "button",
                                    class: "chat-card-btn chat-card-btn-ghost",
                                    onclick: move |_| {
                                        if let Some(cb) = on_cancel_pay {
                                            cb.call(msg_id_cancel.clone());
                                        }
                                    },
                                    "Cancel"
                                }
                                button {
                                    r#type: "button",
                                    class: "chat-card-btn chat-card-btn-primary",
                                    onclick: move |_| {
                                        if let Some(cb) = on_confirm_pay {
                                            cb.call(msg_id_confirm.clone());
                                        }
                                    },
                                    "Confirm"
                                }
                            }
                        }
                        if mine {
                            time { class: "chat-bubble-time", "{when}" }
                        }
                    }
                } else if let Some(ref att) = msg.attachment {
                    a {
                        class: if mine { "chat-bubble chat-file-card is-mine" } else { "chat-bubble chat-file-card" },
                        href: "{att.url}",
                        span { class: "chat-file-icon", aria_hidden: true, FileIcon { size: 22 } }
                        span { class: "chat-file-copy",
                            strong { "{att.name}" }
                            span {
                                "{format_file_size(att.size_bytes)} · "
                                if mine { "Sent file" } else { "Download file" }
                            }
                        }
                        time { class: "chat-bubble-time", "{when}" }
                    }
                } else {
                    div {
                        class: if mine { "chat-bubble is-mine" } else { "chat-bubble" },
                        "data-kind": "{msg.kind}",
                        p { class: "chat-bubble-text", "{msg.text}" }
                        if mine {
                            time { class: "chat-bubble-time", "{when}" }
                        }
                    }
                }
                if !mine {
                    if let Some(cb) = on_bind_reply {
                        button {
                            r#type: "button",
                            class: "chat-bind-btn",
                            aria_label: "Reply to bind tip",
                            onclick: move |_| cb.call(msg_id_reply.clone()),
                            "Reply"
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `ChatThreadList` in `src/components/messages/ChatThread.tsx`.
#[component]
pub fn ChatThreadList(
    section: ChatThreadSection,
    visible_messages: Vec<ChatMessageView>,
    peer_label: String,
    #[props(default)] peer_image_url: Option<String>,
) -> Element {
    let (empty_title, empty_body) = section.empty_copy();
    rsx! {
        div { class: "chat-thread-messages", "data-aeon-scope": "thread",
            div { class: "chat-thread-list", "data-aeon-part": "list",
                if visible_messages.is_empty() {
                    EmptyState {
                        title: empty_title.to_string(),
                        body: Some(empty_body.to_string()),
                    }
                } else {
                    for msg in visible_messages {
                        MessageBubble {
                            key: "{msg.id}",
                            msg,
                            peer_label: peer_label.clone(),
                            peer_image_url: peer_image_url.clone(),
                        }
                    }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/messages/ChatComposer.tsx`.
#[component]
pub fn ChatComposer(
    draft: String,
    peer_label: String,
    #[props(default = true)] can_attach: bool,
    on_draft_change: EventHandler<String>,
    on_submit: EventHandler<()>,
    #[props(default)] on_attach: Option<EventHandler<()>>,
    #[props(default)] on_fill_command: Option<EventHandler<&'static str>>,
) -> Element {
    let mut show_commands = use_signal(|| false);
    let commands_open = *show_commands.read() || draft.starts_with('/');
    let trimmed_empty = draft.trim().is_empty();
    let state = if commands_open {
        "command"
    } else if trimmed_empty {
        "idle"
    } else {
        "ready"
    };

    rsx! {
        form {
            class: "chat-composer",
            "data-aeon-scope": "composer",
            "data-aeon-part": "brc218-composer",
            "data-aeon-state": state,
            onsubmit: move |e| {
                e.prevent_default();
                if !trimmed_empty {
                    show_commands.set(false);
                    on_submit.call(());
                }
            },
            if commands_open {
                ul { class: "chat-command-menu", aria_label: "Commands",
                    for (verb, hint) in CHAT_COMMANDS {
                        li { key: "{verb}",
                            button {
                                r#type: "button",
                                onclick: move |_| {
                                    show_commands.set(false);
                                    on_draft_change.call(format!("/{verb} "));
                                },
                                code { "/{verb}" }
                                span { "{hint}" }
                            }
                        }
                    }
                }
            }
            div { class: "chat-composer-toolbar", "data-aeon-part": "toolbar",
                button {
                    r#type: "button",
                    class: "chat-action-btn",
                    title: "Attach file (up to 8 MB)",
                    aria_label: "Attach file",
                    "data-aeon-state": if can_attach { "ready" } else { "disabled" },
                    disabled: !can_attach,
                    onclick: move |_| {
                        if let Some(cb) = on_attach {
                            cb.call(());
                        } else if let Ok(Some(att)) = crate::p2p_chat_calls::pick_chat_attachment() {
                            on_draft_change.call(format!("[file: {} ({} B)]", att.filename, att.size_bytes));
                        }
                    },
                    AttachFileIcon { size: 18 }
                }
                button {
                    r#type: "button",
                    class: "chat-action-btn",
                    title: "Commands",
                    aria_label: "Commands",
                    aria_expanded: commands_open,
                    onclick: move |_| {
                        let next = !*show_commands.read();
                        show_commands.set(next);
                    },
                    "/"
                }
                button {
                    r#type: "button",
                    class: "chat-action-btn",
                    title: "Pay",
                    aria_label: "Pay",
                    onclick: move |_| {
                        if let Some(cb) = on_fill_command {
                            cb.call("pay");
                        } else {
                            on_draft_change.call("/pay ".to_string());
                        }
                    },
                    PayIcon { size: 18 }
                }
                button {
                    r#type: "button",
                    class: "chat-action-btn",
                    title: "Request",
                    aria_label: "Request",
                    onclick: move |_| {
                        if let Some(cb) = on_fill_command {
                            cb.call("request");
                        } else {
                            on_draft_change.call("/request ".to_string());
                        }
                    },
                    RequestMoneyIcon { size: 18 }
                }
            }
            input {
                class: "chat-input",
                "data-aeon-part": "input",
                autocomplete: "off",
                placeholder: "Message {peer_label}",
                value: "{draft}",
                oninput: move |e| on_draft_change.call(e.value()),
            }
            div { "data-aeon-part": "actions",
                button {
                    r#type: "submit",
                    class: "chat-send-btn",
                    aria_label: "Send",
                    disabled: trimmed_empty,
                    SendIcon { size: 18 }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unread_badge_caps_at_99_plus() {
        assert_eq!(unread_badge_label(1), "1");
        assert_eq!(unread_badge_label(99), "99");
        assert_eq!(unread_badge_label(140), "99+");
    }

    #[test]
    fn file_size_formats_bytes_kb_and_mb() {
        assert_eq!(format_file_size(512), "512 B");
        assert_eq!(format_file_size(2048), "2.0 KB");
        assert_eq!(format_file_size(3 * 1024 * 1024), "3.0 MB");
    }
}
