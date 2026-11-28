// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! 1:1 port of `src/components/AuthShell.tsx`, `src/components/OnboardEntryPanel.tsx`,
//! `src/components/AuthScreen.tsx`, `src/components/CreateKeysBackupPanel.tsx`,
//! `src/components/OnboardAcceptPanel.tsx`, `src/components/OnboardFiatPanel.tsx`,
//! `src/components/OnboardProtectPanel.tsx`, `src/components/HistoryRecoveryPanel.tsx`,
//! `src/components/DeviceSignInPanel.tsx`, `src/components/PasswordField.tsx`, and
//! `src/components/auth/AuthEntryTaglines.tsx`.

use crate::icons::{EyeIcon, EyeOffIcon, ExpandMoreIcon, TickerCoinMark};
use crate::machines::{
    session_to_wallet_profile, AuthFormMode, FiatCode, OnboardStep, RestoreRole, ToastNotice,
};
use crate::state::{AcceptedCoins, AppServices, SessionSummary, WalletSnapshot};
use crate::ui::BrandLogo;
use aeon_dioxus::{use_aeon_machine, AeonMachineHandle};
use aeon_ui::{button, field, list_row, status_banner};
use dioxus::prelude::*;
use handcash_machines::app::{AppEvent, AppMachine};
use handcash_machines::unlock::{
    password_progress, UnlockEvent, UnlockMachine, UnlockSetupFactor, UnlockState as MachineUnlockState,
};
use handcash_primitives::brc140::{
    extract_brc140_shares, share_download_filename, slice_set_label, Brc140IssuedSet,
    BRC140_DESTINATION_HINTS,
};
use handcash_primitives::keys::MnemonicScheme;
use std::collections::BTreeSet;
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

const ACCEPT_ALL_COINS: &[&str] = &["bsv", "ltc", "bch", "btc", "doge", "arc-usd"];
const NO_KEYSTORE_TEXT: &str = "Needs a system keyring on this computer, or anyone who can read its files could open this wallet.";

#[derive(Clone, Debug)]
struct PendingOnboard {
    profile: SessionSummary,
    balance_sats: u64,
    wrap_password: String,
    mnemonic: Option<String>,
    step: OnboardStep,
    is_create: bool,
}

const MESH_VIEW_W: f32 = 1200.0;
const MESH_VIEW_H: f32 = 800.0;
const MESH_PAN_PAD: f32 = 180.0;
const MESH_NODE_COUNT: usize = 96;
const MESH_MAX_DIST: f32 = 140.0;
const MESH_NODE_DAMPING: f32 = 0.9982;
const MESH_NODE_DRIFT: f32 = 0.055;
const MESH_NODE_MAX_SPEED: f32 = 1.35;
const MESH_PULSE_SPEED_MIN: f32 = 0.01;
const MESH_PULSE_SPEED_MAX: f32 = 0.035;
const MESH_MAX_PULSES: usize = 18;
const MESH_PULSE_SPAWN_INTERVAL: u32 = 10;
const MESH_SPLIT_CHANCE: f32 = 0.28;
const MESH_SPLIT_COUNT_MIN: usize = 3;
const MESH_SPLIT_COUNT_MAX: usize = 6;

#[derive(Clone, Copy)]
struct MeshNode {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    radius: f32,
}

#[derive(Clone, Copy)]
struct MeshPulse {
    from_idx: usize,
    to_idx: usize,
    progress: f32,
    speed: f32,
    ease_kind: u8,
}

struct AuthMeshState {
    nodes: Vec<MeshNode>,
    pulses: Vec<MeshPulse>,
    frame_count: u32,
    rng: u64,
}

impl AuthMeshState {
    fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x5EED_CAFE_1234_5678)
            | 1;
        let mut state = Self {
            nodes: Vec::with_capacity(MESH_NODE_COUNT),
            pulses: Vec::with_capacity(MESH_MAX_PULSES),
            frame_count: 0,
            rng: seed,
        };
        let span_x = MESH_VIEW_W + MESH_PAN_PAD * 2.0;
        let span_y = MESH_VIEW_H + MESH_PAN_PAD * 2.0;
        for _ in 0..MESH_NODE_COUNT {
            let x = state.next_f32() * span_x - MESH_PAN_PAD;
            let y = state.next_f32() * span_y - MESH_PAN_PAD;
            let vx = (state.next_f32() - 0.5) * 1.4;
            let vy = (state.next_f32() - 0.5) * 1.4;
            let radius = state.next_f32() * 1.2 + 0.6;
            state.nodes.push(MeshNode { x, y, vx, vy, radius });
        }
        state
    }

    fn next_f32(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        ((x >> 40) as f32) / ((1u32 << 24) as f32)
    }

    fn next_usize(&mut self, upper: usize) -> usize {
        if upper <= 1 {
            return 0;
        }
        ((self.next_f32() * (upper as f32)) as usize).min(upper - 1)
    }

    fn ease(kind: u8, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match kind {
            0 => 1.0 - (1.0 - t).powi(4),
            1 => t.powi(4),
            2 => {
                if t < 0.5 {
                    4.0 * t.powi(3)
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
                }
            }
            _ => {
                let c1 = 1.2_f32;
                let c3 = c1 + 1.0;
                (1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)).clamp(0.0, 1.0)
            }
        }
    }

    fn step(&mut self) {
        let min_x = -MESH_PAN_PAD;
        let max_x = MESH_VIEW_W + MESH_PAN_PAD;
        let min_y = -MESH_PAN_PAD;
        let max_y = MESH_VIEW_H + MESH_PAN_PAD;
        for i in 0..self.nodes.len() {
            let dx_r = (self.next_f32() - 0.5) * MESH_NODE_DRIFT;
            let dy_r = (self.next_f32() - 0.5) * MESH_NODE_DRIFT;
            let n = &mut self.nodes[i];
            n.vx = n.vx * MESH_NODE_DAMPING + dx_r;
            n.vy = n.vy * MESH_NODE_DAMPING + dy_r;
            let speed = (n.vx * n.vx + n.vy * n.vy).sqrt();
            if speed > MESH_NODE_MAX_SPEED {
                n.vx = (n.vx / speed) * MESH_NODE_MAX_SPEED;
                n.vy = (n.vy / speed) * MESH_NODE_MAX_SPEED;
            }
            n.x += n.vx;
            n.y += n.vy;
            if n.x < min_x {
                n.x = min_x;
                n.vx = n.vx.abs();
            } else if n.x > max_x {
                n.x = max_x;
                n.vx = -n.vx.abs();
            }
            if n.y < min_y {
                n.y = min_y;
                n.vy = n.vy.abs();
            } else if n.y > max_y {
                n.y = max_y;
                n.vy = -n.vy.abs();
            }
        }

        self.frame_count = self.frame_count.wrapping_add(1);
        if self.frame_count % MESH_PULSE_SPAWN_INTERVAL == 0 && self.pulses.len() < MESH_MAX_PULSES {
            let from_idx = self.next_usize(self.nodes.len());
            let from = self.nodes[from_idx];
            let is_split = self.next_f32() < MESH_SPLIT_CHANCE;
            let num_targets = if is_split {
                MESH_SPLIT_COUNT_MIN
                    + self.next_usize(MESH_SPLIT_COUNT_MAX - MESH_SPLIT_COUNT_MIN + 1)
            } else {
                1
            };
            let mut used = vec![from_idx];
            for _ in 0..num_targets {
                if self.pulses.len() >= MESH_MAX_PULSES {
                    break;
                }
                let mut to_idx = self.next_usize(self.nodes.len());
                for _ in 0..20 {
                    if !used.contains(&to_idx) {
                        break;
                    }
                    to_idx = self.next_usize(self.nodes.len());
                }
                if used.contains(&to_idx) {
                    continue;
                }
                used.push(to_idx);
                let to = self.nodes[to_idx];
                let dist = (from.x - to.x).hypot(from.y - to.y);
                if dist < MESH_MAX_DIST * 1.6 {
                    let speed = MESH_PULSE_SPEED_MIN
                        + self.next_f32() * (MESH_PULSE_SPEED_MAX - MESH_PULSE_SPEED_MIN);
                    let ease_kind = self.next_usize(4) as u8;
                    self.pulses.push(MeshPulse {
                        from_idx,
                        to_idx,
                        progress: 0.0,
                        speed,
                        ease_kind,
                    });
                }
            }
        }

        let mut i = self.pulses.len();
        while i > 0 {
            i -= 1;
            self.pulses[i].progress += self.pulses[i].speed;
            if self.pulses[i].progress >= 1.0 {
                self.pulses.swap_remove(i);
            }
        }
    }
}

/// 1:1 port of `src/components/AuthShell.tsx` + `AuthMeshBackground.tsx`.
#[component]
pub fn AuthShell(
    #[props(default = "")] state: &'static str,
    #[props(default = true)] dark_mode: bool,
    children: Element,
) -> Element {
    let mut mesh = use_hook(|| Signal::new(AuthMeshState::new()));
    use_future(move || async move {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(33)).await;
            mesh.write().step();
        }
    });

    let (edge_rgb, edge_alpha_mul, node_rgb, node_alpha, pulse_core, glow_outer, glow_inner) =
        if dark_mode {
            (
                "rgb(100, 255, 160)",
                0.32_f32,
                "rgb(100, 255, 160)",
                0.50_f32,
                "rgba(255, 255, 255, 0.9)",
                0.24_f32,
                0.58_f32,
            )
        } else {
            (
                "rgb(0, 0, 0)",
                0.28_f32,
                "rgb(56, 203, 123)",
                0.55_f32,
                "rgba(10, 18, 14, 0.85)",
                0.18_f32,
                0.44_f32,
            )
        };

    let (edges, pulse_pts, node_pts) = {
        let st = mesh.read();
        let mut edges = Vec::with_capacity(256);
        let max_d2 = MESH_MAX_DIST * MESH_MAX_DIST;
        for i in 0..st.nodes.len() {
            let a = st.nodes[i];
            for j in (i + 1)..st.nodes.len() {
                let b = st.nodes[j];
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let d2 = dx * dx + dy * dy;
                if d2 < max_d2 {
                    let alpha = (1.0 - d2.sqrt() / MESH_MAX_DIST) * edge_alpha_mul;
                    if alpha > 0.01 {
                        edges.push((a.x, a.y, b.x, b.y, alpha));
                    }
                }
            }
        }
        let pulse_pts: Vec<(f32, f32)> = st
            .pulses
            .iter()
            .map(|p| {
                let from = st.nodes[p.from_idx];
                let to = st.nodes[p.to_idx];
                let eased = AuthMeshState::ease(p.ease_kind, p.progress);
                (
                    from.x + (to.x - from.x) * eased,
                    from.y + (to.y - from.y) * eased,
                )
            })
            .collect();
        let node_pts: Vec<(f32, f32, f32)> = st.nodes.iter().map(|n| (n.x, n.y, n.radius)).collect();
        (edges, pulse_pts, node_pts)
    };

    rsx! {
        div {
            class: "auth-shell",
            "data-aeon-scope": "auth-shell",
            "data-aeon-state": state,

            // Live animated payment-mesh backdrop mirroring `AuthMeshBackground.tsx`
            div { class: "auth-shell-mesh", "aria-hidden": "true", "data-aeon-part": "backdrop",
                svg {
                    class: "auth-mesh-canvas",
                    "aria-hidden": "true",
                    "data-aeon-part": "mesh",
                    view_box: "0 0 1200 800",
                    width: "100%",
                    height: "100%",
                    preserve_aspect_ratio: "xMidYMid slice",
                    fill: "none",
                    g { stroke: "{edge_rgb}", stroke_width: "1",
                        for (x1, y1, x2, y2, alpha) in edges {
                            line {
                                x1: "{x1:.1}",
                                y1: "{y1:.1}",
                                x2: "{x2:.1}",
                                y2: "{y2:.1}",
                                stroke_opacity: "{alpha:.3}",
                            }
                        }
                    }
                    g {
                        for (px, py) in pulse_pts {
                            circle {
                                cx: "{px:.1}",
                                cy: "{py:.1}",
                                r: "14",
                                fill: "{node_rgb}",
                                fill_opacity: "{glow_outer:.2}",
                            }
                            circle {
                                cx: "{px:.1}",
                                cy: "{py:.1}",
                                r: "7",
                                fill: "{node_rgb}",
                                fill_opacity: "{glow_inner:.2}",
                            }
                            circle {
                                cx: "{px:.1}",
                                cy: "{py:.1}",
                                r: "3",
                                fill: "{pulse_core}",
                            }
                        }
                    }
                    g { fill: "{node_rgb}", fill_opacity: "{node_alpha:.2}",
                        for (nx, ny, nr) in node_pts {
                            circle {
                                cx: "{nx:.1}",
                                cy: "{ny:.1}",
                                r: "{nr:.2}",
                            }
                        }
                    }
                }
            }

            div { class: "auth-shell-scrim", "aria-hidden": "true", "data-aeon-part": "scrim" }
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
    app_machine: AeonMachineHandle<AppMachine>,
    mut snapshot: Signal<WalletSnapshot>,
    mut fiat_code: Signal<FiatCode>,
    mut fresh_mnemonic: Signal<Option<String>>,
    mut toast: Signal<Option<ToastNotice>>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();

    let unlock_chart = use_aeon_machine::<UnlockMachine>();
    let mut error_msg = use_signal(|| Option::<String>::None);
    let mut password = use_signal(String::new);
    let handle = use_signal(String::new);
    let mut mnemonic_input = use_signal(String::new);
    let mut shares_input = use_signal(String::new);
    let mut root_key_input = use_signal(String::new);
    let mut restore_role = use_signal(RestoreRole::default);
    let mut offer_restore_on_lock = use_signal(|| false);
    let passphrase_input = use_signal(String::new);
    let scheme = use_signal(|| "brc157".to_string());
    let chain = use_signal(|| "main".to_string());
    let mut pending_onboard = use_signal(|| Option::<PendingOnboard>::None);
    let mut phrase_copied = use_signal(|| false);
    let mut backup_kind = use_signal(|| "phrase");
    let mut onboard_shares = use_signal(|| Option::<Brc140IssuedSet>::None);
    let mut saved_slices = use_signal(BTreeSet::<usize>::new);
    let mut accept_choice = use_signal(|| AcceptedCoins::Bitcoin);
    let mut protect_mode = use_signal(|| {
        if services.os_key_storage_available() {
            "none".to_string()
        } else {
            "password".to_string()
        }
    });
    let mut protect_pw = use_signal(String::new);
    let mut protect_confirm = use_signal(String::new);
    let mut protect_error = use_signal(|| Option::<String>::None);

    // ── Post-create / post-restore onboarding steps (`src/components/AuthScreen.tsx` lines 817-895) ──
    if let Some(pending) = pending_onboard.read().clone() {
        match pending.step {
            OnboardStep::History => {
                let p_next = pending.clone();
                let p_skip = pending.clone();
                let svc_hist = Arc::clone(&services);
                let local_snaps = services.list_local_brc39_archive();
                let has_local_snap = local_snaps.first().cloned();
                let has_snap = has_local_snap.is_some();
                let snap_state = if has_snap { "ready" } else { "missing" };
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "history-recovery",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "history-recovery",
                            "data-aeon-state": snap_state,
                            h2 { "Restore your history" }
                            p { class: "auth-lede",
                                "Keys are on this device. Activity, UTXOs, friends, and peer apps live in your encrypted history backup — sealed to this wallet’s key, not your unlock password."
                            }
                            if let Some(ref snap_meta) = has_local_snap {
                                p { class: "auth-lede", role: "status",
                                    "Found an on-device history snapshot ({snap_meta.bytes / 1024} KB). Restore it now or choose a backup file."
                                }
                            } else {
                                p { class: "auth-lede", role: "status",
                                    "Choose a .brc39 or .json history backup file if you saved one, or enter with a chain scan and check Settings → History later."
                                }
                            }
                            div {
                                class: "auth-actions",
                                style: "display: flex; gap: 8px; flex-wrap: wrap;",
                                "data-aeon-part": "history-recovery-actions",
                                "data-aeon-state": snap_state,
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary primary",
                                    onclick: move |_| {
                                        if let Some(ref meta) = has_local_snap {
                                            let msg = match svc_hist.restore_local_brc39_snapshot(&meta.id, None) {
                                                Ok(msg) => msg,
                                                Err(e) => {
                                                    toast.set(Some(ToastNotice { title: "Restore failed".into(), body: Some(e), tone: "error" }));
                                                    return;
                                                }
                                            };
                                            {
                                                snapshot.set(svc_hist.read_snapshot());
                                                toast.set(Some(ToastNotice {
                                                    title: "History restored".into(),
                                                    body: Some(msg),
                                                    tone: "success",
                                                }));
                                            }
                                        } else if let Some(path) = rfd::FileDialog::new()
                                            .add_filter("HandCash History Backup", &["brc39", "json"])
                                            .pick_file()
                                        {
                                            let bytes = match std::fs::read(&path) {
                                                Ok(bytes) => bytes,
                                                Err(e) => {
                                                    toast.set(Some(ToastNotice { title: "Couldn’t read backup".into(), body: Some(e.to_string()), tone: "error" }));
                                                    return;
                                                }
                                            };
                                            {
                                                match svc_hist.restore_brc39_backup_bytes(&bytes, None) {
                                                    Ok(msg) => {
                                                        snapshot.set(svc_hist.read_snapshot());
                                                        toast.set(Some(ToastNotice {
                                                            title: "History restored".into(),
                                                            body: Some(msg),
                                                            tone: "success",
                                                        }));
                                                    }
                                                    Err(e) => {
                                                        toast.set(Some(ToastNotice {
                                                            title: "Restore failed".into(),
                                                            body: Some(e),
                                                            tone: "error",
                                                        }));
                                                        return;
                                                    }
                                                }
                                            }
                                        } else {
                                            return;
                                        }
                                        let mut next = p_next.clone();
                                        next.balance_sats = snapshot.read().balance.displayed_sats;
                                        next.step = OnboardStep::Protect;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Restore history" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        let mut next = p_skip.clone();
                                        next.step = OnboardStep::Protect;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Continue without history" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::KeysBackup => {
                let cur_kind = *backup_kind.read();
                let phrase_text = pending.mnemonic.clone().unwrap_or_default();
                let words: Vec<String> = phrase_text
                    .split_whitespace()
                    .map(ToString::to_string)
                    .collect();
                let threshold = onboard_shares
                    .read()
                    .as_ref()
                    .map(|s| s.threshold)
                    .unwrap_or(2);
                let can_confirm = if cur_kind == "split" {
                    saved_slices.read().len() >= threshold
                } else {
                    *phrase_copied.read()
                };
                let svc_confirm = Arc::clone(&services);
                let svc_defer = Arc::clone(&services);
                let svc_slices = Arc::clone(&services);
                let svc_rotate = Arc::clone(&services);
                let p_confirm = pending.clone();
                let p_defer = pending.clone();
                let phrase_for_copy = phrase_text.clone();
                let share_set_opt = onboard_shares.read().clone();
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "keys-backup",
                        div {
                            class: "wallet-setup-config keys-backup",
                            "data-aeon-scope": "create-keys-backup",
                            header { class: "keys-backup-head",
                                h2 { "Save recovery backup" }
                                div { class: "keys-backup-tabs", role: "tablist", aria_label: "Backup kind",
                                    button {
                                        r#type: "button",
                                        role: "tab",
                                        aria_selected: if cur_kind == "phrase" { "true" } else { "false" },
                                        class: if cur_kind == "phrase" {
                                            "btn btn-primary keys-backup-tab"
                                        } else {
                                            "btn btn-ghost keys-backup-tab"
                                        },
                                        onclick: move |_| {
                                            backup_kind.set("phrase");
                                            onboard_shares.set(None);
                                            saved_slices.set(BTreeSet::new());
                                        },
                                        "Phrase"
                                    }
                                    button {
                                        r#type: "button",
                                        role: "tab",
                                        aria_selected: if cur_kind == "split" { "true" } else { "false" },
                                        class: if cur_kind == "split" {
                                            "btn btn-primary keys-backup-tab"
                                        } else {
                                            "btn btn-ghost keys-backup-tab"
                                        },
                                        onclick: move |_| {
                                            match svc_slices.load_or_issue_brc140_set() {
                                                Ok(set) => {
                                                    saved_slices.set(BTreeSet::new());
                                                    onboard_shares.set(Some(set));
                                                    backup_kind.set("split");
                                                }
                                                Err(e) => toast.set(Some(ToastNotice {
                                                    title: "Couldn’t prepare slices".into(),
                                                    body: Some(e),
                                                    tone: "error",
                                                })),
                                            }
                                        },
                                        "Key slices"
                                    }
                                }
                            }
                            div { class: "keys-backup-body", "data-aeon-scroll": "hover",
                                if cur_kind == "phrase" {
                                    div { class: "split-backup-shares",
                                        ol {
                                            class: "recovery-phrase-grid",
                                            "data-words": "{words.len()}",
                                            for (i, word) in words.iter().enumerate() {
                                                li { key: "{i}-{word}",
                                                    span { class: "recovery-phrase-index", "{i + 1}" }
                                                    span { class: "recovery-phrase-word", "{word}" }
                                                }
                                            }
                                        }
                                    }
                                } else if let Some(set) = share_set_opt {
                                    div { class: "split-backup-shares",
                                        KeySliceList {
                                            set,
                                            saved_indices: saved_slices,
                                            toast,
                                            on_rotate: move |_| {
                                                match svc_rotate.rotate_brc140_set() {
                                                    Ok(next_set) => {
                                                        saved_slices.set(BTreeSet::new());
                                                        onboard_shares.set(Some(next_set));
                                                        toast.set(Some(ToastNotice {
                                                            title: "New slice set".into(),
                                                            body: Some("Slices from the previous set will not combine with these.".into()),
                                                            tone: "success",
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
                                    }
                                }
                            }
                            footer { class: "keys-backup-foot",
                                if cur_kind == "phrase" {
                                    button::Root {
                                        variant: button::ButtonVariant::Ghost,
                                        class: "btn btn-ghost",
                                        onclick: move |_| {
                                            if let Err(e) = crate::state::copy_to_clipboard(&phrase_for_copy) {
                                                toast.set(Some(ToastNotice { title: "Copy failed".into(), body: Some(e), tone: "error" }));
                                                return;
                                            }
                                            toast.set(Some(ToastNotice {
                                                title: "Copied".into(),
                                                body: Some("Phrase copied to clipboard.".into()),
                                                tone: "success",
                                            }));
                                            phrase_copied.set(true);
                                        },
                                        button::Label { "Copy phrase" }
                                    }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary",
                                    disabled: !can_confirm,
                                    onclick: move |_| {
                                        if !svc_confirm.mark_keys_backup_confirmed(cur_kind) {
                                            toast.set(Some(ToastNotice { title: "Couldn’t save backup confirmation".into(), body: None, tone: "error" }));
                                            return;
                                        }
                                        toast.set(Some(ToastNotice {
                                            title: "Recovery backup saved".into(),
                                            body: None,
                                            tone: "success",
                                        }));
                                        let mut next = p_confirm.clone();
                                        next.step = OnboardStep::Accept;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "I’ve saved it — continue" }
                                }
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    "data-aeon-part": "backup-later",
                                    onclick: move |_| {
                                        svc_defer.mark_keys_backup_deferred();
                                        let mut next = p_defer.clone();
                                        next.step = OnboardStep::Accept;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "I’ll do this later" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::Accept => {
                let choice = *accept_choice.read();
                let svc_accept = Arc::clone(&services);
                let p_accept = pending.clone();
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "accept",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "onboard-accept",
                            "data-aeon-state": choice.as_str(),
                            h2 { "What do you want to accept?" }
                            p { class: "auth-lede",
                                "Just Bitcoin SV is the default. You can change this later in Settings."
                            }
                            div {
                                class: "wallet-setup-options onboard-accept-options",
                                role: "radiogroup",
                                aria_label: "Accept",
                                for opt in AcceptedCoins::CHOICES {
                                    {
                                        let active = choice == opt;
                                        let cls = if active {
                                            "wallet-setup-option onboard-accept-option is-selected"
                                        } else {
                                            "wallet-setup-option onboard-accept-option"
                                        };
                                        let coins: &[&str] = match opt {
                                            AcceptedCoins::Bitcoin => &["bsv"],
                                            AcceptedCoins::All => ACCEPT_ALL_COINS,
                                        };
                                        let svc_opt = Arc::clone(&svc_accept);
                                        rsx! {
                                            label { key: "{opt.as_str()}", class: "{cls}",
                                                input {
                                                    r#type: "radio",
                                                    name: "onboard-accept",
                                                    value: opt.as_str(),
                                                    checked: active,
                                                    onchange: move |_| {
                                                        accept_choice.set(opt);
                                                        svc_opt.save_accepted_coins(opt);
                                                    },
                                                }
                                                span { class: "onboard-accept-icons", aria_hidden: "true",
                                                    for coin in coins.iter().copied() {
                                                        span {
                                                            key: "{coin}",
                                                            class: "onboard-accept-icon",
                                                            "data-coin": "{coin}",
                                                            TickerCoinMark { coin, size: 28 }
                                                        }
                                                    }
                                                }
                                                span { class: "wallet-setup-option-body",
                                                    strong { "{opt.title()}" }
                                                    span { "{opt.description()}" }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            div {
                                class: "auth-actions",
                                style: "margin-top: 16px;",
                                "data-aeon-part": "onboard-accept-actions",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary auth-submit",
                                    onclick: move |_| {
                                        services.save_accepted_coins(*accept_choice.read());
                                        let mut next = p_accept.clone();
                                        next.step = OnboardStep::Fiat;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Continue" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::Fiat => {
                let current_fiat = *fiat_code.read();
                let svc_fiat = Arc::clone(&services);
                let p_fiat = pending.clone();
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "fiat",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "onboard-fiat",
                            "data-aeon-state": current_fiat.as_str(),
                            h2 { "Show balances in" }
                            p { class: "auth-lede",
                                "Government currency for totals on the home screen. You can change this anytime from Activity."
                            }
                            div {
                                class: "onboard-fiat-options",
                                role: "listbox",
                                aria_label: "Government currency",
                                "data-aeon-part": "fiat",
                                for code in FiatCode::ALL {
                                    {
                                        let selected = code == current_fiat;
                                        let state_attr = if selected { "selected" } else { "idle" };
                                        let svc_pick = Arc::clone(&svc_fiat);
                                        rsx! {
                                            button {
                                                key: "{code.as_str()}",
                                                r#type: "button",
                                                role: "option",
                                                class: "onboard-fiat-option",
                                                aria_selected: if selected { "true" } else { "false" },
                                                aria_label: "{code.iso()} — {code.name()}",
                                                "data-aeon-state": state_attr,
                                                onclick: move |_| {
                                                    fiat_code.set(code);
                                                    svc_pick.save_fiat_currency(code);
                                                },
                                                span { class: "onboard-fiat-flag", aria_hidden: "true", "{code.flag()}" }
                                                span { class: "onboard-fiat-iso", "{code.iso()}" }
                                            }
                                        }
                                    }
                                }
                            }
                            div {
                                class: "auth-actions",
                                style: "margin-top: 16px;",
                                "data-aeon-part": "onboard-fiat-actions",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary auth-submit",
                                    onclick: move |_| {
                                        let mut next = p_fiat.clone();
                                        next.step = OnboardStep::Protect;
                                        pending_onboard.set(Some(next));
                                    },
                                    button::Label { "Continue" }
                                }
                            }
                        }
                    }
                };
            }
            OnboardStep::Protect => {
                let none_allowed = services.os_key_storage_available();
                let cur_mode = protect_mode.read().clone();
                let needs_password = cur_mode == "password" || cur_mode == "both";
                let svc_protect = Arc::clone(&services);
                let p_protect = pending.clone();
                let options: [(&str, &str, &str, bool); 4] = [
                    (
                        "none",
                        "None",
                        "Open this wallet on this computer without a prompt.",
                        false,
                    ),
                    (
                        "password",
                        "Password",
                        "Unlock with a HandCash password you choose.",
                        false,
                    ),
                    (
                        "device",
                        "Touch ID",
                        "Unlock with this device’s fingerprint or lock screen.",
                        true,
                    ),
                    (
                        "both",
                        "Password + Touch ID",
                        "Either your password or this device can unlock.",
                        true,
                    ),
                ];
                return rsx! {
                    section {
                        class: "auth-screen",
                        "data-aeon-scope": "auth",
                        "data-aeon-state": "protect",
                        div {
                            class: "wallet-setup-config",
                            "data-aeon-scope": "onboard-protect",
                            h2 { "Protect this device" }
                            p { class: "auth-lede",
                                "Choose how HandCash unlocks on this computer. You can change this later in Settings."
                            }
                            div {
                                class: "wallet-setup-options",
                                role: "radiogroup",
                                aria_label: "Device lock",
                                for (id, title, desc, needs_device) in options {
                                    {
                                        let no_keystore = id == "none" && !none_allowed;
                                        let disabled = needs_device || no_keystore;
                                        let active = cur_mode == id;
                                        let cls = match (active, disabled) {
                                            (true, true) => "wallet-setup-option is-selected is-disabled",
                                            (true, false) => "wallet-setup-option is-selected",
                                            (false, true) => "wallet-setup-option is-disabled",
                                            (false, false) => "wallet-setup-option",
                                        };
                                        let sub = if no_keystore {
                                            NO_KEYSTORE_TEXT
                                        } else if disabled {
                                            "Touch ID is not available on this device"
                                        } else {
                                            desc
                                        };
                                        let id_owned = id.to_string();
                                        rsx! {
                                            label { key: "{id}", class: "{cls}",
                                                input {
                                                    r#type: "radio",
                                                    name: "onboard-lock",
                                                    value: "{id}",
                                                    checked: active,
                                                    disabled: disabled,
                                                    onchange: move |_| {
                                                        if !disabled {
                                                            protect_error.set(None);
                                                            protect_mode.set(id_owned.clone());
                                                        }
                                                    },
                                                }
                                                span { class: "wallet-setup-option-body",
                                                    strong { "{title}" }
                                                    span { "{sub}" }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if needs_password {
                                div { class: "auth-form", style: "margin-top: 8px;",
                                    PasswordField {
                                        id: "onboard-lock-password",
                                        label: "HandCash password",
                                        placeholder: "10+ chars, letter and number",
                                        value: protect_pw,
                                    }
                                    p { class: "password-hint",
                                        "This password unlocks the wallet on this device. Don’t forget it."
                                    }
                                    PasswordField {
                                        id: "onboard-lock-password-confirm",
                                        label: "Confirm password",
                                        placeholder: "Type it again",
                                        value: protect_confirm,
                                    }
                                }
                            }
                            if let Some(ref err) = *protect_error.read() {
                                p { class: "error auth-error", role: "alert", "{err}" }
                            }
                            div {
                                class: "auth-actions",
                                style: "margin-top: 16px;",
                                "data-aeon-part": "onboard-protect-actions",
                                "data-aeon-state": "idle",
                                button::Root {
                                    variant: button::ButtonVariant::Solid,
                                    class: "btn btn-primary auth-submit",
                                    onclick: move |_| {
                                        protect_error.set(None);
                                        let m = protect_mode.read().clone();
                                        let pw = protect_pw.read().clone();
                                        let cpw = protect_confirm.read().clone();
                                        if (m == "password" || m == "both") && pw != cpw {
                                            protect_error.set(Some("Passwords do not match".into()));
                                            return;
                                        }
                                        let user_pw = if m == "password" || m == "both" {
                                            Some(pw.as_str())
                                        } else {
                                            None
                                        };
                                        match svc_protect.apply_onboard_lock(
                                            &p_protect.wrap_password,
                                            &m,
                                            user_pw,
                                        ) {
                                            Ok(()) => {
                                                protect_pw.set(String::new());
                                                protect_confirm.set(String::new());
                                                let sum = p_protect.profile.clone();
                                                let sats = p_protect.balance_sats;
                                                let is_create = p_protect.is_create;
                                                pending_onboard.set(None);
                                                if is_create {
                                                    app_machine.send(AppEvent::Created {
                                                        profile: session_to_wallet_profile(&sum),
                                                        balance_sats: sats,
                                                    });
                                                } else {
                                                    app_machine.send(AppEvent::Unlocked {
                                                        profile: session_to_wallet_profile(&sum),
                                                        balance_sats: sats,
                                                    });
                                                }
                                            }
                                            Err(e) => {
                                                protect_error.set(Some(e));
                                            }
                                        }
                                    },
                                    button::Label { "Continue" }
                                }
                            }
                        }
                    }
                };
            }
        }
    }

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
                            auth_mode.set(AuthFormMode::Signin);
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
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "auth-alt-link",
                        "data-aeon-part": "migrate",
                        onclick: move |_| {
                            error_msg.set(None);
                            auth_mode.set(AuthFormMode::Create);
                        },
                        button::Label { "Recover an old HandCash wallet" }
                    }
                }
                p {
                    aria_live: "polite",
                    class: "auth-entry-tagline is-in",
                    "data-aeon-part": "entry-tagline",
                    "{tagline}"
                }
            }
        };
    }

    // ── DeviceSignInPanel (`src/components/DeviceSignInPanel.tsx`) ──
    if !is_locked && mode == AuthFormMode::Signin {
        let svc_signed_in = Arc::clone(&services);
        return rsx! {
            section {
                class: "auth-screen",
                "data-aeon-scope": "auth",
                "data-aeon-state": "signin",
                DeviceSignInPanel {
                    on_signed_in: move |(sum, wrap_pw): (SessionSummary, String)| {
                        unlock_chart.send(UnlockEvent::Success);
                        let snap = svc_signed_in.read_snapshot();
                        let sats = snap.balance.displayed_sats;
                        snapshot.set(snap);
                        pending_onboard.set(Some(PendingOnboard {
                            profile: sum,
                            balance_sats: sats,
                            wrap_password: wrap_pw,
                            mnemonic: None,
                            step: OnboardStep::Protect,
                            is_create: false,
                        }));
                    },
                    on_other_ways: move |_| {
                        error_msg.set(None);
                        auth_mode.set(AuthFormMode::Phrase);
                    },
                    on_recovery: move |_| {
                        error_msg.set(None);
                        auth_mode.set(AuthFormMode::Phrase);
                    },
                    on_cancel: move |_| {
                        error_msg.set(None);
                        auth_mode.set(AuthFormMode::Entry);
                    },
                }
            }
        };
    }

    let is_restore = mode.is_restore_method();
    let title = if is_restore {
        "Restore on this device"
    } else if mode == AuthFormMode::Create {
        "Create wallet"
    } else {
        "Welcome back"
    };

    let lede = match mode {
        AuthFormMode::Phrase => {
            "Enter your recovery phrase, 12 or 24 words. Same phrase = same identity on Desktop or Mobile."
        }
        AuthFormMode::Shares => {
            "Paste every BRC-140 key slice you have, one per line. HandCash finds two from the same set."
        }
        AuthFormMode::Key => "Paste your emergency root key (64 hex chars).",
        AuthFormMode::Create => "Your keys stay on this device.",
        AuthFormMode::Unlock | AuthFormMode::Entry | AuthFormMode::Signin => {
            if (services.should_auto_unlock() || services.is_no_device_lock())
                && unlock_chart.state() != MachineUnlockState::Failed
            {
                "Opening your wallet on this device."
            } else if services.has_memorable_password() {
                "Enter your HandCash password to unlock."
            } else {
                "Unlock with this device, or restore from a backup."
            }
        }
    };

    let primary_label = if is_restore {
        "Restore"
    } else if mode == AuthFormMode::Create {
        "Create"
    } else {
        "Unlock"
    };

    let submitting = unlock_chart.state() == MachineUnlockState::Opening;
    let unlock_state_attr = unlock_chart.state_attr();
    let submit_label = if submitting {
        "Working…"
    } else {
        primary_label
    };
    let svc_submit = Arc::clone(&services);
    let shares_found = extract_brc140_shares(&shares_input.read()).len();

    rsx! {
        section {
            class: "auth-screen",
            "data-aeon-scope": "auth",
            "data-aeon-state": "{unlock_state_attr}",

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
                    if unlock_chart.state() == MachineUnlockState::Failed {
                        unlock_chart.send(UnlockEvent::Retry);
                    }
                    let setup_factor = match mode {
                        AuthFormMode::Create => UnlockSetupFactor::Create,
                        AuthFormMode::Phrase | AuthFormMode::Key | AuthFormMode::Shares => {
                            UnlockSetupFactor::Restore
                        }
                        _ => UnlockSetupFactor::Approved,
                    };
                    unlock_chart.send(UnlockEvent::Start {
                        factor: setup_factor,
                        progress: password_progress(),
                    });

                    match mode {
                        AuthFormMode::Unlock | AuthFormMode::Entry | AuthFormMode::Signin => {
                            let pw = password.read().clone();
                            match svc_submit.unlock_with_password(&pw) {
                                Ok(sum) => {
                                    password.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    app_machine.send(AppEvent::Unlocked {
                                        profile: session_to_wallet_profile(&sum),
                                        balance_sats: sats,
                                    });
                                    svc_submit.spawn_sync_identities_from_peers();
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    offer_restore_on_lock.set(true);
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Create => {
                            let h = handle.read().trim().to_string();
                            let c = chain.read().clone();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            match svc_submit.create_vault_onboard(&eff_handle, &c) {
                                Ok((sum, phrase, wrap_pw)) => {
                                    fresh_mnemonic.set(phrase.clone());
                                    phrase_copied.set(false);
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: phrase,
                                        step: OnboardStep::KeysBackup,
                                        is_create: true,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Phrase => {
                            let h = handle.read().trim().to_string();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            let m = mnemonic_input.read().clone();
                            let pass = passphrase_input.read().clone();
                            let c = chain.read().clone();
                            let sch = match scheme.read().as_str() {
                                "brc75" => MnemonicScheme::Brc75,
                                "legacy" => MnemonicScheme::LegacyHd,
                                _ => MnemonicScheme::Brc157,
                            };
                            match svc_submit.restore_vault_onboard(&eff_handle, &m, &pass, &c, sch) {
                                Ok((sum, wrap_pw)) => {
                                    mnemonic_input.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: None,
                                        step: OnboardStep::History,
                                        is_create: false,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Key => {
                            let h = handle.read().trim().to_string();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            let rk = root_key_input.read().clone();
                            let c = chain.read().clone();
                            match svc_submit.restore_vault_root_key_onboard(&eff_handle, &rk, &c) {
                                Ok((sum, wrap_pw)) => {
                                    root_key_input.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: None,
                                        step: OnboardStep::History,
                                        is_create: false,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                        AuthFormMode::Shares => {
                            let h = handle.read().trim().to_string();
                            let eff_handle = if h.is_empty() { "wallet".to_string() } else { h };
                            let raw_shares = shares_input.read().clone();
                            let c = chain.read().clone();
                            match svc_submit.restore_vault_brc140_shares_onboard(
                                &eff_handle,
                                &raw_shares,
                                &c,
                            ) {
                                Ok((sum, wrap_pw)) => {
                                    shares_input.set(String::new());
                                    unlock_chart.send(UnlockEvent::Success);
                                    let snap = svc_submit.read_snapshot();
                                    let sats = snap.balance.displayed_sats;
                                    snapshot.set(snap);
                                    pending_onboard.set(Some(PendingOnboard {
                                        profile: sum,
                                        balance_sats: sats,
                                        wrap_password: wrap_pw,
                                        mnemonic: None,
                                        step: OnboardStep::History,
                                        is_create: false,
                                    }));
                                }
                                Err(err) => {
                                    unlock_chart.send(UnlockEvent::Fail {
                                        error: err.clone(),
                                        cancelled: false,
                                        blocked: false,
                                    });
                                    error_msg.set(Some(err));
                                }
                            }
                        }
                    }
                },

                // Mode switch on locked screen (Unlock / Restore)
                if is_locked && (*offer_restore_on_lock.read() || is_restore) {
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
                            "data-aeon-state": if is_restore { "selected" } else { "idle" },
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Phrase);
                            },
                            "Restore"
                        }
                    }
                }

                // Restore method tabs (`Phrase | Key slices | Emergency key`)
                if is_restore {
                    div { class: "auth-mode-switch", role: "tablist", aria_label: "Restore method",
                        for (m_id, m_label) in AuthFormMode::RESTORE_METHODS {
                            button {
                                key: "{m_label}",
                                r#type: "button",
                                role: "tab",
                                aria_selected: if mode == m_id { "true" } else { "false" },
                                class: "auth-mode-tab",
                                "data-aeon-state": if mode == m_id { "selected" } else { "idle" },
                                onclick: move |_| {
                                    error_msg.set(None);
                                    auth_mode.set(m_id);
                                },
                                "{m_label}"
                            }
                        }
                    }
                }

                // Recovery phrase field
                if mode == AuthFormMode::Phrase {
                    field::Root { class: "field",
                        field::Label { r#for: "mnemonic", "Recovery phrase" }
                        textarea {
                            id: "mnemonic",
                            rows: "3",
                            "data-aeon-part": "textarea",
                            placeholder: "12 or 24 words separated by spaces",
                            value: "{mnemonic_input}",
                            oninput: move |e| mnemonic_input.set(e.value()),
                        }
                    }
                }

                // Key slices field
                if mode == AuthFormMode::Shares {
                    field::Root { class: "field",
                        field::Label { "BRC-140 key slices" }
                        textarea {
                            id: "shares",
                            rows: "5",
                            placeholder: "x.y.2.integrity\nx.y.2.integrity",
                            value: "{shares_input}",
                            oninput: move |e| shares_input.set(e.value()),
                        }
                        p { class: "field-hint", "data-aeon-part": "shares-count",
                            if shares_found == 0 {
                                "Slices from different sets of one wallet will not combine — add every one you saved."
                            } else if shares_found == 1 {
                                "1 slice found"
                            } else {
                                "{shares_found} slices found"
                            }
                        }
                    }
                }

                // Emergency root key field
                if mode == AuthFormMode::Key {
                    field::Root { class: "field",
                        field::Label { "Emergency root key" }
                        textarea {
                            id: "root-key",
                            rows: "2",
                            placeholder: "64 hex characters",
                            value: "{root_key_input}",
                            oninput: move |e| root_key_input.set(e.value()),
                        }
                    }
                }

                // Restore role radio group (`Replace old device` | `Keep both`)
                if is_restore {
                    div { class: "field", "data-aeon-part": "restore-role",
                        div { class: "auth-mode-switch", role: "radiogroup", aria_label: "Your other device",
                            for (r_id, r_label, _) in RestoreRole::ALL {
                                button {
                                    key: "{r_label}",
                                    r#type: "button",
                                    role: "radio",
                                    aria_checked: if *restore_role.read() == r_id { "true" } else { "false" },
                                    class: "auth-mode-tab",
                                    "data-aeon-state": if *restore_role.read() == r_id { "selected" } else { "idle" },
                                    onclick: move |_| restore_role.set(r_id),
                                    "{r_label}"
                                }
                            }
                        }
                        p { class: "field-hint",
                            {
                                let cur = *restore_role.read();
                                RestoreRole::ALL
                                    .iter()
                                    .find(|(id, _, _)| *id == cur)
                                    .map(|(_, _, hint)| *hint)
                                    .unwrap_or("")
                            }
                        }
                    }
                }

                // Password field on Unlock (only when memorable password lock is active)
                if mode == AuthFormMode::Unlock && services.has_memorable_password() {
                    PasswordField {
                        id: "password",
                        label: "HandCash password",
                        placeholder: "Your password",
                        value: password,
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
                    "data-aeon-state": "{unlock_state_attr}",
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
                                auth_mode.set(AuthFormMode::Signin);
                            },
                            "Sign in"
                        }
                    }
                }

                if !is_locked && is_restore {
                    p { class: "auth-alt",
                        button {
                            r#type: "button",
                            class: "auth-alt-link",
                            onclick: move |_| {
                                error_msg.set(None);
                                auth_mode.set(AuthFormMode::Signin);
                            },
                            "Sign in with email and your device"
                        }
                        " · New here? "
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

                if is_restore {
                    p { class: "auth-lede auth-restore-note",
                        "Next you’ll restore history, then choose how this device unlocks."
                    }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardEntryPanel.tsx` for direct rendering & DOM parity tests.
#[component]
pub fn OnboardEntryPanel(
    on_sign_in: EventHandler<()>,
    on_create: EventHandler<()>,
    on_migrate: EventHandler<()>,
) -> Element {
    let tagline = AUTH_ENTRY_TAGLINES[0];
    rsx! {
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
                    onclick: move |_| on_sign_in.call(()),
                    button::Label { "Sign in" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost auth-entry-secondary",
                    "data-aeon-part": "create",
                    onclick: move |_| on_create.call(()),
                    button::Label { "Create new wallet" }
                }
            }
            p { class: "auth-alt",
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "auth-alt-link",
                    "data-aeon-part": "migrate",
                    onclick: move |_| on_migrate.call(()),
                    button::Label { "Recover an old HandCash wallet" }
                }
            }
            p {
                aria_live: "polite",
                class: "auth-entry-tagline is-in",
                "data-aeon-part": "entry-tagline",
                "{tagline}"
            }
        }
    }
}

/// Standalone `src/components/CreateKeysBackupPanel.tsx`.
#[component]
pub fn CreateKeysBackupPanel(
    mnemonic: String,
    #[props(default)] on_done: Option<EventHandler<()>>,
) -> Element {
    let mut backup_kind = use_signal(|| "phrase");
    let mut phrase_copied = use_signal(|| false);
    let cur_kind = *backup_kind.read();
    let words: Vec<String> = mnemonic.split_whitespace().map(ToString::to_string).collect();
    let can_confirm = *phrase_copied.read();
    let phrase_for_copy = mnemonic.clone();
    rsx! {
        div {
            class: "wallet-setup-config keys-backup",
            "data-aeon-scope": "create-keys-backup",
            header { class: "keys-backup-head",
                h2 { "Save recovery backup" }
                div { class: "keys-backup-tabs", role: "tablist", aria_label: "Backup kind",
                    button {
                        r#type: "button",
                        role: "tab",
                        aria_selected: if cur_kind == "phrase" { "true" } else { "false" },
                        class: if cur_kind == "phrase" { "btn btn-primary keys-backup-tab" } else { "btn btn-ghost keys-backup-tab" },
                        onclick: move |_| backup_kind.set("phrase"),
                        "Phrase"
                    }
                    button {
                        r#type: "button",
                        role: "tab",
                        aria_selected: if cur_kind == "split" { "true" } else { "false" },
                        class: if cur_kind == "split" { "btn btn-primary keys-backup-tab" } else { "btn btn-ghost keys-backup-tab" },
                        onclick: move |_| backup_kind.set("split"),
                        "Key slices"
                    }
                }
            }
            div { class: "keys-backup-body", "data-aeon-scroll": "hover",
                div { class: "split-backup-shares",
                    ol { class: "recovery-phrase-grid", "data-words": "{words.len()}",
                        for (i, word) in words.iter().enumerate() {
                            li { key: "{i}-{word}",
                                span { class: "recovery-phrase-index", "{i + 1}" }
                                span { class: "recovery-phrase-word", "{word}" }
                            }
                        }
                    }
                }
            }
            footer { class: "keys-backup-foot",
                if cur_kind == "phrase" {
                    button::Root {
                        variant: button::ButtonVariant::Ghost,
                        class: "btn btn-ghost",
                        onclick: move |_| {
                            let _ = crate::state::copy_to_clipboard(&phrase_for_copy);
                            phrase_copied.set(true);
                        },
                        button::Label { "Copy phrase" }
                    }
                }
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary",
                    disabled: !can_confirm,
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(());
                        }
                    },
                    button::Label { "I’ve saved it — continue" }
                }
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    "data-aeon-part": "backup-later",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(());
                        }
                    },
                    button::Label { "I’ll do this later" }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardAcceptPanel.tsx`.
#[component]
pub fn OnboardAcceptPanel(
    #[props(default)] initial_choice: Option<AcceptedCoins>,
    #[props(default)] bsv_ready: bool,
    #[props(default)] on_done: Option<EventHandler<AcceptedCoins>>,
) -> Element {
    let mut choice_sig = use_signal(move || initial_choice.unwrap_or(AcceptedCoins::Bitcoin));
    let choice = *choice_sig.read();
    rsx! {
        div {
            class: "wallet-setup-config",
            "data-aeon-scope": "onboard-accept",
            "data-aeon-state": choice.as_str(),
            h2 { "What do you want to accept?" }
            p { class: "auth-lede",
                "Just Bitcoin SV is the default. You can change this later in Settings."
            }
            div {
                class: "wallet-setup-options onboard-accept-options",
                role: "radiogroup",
                aria_label: "Accept",
                for opt in AcceptedCoins::CHOICES {
                    {
                        let active = choice == opt;
                        let cls = if active {
                            "wallet-setup-option onboard-accept-option is-selected"
                        } else {
                            "wallet-setup-option onboard-accept-option"
                        };
                        let coins: &[&str] = match opt {
                            AcceptedCoins::Bitcoin => &["bsv"],
                            AcceptedCoins::All => ACCEPT_ALL_COINS,
                        };
                        rsx! {
                            label { key: "{opt.as_str()}", class: "{cls}",
                                input {
                                    r#type: "radio",
                                    name: "onboard-accept",
                                    value: opt.as_str(),
                                    checked: active,
                                    onchange: move |_| choice_sig.set(opt),
                                }
                                span { class: "onboard-accept-icons", aria_hidden: "true",
                                    for coin in coins.iter().copied() {
                                        span {
                                            key: "{coin}",
                                            class: "onboard-accept-icon",
                                            "data-coin": "{coin}",
                                            if coin == "bsv" {
                                                crate::ui::primitives::DeferredImage {
                                                    src: Some(crate::icons::bsv_logo_png_data_uri().to_string()),
                                                    alt: String::new(),
                                                    ready: bsv_ready,
                                                }
                                            } else {
                                                TickerCoinMark { coin, size: 28 }
                                            }
                                        }
                                    }
                                }
                                span { class: "wallet-setup-option-body",
                                    strong { "{opt.title()}" }
                                    span { "{opt.description()}" }
                                }
                            }
                        }
                    }
                }
            }
            div {
                class: "auth-actions",
                "data-aeon-part": "onboard-accept-actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary auth-submit",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(*choice_sig.read());
                        }
                    },
                    button::Label { "Continue" }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardFiatPanel.tsx`.
#[component]
pub fn OnboardFiatPanel(
    #[props(default = FiatCode::Usd)] initial_fiat: FiatCode,
    #[props(default)] on_done: Option<EventHandler<FiatCode>>,
) -> Element {
    let mut fiat_sig = use_signal(move || initial_fiat);
    let current_fiat = *fiat_sig.read();
    rsx! {
        div {
            class: "wallet-setup-config",
            "data-aeon-scope": "onboard-fiat",
            "data-aeon-state": current_fiat.as_str(),
            h2 { "Show balances in" }
            p { class: "auth-lede",
                "Government currency for totals on the home screen. You can change this anytime from Activity."
            }
            div {
                class: "onboard-fiat-options",
                role: "listbox",
                aria_label: "Government currency",
                "data-aeon-part": "fiat",
                for code in FiatCode::ALL {
                    {
                        let selected = code == current_fiat;
                        rsx! {
                            button {
                                key: "{code.as_str()}",
                                r#type: "button",
                                role: "option",
                                class: "onboard-fiat-option",
                                aria_selected: if selected { "true" } else { "false" },
                                aria_label: "{code.iso()} — {code.name()}",
                                "data-aeon-state": if selected { "selected" } else { "idle" },
                                onclick: move |_| fiat_sig.set(code),
                                span { class: "onboard-fiat-flag", aria_hidden: "true", "{code.flag()}" }
                                span { class: "onboard-fiat-iso", "{code.iso()}" }
                            }
                        }
                    }
                }
            }
            div {
                class: "auth-actions",
                "data-aeon-part": "onboard-fiat-actions",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary auth-submit",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(*fiat_sig.read());
                        }
                    },
                    button::Label { "Continue" }
                }
            }
        }
    }
}

/// Standalone `src/components/OnboardProtectPanel.tsx`.
#[component]
pub fn OnboardProtectPanel(
    #[props(default = true)] none_allowed: bool,
    #[props(default = "none".to_string())] default_mode: String,
    #[props(default)] on_done: Option<EventHandler<String>>,
) -> Element {
    let mut mode_sig = use_signal(move || default_mode);
    let cur_mode = mode_sig.read().clone();
    let options: [(&str, &str, &str, bool); 4] = [
        ("none", "None", "Open this wallet on this computer without a prompt.", false),
        ("password", "Password", "Unlock with a HandCash password you choose.", false),
        ("device", "Touch ID", "Unlock with this device’s fingerprint or lock screen.", true),
        ("both", "Password + Touch ID", "Either your password or this device can unlock.", true),
    ];
    rsx! {
        div {
            class: "wallet-setup-config",
            "data-aeon-scope": "onboard-protect",
            h2 { "Protect this device" }
            p { class: "auth-lede",
                "Choose how HandCash unlocks on this computer. You can change this later in Settings."
            }
            div {
                class: "wallet-setup-options",
                role: "radiogroup",
                aria_label: "Device lock",
                for (id, title, desc, needs_device) in options {
                    {
                        let no_keystore = id == "none" && !none_allowed;
                        let disabled = needs_device || no_keystore;
                        let active = cur_mode == id;
                        let cls = match (active, disabled) {
                            (true, true) => "wallet-setup-option is-selected is-disabled",
                            (true, false) => "wallet-setup-option is-selected",
                            (false, true) => "wallet-setup-option is-disabled",
                            (false, false) => "wallet-setup-option",
                        };
                        let sub = if no_keystore {
                            NO_KEYSTORE_TEXT
                        } else if disabled {
                            "Touch ID is not available on this device"
                        } else {
                            desc
                        };
                        let id_owned = id.to_string();
                        rsx! {
                            label { key: "{id}", class: "{cls}",
                                input {
                                    r#type: "radio",
                                    name: "onboard-lock",
                                    value: "{id}",
                                    checked: active,
                                    disabled: disabled,
                                    onchange: move |_| {
                                        if !disabled {
                                            mode_sig.set(id_owned.clone());
                                        }
                                    },
                                }
                                span { class: "wallet-setup-option-body",
                                    strong { "{title}" }
                                    span { "{sub}" }
                                }
                            }
                        }
                    }
                }
            }
            div {
                class: "auth-actions",
                "data-aeon-part": "onboard-protect-actions",
                "data-aeon-state": "idle",
                button::Root {
                    variant: button::ButtonVariant::Solid,
                    class: "btn btn-primary auth-submit",
                    onclick: move |_| {
                        if let Some(cb) = on_done {
                            cb.call(mode_sig.read().clone());
                        }
                    },
                    button::Label { "Continue" }
                }
            }
        }
    }
}

fn local_device_label() -> String {
    if cfg!(target_os = "macos") {
        "HandCash (macOS)".to_string()
    } else if cfg!(target_os = "windows") {
        "HandCash (Windows)".to_string()
    } else {
        "HandCash (Linux)".to_string()
    }
}

fn start_scan_login_for(services: &Arc<AppServices>) {
    let status = services.brc100.status_snapshot();
    let urls: Vec<String> = status
        .get("devicePeerLanUrls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default();
    let (session_id, _payload, _qr_text) =
        services.scan_login.start_session(urls, local_device_label());
    crate::scan_login::spawn_scan_login_relay(Arc::clone(services), session_id);
}

/// 1:1 port of `src/components/DeviceSignInPanel.tsx`.
#[component]
fn DeviceSignInPanel(
    on_signed_in: EventHandler<(SessionSummary, String)>,
    on_other_ways: EventHandler<()>,
    on_recovery: EventHandler<()>,
    on_cancel: EventHandler<()>,
) -> Element {
    let services = use_context::<Arc<AppServices>>();
    let mut tick = use_hook(|| Signal::new(0u64));
    use_hook(|| {
        start_scan_login_for(&services);
    });
    let svc_drop = Arc::clone(&services);
    use_drop(move || {
        svc_drop.scan_login.end_session();
    });
    let svc_watch = Arc::clone(&services);
    use_future(move || {
        let svc = Arc::clone(&svc_watch);
        async move {
            let mut rx = svc.scan_login.subscribe();
            let initial = rx.borrow_and_update().clone();
            if let crate::scan_login::ScanLoginPhase::Installed {
                summary,
                wrap_password,
            } = initial
            {
                on_signed_in.call((summary, wrap_password));
                return;
            }
            while rx.changed().await.is_ok() {
                let phase = rx.borrow_and_update().clone();
                if let crate::scan_login::ScanLoginPhase::Installed {
                    summary,
                    wrap_password,
                } = phase
                {
                    on_signed_in.call((summary, wrap_password));
                    break;
                }
                let next = tick.peek().wrapping_add(1);
                tick.set(next);
            }
        }
    });

    let _ = tick();
    let phase = services.scan_login.current_phase();
    let state_attr = phase.state_attr();
    let svc_restart = Arc::clone(&services);

    rsx! {
        div {
            class: "auth-copy device-signin",
            "data-aeon-scope": "device-signin",
            "data-aeon-state": "{state_attr}",
            h1 { class: "auth-title", "Sign in" }
            match phase {
                crate::scan_login::ScanLoginPhase::Scan { qr_text, .. } => {
                    let qr_src = crate::scan_login::render_qr_svg_data_uri(&qr_text);
                    let qr_pixels = crate::scan_login::render_qr_image_attr(&qr_text, 200);
                    rsx! {
                        div { class: "scan-login", "data-aeon-part": "scan",
                            p { class: "auth-lede", "Scan with a signed-in device." }
                            img {
                                class: "scan-login-qr",
                                src: "{qr_src}",
                                "aeon-image": qr_pixels,
                                width: "200",
                                height: "200",
                                alt: "Sign-in code for this device",
                                draggable: "false",
                            }
                        }
                        div { class: "actions", "data-aeon-part": "exits",
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| on_cancel.call(()),
                                button::Label { "Back" }
                            }
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| on_other_ways.call(()),
                                button::Label { "Other ways" }
                            }
                        }
                    }
                }
                crate::scan_login::ScanLoginPhase::ScanComparing { code, approver_label } => {
                    let formatted = crate::scan_login::format_comparison_code(&code);
                    rsx! {
                        div { class: "signin-code-block",
                            span { class: "signin-code", "data-aeon-part": "comparison-code", "{formatted}" }
                            p { class: "auth-lede",
                                "Type these numbers on {approver_label} to let it sign this device in. Only {approver_label} can send the wallet, and only after the right numbers. Device names are not verified; check the actual device in front of you. Don’t share these numbers with anyone else."
                            }
                        }
                    }
                }
                crate::scan_login::ScanLoginPhase::ScanConfirmed { approver_label } => {
                    rsx! {
                        status_banner::Root {
                            tone: status_banner::StatusTone::Info,
                            status: Some("confirmed".to_string()),
                            status_banner::Copy {
                                status_banner::Title { "Code accepted by {approver_label}. Receiving your wallet…" }
                            }
                        }
                    }
                }
                crate::scan_login::ScanLoginPhase::Restoring
                | crate::scan_login::ScanLoginPhase::Installed { .. } => {
                    rsx! {
                        status_banner::Root {
                            tone: status_banner::StatusTone::Info,
                            status: Some("restoring".to_string()),
                            status_banner::Copy {
                                status_banner::Title { "Approved. Installing your wallet…" }
                            }
                        }
                    }
                }
                crate::scan_login::ScanLoginPhase::Ended { reason } => {
                    let title = match reason {
                        crate::scan_login::ScanLoginEndReason::Refused => "Your other device refused this sign-in",
                        crate::scan_login::ScanLoginEndReason::Locked => "Too many wrong codes. This sign-in was stopped",
                        crate::scan_login::ScanLoginEndReason::Expired => "Nobody approved this sign-in in time",
                    };
                    let show_recovery = reason == crate::scan_login::ScanLoginEndReason::Expired;
                    rsx! {
                        status_banner::Root {
                            tone: status_banner::StatusTone::Warning,
                            status: Some(reason.as_str().to_string()),
                            status_banner::Copy {
                                status_banner::Title { "{title}" }
                            }
                            status_banner::Actions {
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| {
                                        start_scan_login_for(&svc_restart);
                                        let next = tick.peek().wrapping_add(1);
                                        tick.set(next);
                                    },
                                    button::Label { "Start again" }
                                }
                            }
                        }
                        if show_recovery {
                            div { class: "actions", "data-aeon-part": "recovery",
                                button::Root {
                                    variant: button::ButtonVariant::Ghost,
                                    class: "btn btn-ghost",
                                    onclick: move |_| on_recovery.call(()),
                                    button::Label { "Use recovery phrase" }
                                }
                            }
                        }
                    }
                }
                crate::scan_login::ScanLoginPhase::Error { message } => {
                    rsx! {
                        p { class: "signin-error", role: "alert", "{message}" }
                        div { class: "actions", "data-aeon-part": "exits",
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| {
                                    start_scan_login_for(&svc_restart);
                                    let next = tick.peek().wrapping_add(1);
                                    tick.set(next);
                                },
                                button::Label { "Try again" }
                            }
                            button::Root {
                                variant: button::ButtonVariant::Ghost,
                                class: "btn btn-ghost",
                                onclick: move |_| on_other_ways.call(()),
                                button::Label { "Other ways" }
                            }
                        }
                    }
                }
                crate::scan_login::ScanLoginPhase::Idle => {
                    rsx! {
                        div { class: "scan-login", "data-aeon-part": "scan",
                            p { class: "auth-lede", "Scan with a signed-in device." }
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

/// 1:1 port of `src/components/KeySliceList.tsx`.
#[component]
pub fn KeySliceList(
    set: Brc140IssuedSet,
    mut saved_indices: Signal<BTreeSet<usize>>,
    mut toast: Signal<Option<ToastNotice>>,
    on_rotate: EventHandler<MouseEvent>,
) -> Element {
    let mut open_idx = use_signal(|| Some(0usize));
    let saved_set = saved_indices.read().clone();
    let saved_count = saved_set.len();
    let threshold = set.threshold;
    let total = set.shares.len();
    let complete = saved_count >= threshold;
    let pct = ((saved_count.min(threshold) * 100) / threshold.max(1)).min(100);
    let issued_label = slice_set_label(set.issued_at);

    rsx! {
        div {
            class: "key-slice-list",
            "data-aeon-scope": "key-slice-list",
            "data-aeon-state": if complete { "complete" } else { "pending" },

            div { class: "key-slice-progress-block", "data-aeon-part": "progress",
                div { class: "key-slice-progress-meta",
                    span { class: "key-slice-progress-label",
                        if complete {
                            "Ready — {saved_count} of {total} slices confirmed saved"
                        } else {
                            "{saved_count} of {threshold} required slices confirmed saved"
                        }
                    }
                    span { class: "key-slice-progress-count mono", "{saved_count}/{threshold}" }
                }
                div {
                    class: "key-slice-progress",
                    role: "progressbar",
                    aria_valuenow: "{saved_count.min(threshold)}",
                    aria_valuemin: "0",
                    aria_valuemax: "{threshold}",
                    div { class: "key-slice-progress-track",
                        div {
                            class: "key-slice-progress-range",
                            style: "width: {pct}%;",
                        }
                    }
                }
                p { class: "settings-row-desc",
                    "{issued_label} · Integrity "
                    span { class: "mono", "{set.integrity}" }
                    " · any {threshold} of {total} from this set restore the wallet"
                }
            }

            div { class: "key-slice-accordion",
                for (index, share) in set.shares.iter().enumerate() {
                    {
                        let saved = saved_set.contains(&index);
                        let is_open = *open_idx.read() == Some(index);
                        let destination = BRC140_DESTINATION_HINTS
                            .get(index)
                            .copied()
                            .unwrap_or("Separate account or device");
                        let share_copy = share.clone();
                        let share_save = share.clone();
                        let share_email = share.clone();
                        let integrity_save = set.integrity.clone();
                        let integrity_email = set.integrity.clone();
                        let issued_save = issued_label.clone();
                        let issued_email = issued_label.clone();
                        rsx! {
                            div {
                                key: "{share}",
                                class: "key-slice-item",
                                "data-aeon-state": if saved { "saved" } else { "pending" },
                                button {
                                    r#type: "button",
                                    class: "key-slice-trigger",
                                    aria_expanded: is_open,
                                    onclick: move |_| {
                                        let cur = *open_idx.read();
                                        open_idx.set(if cur == Some(index) { None } else { Some(index) });
                                    },
                                    list_row::Root { class: "key-slice-row",
                                        list_row::Leading { class: "key-slice-leading", "{index + 1}" }
                                        span { class: "key-slice-row-text",
                                            list_row::Label { class: "key-slice-label", "Slice {index + 1}" }
                                            list_row::Description { class: "key-slice-desc", "{destination}" }
                                        }
                                        list_row::Trailing { class: "key-slice-trailing",
                                            span {
                                                class: "key-slice-status",
                                                "data-aeon-state": if saved { "saved" } else { "pending" },
                                                if saved { "Confirmed" } else { "Open" }
                                            }
                                            ExpandMoreIcon { size: 16 }
                                        }
                                    }
                                }
                                if is_open {
                                    div { class: "key-slice-body",
                                        code { class: "mono split-backup-share", "{share}" }
                                        div { class: "actions split-backup-item-actions",
                                            button::Root {
                                                variant: button::ButtonVariant::Solid,
                                                class: "btn btn-primary",
                                                onclick: move |_| {
                                                    let subject = format!("HandCash key slice {} of {total}", index + 1);
                                                    let body = format!(
                                                        "HandCash key slice {}/{total}\nSuggested place: {destination}\nIntegrity: {integrity_email}\n{issued_email}\n\n{share_email}\n\nOnly slices from the same set combine.",
                                                        index + 1
                                                    );
                                                    let mailto = format!(
                                                        "mailto:?subject={}&body={}",
                                                        subject.replace(' ', "%20"),
                                                        body.replace('\n', "%0A").replace(' ', "%20")
                                                    );
                                                    let _ = crate::state::open_external_url(&mailto);
                                                    toast.set(Some(ToastNotice {
                                                        title: "Opened email".into(),
                                                        body: Some(destination.into()),
                                                        tone: "success",
                                                    }));
                                                },
                                                button::Label { "Share this slice" }
                                            }
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost",
                                                onclick: move |_| {
                                                    if crate::state::copy_to_clipboard(&share_copy).is_ok() {
                                                        toast.set(Some(ToastNotice {
                                                            title: "Copied".into(),
                                                            body: Some(destination.into()),
                                                            tone: "success",
                                                        }));
                                                    }
                                                },
                                                button::Label { "Copy" }
                                            }
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: "btn btn-ghost",
                                                onclick: move |_| {
                                                    let fname = share_download_filename(index, total, &integrity_save);
                                                    let content = format!(
                                                        "# {destination}\n# integrity {integrity_save}\n# {issued_save}\n{share_save}\n"
                                                    );
                                                    if let Some(path) = rfd::FileDialog::new()
                                                        .set_file_name(&fname)
                                                        .save_file()
                                                    {
                                                        if std::fs::write(&path, content).is_ok() {
                                                            let mut next = saved_indices.read().clone();
                                                            next.insert(index);
                                                            saved_indices.set(next);
                                                            toast.set(Some(ToastNotice {
                                                                title: format!("Slice {} saved", index + 1),
                                                                body: Some(path.display().to_string()),
                                                                tone: "success",
                                                            }));
                                                        }
                                                    }
                                                },
                                                button::Label { "Save file" }
                                            }
                                        }
                                        div { class: "actions split-backup-item-actions",
                                            button::Root {
                                                variant: button::ButtonVariant::Ghost,
                                                class: if saved { "btn btn-ghost" } else { "btn btn-primary" },
                                                disabled: saved,
                                                onclick: move |_| {
                                                    let mut next = saved_indices.read().clone();
                                                    next.insert(index);
                                                    saved_indices.set(next);
                                                    toast.set(Some(ToastNotice {
                                                        title: format!("Slice {} confirmed", index + 1),
                                                        body: Some("Keep it separate from your other slice.".into()),
                                                        tone: "success",
                                                    }));
                                                },
                                                button::Label {
                                                    if saved { "Saved — confirmed" } else { "I saved this slice" }
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

            div { class: "actions",
                button::Root {
                    variant: button::ButtonVariant::Ghost,
                    class: "btn btn-ghost",
                    title: "Replace this set. Slices from the old set will not combine with the new ones.",
                    onclick: move |evt| on_rotate.call(evt),
                    button::Label { "Replace slice set" }
                }
            }
        }
    }
}
