// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of HandCash Desktop Connected Apps, App Launcher Grid, Notes & Developer Keys:
//! - `src/components/ConnectedAppsPanel.tsx`
//! - `src/components/AppLauncherGrid.tsx`
//! - `src/components/AppAvatar.tsx`
//! - `src/components/AppDetailsPanel.tsx`
//! - `src/components/NotesPanel.tsx`
//! - `src/components/DevKeysPanel.tsx`

use crate::icons::{AppsIcon, CodeIcon, CopyIcon, FileIcon, KeyIcon, LaunchIcon, SettingsIcon};
use crate::machines::{CollectionView, NavChild, ToastNotice};
use crate::state::{
    copy_to_clipboard, format_relative_time, load_builtin_chart_apps, note_title, now_ms,
    open_external_url, truncate_mid, AppServices, ConnectedAppRecord, WalletSnapshot,
};
use crate::ui::chrome::{ActionIcon, ActionTone, DockActionSpec, DockSpec, DockTrigger};
use crate::ui::collectables::CollectionViewToggle;
use crate::ui::EmptyState;
use aeon_dioxus::{use_aeon_machine, use_aeon_machine_with};
use aeon_ui::button;
use dioxus::prelude::*;
use handcash_machines::app_launcher::{AppLauncherEvent, AppLauncherMachine};
use handcash_machines::dev_keys_panel::DevKeysPanelMachine;
use handcash_machines::grant_expiry::{GrantExpiryInput, GrantExpiryMachine, GrantExpiryState};
use handcash_machines::notes::{Note as MachineNote, NotesEvent, NotesMachine, NotesState};
use std::sync::Arc;

fn app_title(app: &ConnectedAppRecord) -> String {
    if !app.name.trim().is_empty() {
        return app.name.trim().to_string();
    }
    app.origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

fn app_initials(origin: &str) -> String {
    let host = origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    host.chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "A".into())
}

/// 1:1 port of `src/components/AppAvatar.tsx`.
#[component]
pub fn AppAvatar(
    origin: String,
    name: String,
    #[props(default = "md")] size: &'static str,
) -> Element {
    let icon_size = match size {
        "lg" => 28,
        "sm" => 18,
        _ => 22,
    };
    let has_http = origin.starts_with("https://") || origin.starts_with("http://");
    let mut state = use_signal(move || if has_http { "loading" } else { "fallback" });
    let cur_state = *state.read();
    let initials = app_initials(&origin);
    let icon_url = format!("{}/favicon.ico", origin.trim_end_matches('/'));
    rsx! {
        div {
            class: "app-avatar app-avatar-{size}",
            "data-aeon-part": "avatar",
            "data-aeon-state": cur_state,
            title: "{name}",
            if cur_state == "loading" {
                crate::ui::primitives::SkeletonAvatar { size: size.to_string() }
            }
            if cur_state != "fallback" {
                img {
                    class: "app-avatar-img",
                    src: "{icon_url}",
                    alt: "",
                    onload: move |_| state.set("ready"),
                    onerror: move |_| state.set("fallback"),
                }
            } else {
                span {
                    class: "app-avatar-fallback",
                    aria_label: "{initials}",
                    AppsIcon { size: icon_size }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/GrantExpiryLine.tsx`.
#[component]
pub fn GrantExpiryLine(#[props(default)] expires_at: Option<i64>) -> Element {
    let now = now_ms();
    let expiry = use_aeon_machine_with::<GrantExpiryMachine>(GrantExpiryInput { expires_at, now });
    let expiry_state = expiry.state();
    let state_attr = expiry.state_attr();
    let text = match (expiry_state, expires_at) {
        (_, None) => "Connected until you disconnect".to_string(),
        (GrantExpiryState::Expired | GrantExpiryState::Revoked, _) => "Expired".to_string(),
        (_, Some(ts)) => {
            let rem_ms = ts.saturating_sub(now);
            let mins = (rem_ms / 60_000).max(1);
            if mins < 60 {
                format!("Expires in {mins}m")
            } else if mins < 24 * 60 {
                format!("Expires in {}h", mins / 60)
            } else {
                format!("Expires in {}d", mins / (24 * 60))
            }
        }
    };
    rsx! {
        p {
            class: "grant-expiry",
            "data-aeon-scope": "grant-expiry",
            "data-aeon-state": "{state_attr}",
            "{text}"
        }
    }
}

/// 1:1 port of `src/components/ScopeIcon.tsx`.
#[component]
pub fn ScopeIcon(scope_id: String, #[props(default = 13)] size: u32) -> Element {
    match scope_id.as_str() {
        "auto-pay" => rsx! { crate::icons::CoinGlyphIcon { size } },
        "receive" => rsx! { crate::icons::ReceiveIcon { size } },
        "items" | "tokens" => rsx! { crate::icons::CollectablesIcon { size } },
        _ => rsx! { crate::icons::EyeIcon { size } },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum LauncherTileKind {
    NativeNotes,
    ChartApp(String),
    PeerApp(ConnectedAppRecord),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LauncherTile {
    id: String,
    label: String,
    kind: LauncherTileKind,
}

impl LauncherTile {
    fn kind_attr(&self) -> &'static str {
        match self.kind {
            LauncherTileKind::NativeNotes => "native",
            LauncherTileKind::ChartApp(_) => "chart",
            LauncherTileKind::PeerApp(_) => "peer",
        }
    }
}

/// 1:1 port of `src/components/ConnectedAppsPanel.tsx` + `src/components/AppLauncherGrid.tsx`.
#[component]
pub fn ConnectedAppsPanel(
    snap: WalletSnapshot,
    view: Signal<CollectionView>,
    mut nav_child: Signal<Option<NavChild>>,
) -> Element {
    let _ = snap;
    let services = use_context::<Arc<AppServices>>();
    let mut query = use_signal(String::new);
    let launcher = use_aeon_machine::<AppLauncherMachine>();

    let apps = services.list_connected_apps();
    let charts = use_hook(load_builtin_chart_apps);
    let q = query.read().trim().to_ascii_lowercase();
    let cur_view = *view.read();
    let filtered_apps: Vec<ConnectedAppRecord> = apps
        .iter()
        .filter(|a| {
            q.is_empty()
                || a.name.to_ascii_lowercase().contains(&q)
                || a.origin.to_ascii_lowercase().contains(&q)
        })
        .cloned()
        .collect();

    let mut tiles = Vec::new();
    if q.is_empty() || "notes".contains(&q) {
        tiles.push(LauncherTile {
            id: "native:notes".into(),
            label: "Notes".into(),
            kind: LauncherTileKind::NativeNotes,
        });
    }
    for chart in charts.iter() {
        if chart.verified && (q.is_empty() || chart.name.to_ascii_lowercase().contains(&q)) {
            tiles.push(LauncherTile {
                id: format!("chart:{}", chart.id),
                label: chart.name.clone(),
                kind: LauncherTileKind::ChartApp(chart.id.clone()),
            });
        }
    }
    for app in filtered_apps.iter() {
        tiles.push(LauncherTile {
            id: format!("peer:{}", app.origin),
            label: app_title(app),
            kind: LauncherTileKind::PeerApp(app.clone()),
        });
    }

    let cur_focused = launcher.context().focused;
    let launcher_state_attr = launcher.state_attr();

    rsx! {
        div {
            class: "nav-section-body nav-section-with-scroll",
            "data-aeon-scope": "connected-apps",
            "data-aeon-state": cur_view.as_str(),

            div { class: "connected-panel-head",
                h2 { "Apps" }
                crate::ui::primitives::TitlebarActions {
                    section: crate::machines::NavSection::Apps,
                    class: "connected-panel-head-actions",
                    div { class: "field", style: "margin: 0;",
                        input {
                            r#type: "search",
                            placeholder: "Search apps or origin…",
                            value: "{query}",
                            oninput: move |e| query.set(e.value()),
                        }
                    }
                    button {
                        r#type: "button",
                        class: "wallet-nav-chrome-btn",
                        aria_label: "Developer keys",
                        title: "Developer keys",
                        onclick: move |_| nav_child.set(Some(NavChild::DevKeys)),
                        CodeIcon { size: 16 }
                    }
                    CollectionViewToggle { view }
                }
            }

            if cur_view == CollectionView::Grid {
                div { class: "nav-section-scroll-body",
                    if tiles.is_empty() {
                        div { class: "friends-empty",
                            strong { "No apps found" }
                            span { "Try another name or origin." }
                        }
                    } else {
                        ul {
                            "data-aeon-scope": "app-launcher",
                            "data-aeon-state": "{launcher_state_attr}",
                            for tile in tiles.iter() {
                                {
                                    let tid = tile.id.clone();
                                    let tid_panel = tile.id.clone();
                                    let tlabel = tile.label.clone();
                                    let tkind = tile.kind.clone();
                                    let tkind_open = tile.kind.clone();
                                    let kind_attr = tile.kind_attr();
                                    let is_open = cur_focused.as_deref() == Some(tile.id.as_str());
                                    let cell_state = if is_open { "focused" } else { "idle" };
                                    let aria_lbl = if is_open {
                                        format!("Open {tlabel}")
                                    } else {
                                        tlabel.clone()
                                    };
                                    let peer_origin = match &tile.kind {
                                        LauncherTileKind::PeerApp(a) => Some(a.origin.clone()),
                                        _ => None,
                                    };
                                    let icon_el = match &tile.kind {
                                        LauncherTileKind::PeerApp(a) => rsx! {
                                            AppAvatar { origin: a.origin.clone(), name: tlabel.clone(), size: "md" }
                                        },
                                        LauncherTileKind::NativeNotes => rsx! {
                                            span { class: "app-launcher-glyph", "aria-hidden": "true",
                                                FileIcon { size: 22 }
                                            }
                                        },
                                        LauncherTileKind::ChartApp(_) => rsx! {
                                            span { class: "app-launcher-glyph", "aria-hidden": "true",
                                                AppsIcon { size: 22 }
                                            }
                                        },
                                    };
                                    let icon_el_panel = match &tile.kind {
                                        LauncherTileKind::PeerApp(a) => rsx! {
                                            AppAvatar { origin: a.origin.clone(), name: tlabel.clone(), size: "md" }
                                        },
                                        LauncherTileKind::NativeNotes => rsx! {
                                            span { class: "app-launcher-glyph", "aria-hidden": "true",
                                                FileIcon { size: 22 }
                                            }
                                        },
                                        LauncherTileKind::ChartApp(_) => rsx! {
                                            span { class: "app-launcher-glyph", "aria-hidden": "true",
                                                AppsIcon { size: 22 }
                                            }
                                        },
                                    };

                                    rsx! {
                                        li {
                                            key: "{tid}",
                                            "data-aeon-part": "cell",
                                            "data-aeon-state": "{cell_state}",
                                            style: if is_open { "grid-column: span 3;" } else { "" },
                                            button {
                                                r#type: "button",
                                                "data-aeon-part": "tile",
                                                "data-kind": "{kind_attr}",
                                                aria_label: "{aria_lbl}",
                                                aria_expanded: is_open,
                                                title: "{tlabel}",
                                                onclick: move |_| {
                                                    launcher.send(AppLauncherEvent::Tap { id: tid.clone() });
                                                    if is_open {
                                                        match &tkind {
                                                            LauncherTileKind::NativeNotes => {
                                                                nav_child.set(Some(NavChild::Notes));
                                                            }
                                                            LauncherTileKind::ChartApp(cid) => {
                                                                nav_child.set(Some(NavChild::ChartApp(cid.clone())));
                                                            }
                                                            LauncherTileKind::PeerApp(app) => {
                                                                nav_child.set(Some(NavChild::AppDetails(app.origin.clone())));
                                                            }
                                                        }
                                                    }
                                                },
                                                {icon_el}
                                            }
                                            if is_open {
                                                div { "data-aeon-part": "panel",
                                                    {icon_el_panel}
                                                    div { "data-aeon-part": "body",
                                                        span { "data-aeon-part": "label", "{tlabel}" }
                                                        div { "data-aeon-part": "actions",
                                                            if let Some(orig) = peer_origin {
                                                                button::Root {
                                                                    variant: button::ButtonVariant::Ghost,
                                                                    class: "btn btn-ghost",
                                                                    onclick: move |_| {
                                                                        nav_child.set(Some(NavChild::AppDetails(orig.clone())));
                                                                    },
                                                                    SettingsIcon { size: 16 }
                                                                    span { "Manage" }
                                                                }
                                                            }
                                                            button::Root {
                                                                variant: button::ButtonVariant::Ghost,
                                                                class: "btn btn-ghost",
                                                                onclick: move |_| {
                                                                    let _ = &tid_panel;
                                                                    match &tkind_open {
                                                                        LauncherTileKind::NativeNotes => {
                                                                            nav_child.set(Some(NavChild::Notes));
                                                                        }
                                                                        LauncherTileKind::ChartApp(cid) => {
                                                                            nav_child.set(Some(NavChild::ChartApp(cid.clone())));
                                                                        }
                                                                        LauncherTileKind::PeerApp(app) => {
                                                                            let _ = open_external_url(&app.origin);
                                                                        }
                                                                    }
                                                                },
                                                                LaunchIcon { size: 16 }
                                                                span { "Open" }
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
            } else if apps.is_empty() {
                EmptyState {
                    icon: Some(rsx! { AppsIcon { size: 28 } }),
                    title: "No apps connected",
                }
            } else if filtered_apps.is_empty() {
                div { class: "friends-empty",
                    strong { "No apps found" }
                    span { "Try another name or origin." }
                }
            } else {
                div { class: "nav-section-scroll-body",
                    ul { class: "connected-app-list",
                        for app in filtered_apps.iter() {
                            {
                                let orig = app.origin.clone();
                                let orig_manage = app.origin.clone();
                                let orig_open = app.origin.clone();
                                let title = app_title(app);
                                rsx! {
                                    li { key: "{app.origin}", class: "connected-app-row", "data-ready": "",
                                        div { class: "connected-app-row-live",
                                            div { class: "connected-app-card-top",
                                                button {
                                                    r#type: "button",
                                                    class: "connected-app-main",
                                                    onclick: move |_| nav_child.set(Some(NavChild::AppDetails(orig.clone()))),
                                                    AppAvatar { origin: app.origin.clone(), name: title.clone(), size: "sm" }
                                                    span { class: "connected-app-body",
                                                        strong { class: "connected-app-name", "{title}" }
                                                        span { class: "connected-app-host mono", "{app.origin}" }
                                                    }
                                                }
                                            }
                                            div { class: "connected-app-stats",
                                                span { class: "connected-app-usd",
                                                    span { class: "connected-app-usd-primary", "0 sats" }
                                                    span { class: "connected-app-usd-label", "spent 24h" }
                                                }
                                                div {
                                                    class: "connected-app-limit connected-app-limit--empty",
                                                    "aria-hidden": "true",
                                                }
                                            }
                                            div { class: "connected-app-card-actions",
                                                button::Root {
                                                    variant: button::ButtonVariant::Ghost,
                                                    class: "btn btn-ghost btn-icon connected-app-icon-action",
                                                    onclick: move |_| nav_child.set(Some(NavChild::AppDetails(orig_manage.clone()))),
                                                    SettingsIcon { size: 17 }
                                                }
                                                button::Root {
                                                    variant: button::ButtonVariant::Ghost,
                                                    class: "btn btn-ghost btn-icon connected-app-icon-action",
                                                    onclick: move |_| {
                                                        let _ = open_external_url(&orig_open);
                                                    },
                                                    LaunchIcon { size: 17 }
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

/// 1:1 port of `src/components/AppDetailsPanel.tsx` with CTAs baked into the WalletNav action bar.
#[component]
pub fn AppDetailsPanel(
    origin: String,
    mut nav_child: Signal<Option<NavChild>>,
    mut dock_spec: Signal<Option<DockSpec>>,
    dock_trigger: Signal<DockTrigger>,
    mut toast: Signal<Option<ToastNotice>>,
    #[props(default)] app_override: Option<ConnectedAppRecord>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut confirming_disconnect = use_signal(|| false);
    let mut last_seq = use_signal(|| dock_trigger.read().seq);

    let app_opt = app_override.or_else(|| {
        services
            .list_connected_apps()
            .into_iter()
            .find(|a| a.origin == origin)
    });

    let Some(app) = app_opt else {
        if dock_spec.read().is_some() {
            dock_spec.set(None);
        }
        return rsx! {
            div { class: "nav-child-panel", "data-aeon-scope": "app-details",
                p { class: "connected-empty-line", "App not found" }
            }
        };
    };

    let is_confirming = *confirming_disconnect.read();
    let desired_dock = if is_confirming {
        DockSpec {
            aria_label: "Confirm disconnect app",
            secondary: Some(DockActionSpec::new(
                "cancel-disconnect",
                "Cancel",
                ActionTone::Secondary,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "confirm-disconnect",
                "Disconnect",
                ActionTone::Danger,
                ActionIcon::Close,
            ),
        }
    } else {
        DockSpec {
            aria_label: "App actions",
            secondary: Some(DockActionSpec::new(
                "ask-disconnect",
                "Disconnect",
                ActionTone::Danger,
                ActionIcon::Close,
            )),
            primary: DockActionSpec::new(
                "open-app",
                "Open",
                ActionTone::Primary,
                ActionIcon::Check,
            ),
        }
    };
    if *dock_spec.read() != Some(desired_dock.clone()) {
        dock_spec.set(Some(desired_dock));
    }

    {
        let svc_act = Arc::clone(&services);
        let orig_act = app.origin.clone();
        let title_act = app_title(&app);
        use_effect(move || {
            let trig = *dock_trigger.read();
            if trig.seq == *last_seq.read() {
                return;
            }
            last_seq.set(trig.seq);
            match trig.action_id {
                "ask-disconnect" => confirming_disconnect.set(true),
                "cancel-disconnect" => confirming_disconnect.set(false),
                "confirm-disconnect" => match svc_act.revoke_connected_app(&orig_act) {
                    Ok(()) => {
                        toast.set(Some(ToastNotice {
                            title: "Disconnected".into(),
                            body: Some(title_act.clone()),
                            tone: "success",
                        }));
                        dock_spec.set(None);
                        nav_child.set(None);
                    }
                    Err(e) => toast.set(Some(ToastNotice {
                        title: "Disconnect failed".into(),
                        body: Some(e),
                        tone: "error",
                    })),
                },
                "open-app" => {
                    if let Err(e) = open_external_url(&orig_act) {
                        toast.set(Some(ToastNotice {
                            title: "Open app".into(),
                            body: Some(e),
                            tone: "error",
                        }));
                    }
                }
                _ => {}
            }
        });
    }

    let title = app_title(&app);
    let incoming_allowed = app.accept_incoming_funds.unwrap_or(false);
    let launch_label = format!("Launch {title}");
    let launch_origin = app.origin.clone();
    let revoke_origin = app.origin.clone();
    let revoke_title = title.clone();
    let svc_revoke = Arc::clone(&services);
    let has_home = app.origin.starts_with("https://") || app.origin.starts_with("http://");

    rsx! {
        div {
            class: "nav-child-panel app-details-inline",
            "data-aeon-scope": "app-details",
            div { class: "app-details-head app-details-overview-head",
                div { class: "app-details-identity",
                    AppAvatar { origin: app.origin.clone(), name: title.clone(), size: "md" }
                    div { class: "app-details-head-text",
                        h3 { id: "app-details-title", "{title}" }
                        span { class: "mono app-details-host", "{app.origin}" }
                        GrantExpiryLine { expires_at: app.expires_at }
                    }
                }
                dl { class: "app-activity-stats", aria_label: "Activity",
                    div {
                        dt { "Spent 24h" }
                        dd { "—" }
                    }
                    div {
                        dt { "Earned 24h" }
                        dd { "—" }
                    }
                }
            }

            div { class: "app-details-section",
                p { class: "scope-list-label", "Permissions" }
                div { class: "permission-chips", aria_label: "Permissions",
                    button {
                        r#type: "button",
                        class: "permission-chip",
                        title: "Use connected, non-spending wallet APIs. Spending, signatures, encryption, identity proofs, and protected inventory require separate approval.",
                        ScopeIcon { scope_id: "view".to_string(), size: 13 }
                        "View only, no spending"
                    }
                    if incoming_allowed {
                        button {
                            r#type: "button",
                            class: "permission-chip",
                            title: "Receive funds sent to this wallet without prompting each time.",
                            ScopeIcon { scope_id: "receive".to_string(), size: 13 }
                            "Receive automatically"
                        }
                    }
                }
            }

            if is_confirming {
                p { class: "error", role: "alert",
                    "Disconnect {title} ({app.origin})? Confirm in the action bar above."
                }
            }

            div { class: "actions app-details-actions wallet-action-bar",
                if has_home {
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary btn-icon connected-app-icon-action",
                        aria_label: launch_label.clone(),
                        title: launch_label,
                        onclick: move |_| {
                            if let Err(e) = open_external_url(&launch_origin) {
                                toast.set(Some(ToastNotice {
                                    title: "Open app".into(),
                                    body: Some(e),
                                    tone: "error",
                                }));
                            }
                        },
                        LaunchIcon { size: 17 }
                    }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    onclick: move |_| match svc_revoke.revoke_connected_app(&revoke_origin) {
                        Ok(()) => {
                            toast.set(Some(ToastNotice {
                                title: "Disconnected".into(),
                                body: Some(revoke_title.clone()),
                                tone: "success",
                            }));
                            dock_spec.set(None);
                            nav_child.set(None);
                        }
                        Err(e) => toast.set(Some(ToastNotice {
                            title: "Disconnect failed".into(),
                            body: Some(e),
                            tone: "error",
                        })),
                    },
                    button::Label { "Disconnect" }
                }
            }
        }
    }
}

/// 1:1 port of `src/components/NotesPanel.tsx` (sealed per-account private notes).
#[component]
pub fn NotesPanel(mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let notes_chart = use_aeon_machine::<NotesMachine>();
    let initial_notes: Vec<MachineNote> = services
        .list_notes()
        .into_iter()
        .map(|n| MachineNote {
            id: n.id,
            body: n.body,
            saved_at: n.saved_at.max(0) as u64,
        })
        .collect();
    use_hook(move || {
        notes_chart.send(NotesEvent::OpenDone {
            notes: initial_notes,
            unreadable: 0,
        });
    });

    let cur_state = notes_chart.state();
    let cur_ctx = notes_chart.context();
    let state_attr = notes_chart.state_attr();
    let is_editing = matches!(
        cur_state,
        NotesState::Editing | NotesState::Saving | NotesState::Deleting
    );
    let svc_save = Arc::clone(&services);
    let svc_del = Arc::clone(&services);
    let now = now_ms();

    let delete_label = if cur_ctx.note_id.is_some() { "Delete" } else { "Discard" };
    let id_for_delete = cur_ctx.note_id.clone();
    let id_for_save = cur_ctx.note_id.clone();
    let draft_val = cur_ctx.draft.clone();
    let changed = cur_ctx.draft != cur_ctx.original;
    rsx! {
        div {
            class: "nav-section-body settings-detail settings-scroll",
            "data-aeon-scope": "notes",
            "data-aeon-state": "{state_attr}",

            if is_editing {
                div { class: "settings-form", "data-aeon-part": "editor",
                    textarea {
                        class: "input notes-editor",
                        aria_label: "Note",
                        placeholder: "Write a note",
                        rows: "8",
                        value: "{draft_val}",
                        oninput: move |e| notes_chart.send(NotesEvent::Edit { body: e.value() }),
                    }
                    if let Some(ref e) = cur_ctx.error {
                        p { class: "permission-note", role: "alert", "{e}" }
                    }
                    div { class: "actions",
                        button::Root {
                            variant: button::ButtonVariant::Ghost,
                            class: "btn btn-ghost",
                            "data-aeon-part": "delete",
                            onclick: move |_| {
                                notes_chart.send(NotesEvent::Delete);
                                if let Some(ref id_str) = id_for_delete {
                                    match svc_del.delete_note(id_str) {
                                        Ok(_) => notes_chart.send(NotesEvent::DeleteDone),
                                        Err(e) => notes_chart.send(NotesEvent::DeleteError { error: e }),
                                    }
                                }
                            },
                            button::Label {
                                {delete_label}
                            }
                        }
                        button::Root {
                            variant: button::ButtonVariant::Solid,
                            class: "btn btn-primary",
                            "data-aeon-part": "done",
                            onclick: move |_| {
                                let body_val = notes_chart.context().draft.clone();
                                notes_chart.send(NotesEvent::Done);
                                if changed {
                                    match svc_save.save_note(id_for_save.as_deref(), &body_val) {
                                        Ok(next_list) => {
                                            let saved = next_list.into_iter().next().map(|n| MachineNote {
                                                id: n.id,
                                                body: n.body,
                                                saved_at: n.saved_at.max(0) as u64,
                                            });
                                            notes_chart.send(NotesEvent::SaveDone { note: saved });
                                            toast.set(Some(ToastNotice {
                                                title: "Note saved".into(),
                                                body: None,
                                                tone: "success",
                                            }));
                                        }
                                        Err(e) => notes_chart.send(NotesEvent::SaveError { error: e }),
                                    }
                                }
                            },
                            button::Label { "Done" }
                        }
                    }
                }
            } else {
                div { "data-aeon-part": "head", style: "display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;",
                    p { class: "settings-section-lede", style: "margin: 0;",
                        "Sealed on this device. Only this account can open them."
                    }
                    button::Root {
                        variant: button::ButtonVariant::Solid,
                        class: "btn btn-primary btn-compact",
                        "data-aeon-part": "new",
                        onclick: move |_| notes_chart.send(NotesEvent::New),
                        button::Label { "New note" }
                    }
                }
                if cur_ctx.notes.is_empty() {
                    p { class: "settings-section-lede", "data-aeon-part": "empty", "No notes yet." }
                } else {
                    ul { class: "settings-list", "data-aeon-part": "list",
                        for note in cur_ctx.notes {
                            {
                                let nid = note.id.clone();
                                let ntitle = note_title(&note.body);
                                let nwhen = format_relative_time(note.saved_at as i64, now);
                                rsx! {
                                    li { key: "{nid}", class: "settings-nav-item",
                                        button {
                                            r#type: "button",
                                            class: "settings-nav-row",
                                            "data-aeon-scope": "listRow",
                                            "data-aeon-part": "root",
                                            onclick: move |_| notes_chart.send(NotesEvent::Open { id: nid.clone() }),
                                            span {
                                                "aria-hidden": "true",
                                                "data-aeon-scope": "listRow",
                                                "data-aeon-part": "leading",
                                                span {
                                                    "aria-hidden": "true",
                                                    class: "settings-row-icon",
                                                    "data-tone": "default",
                                                    FileIcon { size: 17 }
                                                }
                                            }
                                            span { "data-aeon-scope": "listRow", "data-aeon-part": "label", "{ntitle}" }
                                            span { "data-aeon-scope": "listRow", "data-aeon-part": "description", "{nwhen}" }
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

/// 1:1 port of `src/components/DevKeysPanel.tsx`.
#[component]
pub fn DevKeysPanel(mut toast: Signal<Option<ToastNotice>>) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let dev_keys_chart = use_aeon_machine::<DevKeysPanelMachine>();
    let dev_keys_state = dev_keys_chart.state_attr();
    let mut keys = use_signal(|| services.list_dev_keys());
    let mut label_input = use_signal(String::new);
    let mut latest_env = use_signal(|| Option::<String>::None);

    let cur_keys = keys.read().clone();
    let svc_create = Arc::clone(&services);
    let now = now_ms();

    rsx! {
        div {
            class: "nav-section-body settings-detail settings-scroll",
            "data-aeon-scope": "dev-keys",
            "data-aeon-state": "{dev_keys_state}",
            div { style: "display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px;",
                div {
                    h3 { "Developer keys" }
                    p { class: "settings-row-desc",
                        "Isolated server wallet keys for backend apps and BRC-100 automation."
                    }
                }
            }

            div { style: "display: flex; gap: 8px; margin-bottom: 14px;",
                input {
                    style: "flex: 1;",
                    placeholder: "Key label (optional, e.g. Staging API)",
                    value: "{label_input}",
                    oninput: move |e| label_input.set(e.value()),
                }
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    onclick: move |_| {
                        let lbl = label_input.read().clone();
                        match svc_create.create_dev_key(&lbl) {
                            Ok((rec, env_str)) => {
                                label_input.set(String::new());
                                latest_env.set(Some(env_str));
                                keys.set(svc_create.list_dev_keys());
                                toast.set(Some(ToastNotice {
                                    title: "Developer key created".into(),
                                    body: Some(rec.label),
                                    tone: "success",
                                }));
                            }
                            Err(e) => toast.set(Some(ToastNotice {
                                title: "Create failed".into(),
                                body: Some(e),
                                tone: "error",
                            })),
                        }
                    },
                    KeyIcon { size: 16 }
                    button::Label { "New developer key" }
                }
            }

            if let Some(ref env_block) = *latest_env.read() {
                {
                    let env_copy = env_block.clone();
                    rsx! {
                        div {
                            class: "panel",
                            style: "padding: 12px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 8px;",
                            strong { "Copy your new server key config" }
                            pre {
                                class: "mono",
                                style: "margin: 0; font-size: 11px; white-space: pre-wrap; word-break: break-all;",
                                "{env_block}"
                            }
                            div { class: "actions",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    onclick: move |_| {
                                        if copy_to_clipboard(&env_copy).is_ok() {
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some("Developer key config copied.".into()),
                                                tone: "success",
                                            }));
                                        }
                                    },
                                    CopyIcon { size: 14 }
                                    button::Label { "Copy config" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| latest_env.set(None),
                                    button::Label { "Dismiss" }
                                }
                            }
                        }
                    }
                }
            }

            if cur_keys.is_empty() {
                EmptyState {
                    icon: Some(rsx! { CodeIcon { size: 28 } }),
                    title: "No developer keys yet",
                    body: Some("Create an isolated server key to sign and fund automated BRC-100 requests.".into()),
                }
            } else {
                ul { class: "settings-list",
                    for dk in cur_keys {
                        {
                            let dkid = dk.id.clone();
                            let dkid_rm = dk.id.clone();
                            let pk_copy = dk.public_key.clone();
                            let pk_short = truncate_mid(&dk.public_key, 10);
                            let when = format_relative_time(dk.created_at, now);
                            let svc_rm = Arc::clone(&services);
                            rsx! {
                                li { key: "{dkid}",
                                    div {
                                        class: "friend-copy-row",
                                        style: "display: flex; justify-content: space-between; align-items: center; padding: 10px 12px;",
                                        div {
                                            strong { "{dk.label}" }
                                            p { class: "mono settings-row-desc", style: "margin: 2px 0 0;", "{pk_short} · {when}" }
                                        }
                                        div { class: "actions", style: "display: flex; gap: 6px;",
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost",
                                                onclick: move |_| {
                                                    if copy_to_clipboard(&pk_copy).is_ok() {
                                                        toast.set(Some(ToastNotice {
                                                            title: "Copied".into(),
                                                            body: Some("Public key copied.".into()),
                                                            tone: "success",
                                                        }));
                                                    }
                                                },
                                                button::Label { "Copy key" }
                                            }
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost",
                                                onclick: move |_| {
                                                    if svc_rm.remove_dev_key(&dkid_rm).is_ok() {
                                                        keys.set(svc_rm.list_dev_keys());
                                                    }
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
    }
}
