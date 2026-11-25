// Copyright HandCash. Licensed under the Apache License, Version 2.0.
//! Rust Aeon UI adherence ratchet mirroring `src/machines/aeonAdherence.test.ts`.
//!
//! Enforces:
//! 1. All 62 TypeScript statecharts in `src/machines/machineManifest.ts` exist in `handcash-machines`.
//! 2. Per-file `use_signal(` ceilings across `handcash-app/src/ui/*.rs` never grow (only ratchet down).
//! 3. Migrated UI panels bind directly to `aeon_dioxus::use_aeon_machine` / `handcash_machines`.
//! 4. `StatechartsPanel` SSR renders the live 62-chart catalog.

use dioxus::prelude::*;
use std::path::Path;

/// Per-file `use_signal(` ceilings across `handcash-app/src/ui/*.rs`.
/// Baseline total was 198; drive ceilings strictly downward as panels adopt `use_aeon_machine`.
const UI_USE_SIGNAL_CEILINGS: &[(&str, usize)] = &[
    ("panels.rs", 58), // ratcheted down 62 -> 58 via FiatCurrencyMenuMachine + WipeMachine + SettingsPreferencesMachine
    ("auth.rs", 28), // ratcheted down 29 -> 28 via UnlockMachine
    ("friends.rs", 15),
    ("mod.rs", 14),
    ("apps.rs", 8), // ratcheted down 12 -> 8 via NotesMachine
    ("dashboard.rs", 8),
    ("import.rs", 8),
    ("collectables.rs", 7), // ratcheted down 10 -> 7 via AssetSendMachine + AssetBurnUiMachine
    ("primitives.rs", 7),
    ("permissions.rs", 5),
    ("activity.rs", 4),
    ("send.rs", 4), // ratcheted down 7 -> 4 via SendMachine
    ("collectables_extra.rs", 3),
    ("side.rs", 3),
    ("devices.rs", 2), // ratcheted down 5 -> 2 via DeviceBackupMachine
    ("chrome.rs", 1), // ratcheted down 3 -> 1 via WalletAccountMenuMachine
    ("messages.rs", 1),
    ("platform_extras.rs", 1),
    ("swaps.rs", 1),
    ("app_browser.rs", 0),
];

fn ui_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ui")
}

fn count_use_signals(src: &str) -> usize {
    src.matches("use_signal(").count()
}

#[test]
fn all_62_ts_statecharts_are_present_in_handcash_machines() {
    let migrated = handcash_machines::manifest::migrated_charts();
    assert_eq!(
        migrated.len(),
        handcash_machines::manifest::TS_MANIFEST_IDS.len(),
        "handcash-machines must cover all 62 TS statecharts"
    );
    assert_eq!(migrated.len(), 62);
}

#[test]
fn ui_use_signal_counts_never_exceed_ratchet_ceilings() {
    let dir = ui_dir();
    let mut seen_files = std::collections::BTreeSet::new();
    let mut total = 0usize;
    for &(file, ceiling) in UI_USE_SIGNAL_CEILINGS {
        seen_files.insert(file.to_string());
        let path = dir.join(file);
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        let count = count_use_signals(&raw);
        total += count;
        assert!(
            count <= ceiling,
            "Aeon adherence ratchet regression in ui/{file}: {count} use_signal( calls exceeds ceiling {ceiling}. Move flow state into handcash-machines + use_aeon_machine instead."
        );
    }
    // Any new file under src/ui/*.rs must either stay at 0 use_signal( or be explicitly ratcheted.
    for entry in std::fs::read_dir(&dir).expect("read src/ui") {
        let entry = entry.expect("ui dir entry");
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".rs") && !seen_files.contains(&name) {
            let raw = std::fs::read_to_string(entry.path()).expect("read new ui file");
            let count = count_use_signals(&raw);
            assert_eq!(
                count, 0,
                "New UI file ui/{name} introduced {count} ad-hoc use_signal( calls; drive flow via use_aeon_machine."
            );
        }
    }
    assert!(
        total <= 178,
        "Total UI use_signal( count ({total}) regressed above current ratchet ceiling (178, down from 198 baseline)"
    );
}

#[test]
fn migrated_panels_bind_to_handcash_machines_and_aeon_dioxus() {
    let dir = ui_dir();
    let send_src = std::fs::read_to_string(dir.join("send.rs")).expect("read send.rs");
    assert!(
        send_src.contains("use_aeon_machine::<SendMachine>()"),
        "ui/send.rs must drive SendPanel from handcash_machines::send::SendMachine"
    );
    assert!(
        !send_src.contains("SendStage"),
        "ui/send.rs must not regress to hand-rolled SendStage enum"
    );

    let panels_src = std::fs::read_to_string(dir.join("panels.rs")).expect("read panels.rs");
    assert!(
        panels_src.contains("handcash_machines::manifest::migrated_charts()"),
        "StatechartsPanel must project the live handcash-machines manifest"
    );
    assert!(
        panels_src.contains("use_aeon_machine::<FiatCurrencyMenuMachine>()"),
        "ui/panels.rs must drive SettingsFiatDropdown from FiatCurrencyMenuMachine"
    );
    assert!(
        panels_src.contains("use_aeon_machine::<WipeMachine>()"),
        "ui/panels.rs must drive WipeWalletPanel from WipeMachine"
    );
    assert!(
        panels_src.contains("use_aeon_machine::<SettingsPreferencesMachine>()"),
        "ui/panels.rs must drive SettingsPanel preferences from SettingsPreferencesMachine"
    );

    let auth_src = std::fs::read_to_string(dir.join("auth.rs")).expect("read auth.rs");
    assert!(
        auth_src.contains("use_aeon_machine::<UnlockMachine>()"),
        "ui/auth.rs must drive AuthScreen from handcash_machines::unlock::UnlockMachine"
    );
    let machines_src = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/machines.rs"))
        .expect("read src/machines.rs");
    assert!(
        !machines_src.contains("pub enum UnlockState"),
        "src/machines.rs must not reintroduce hand-rolled UnlockState enum"
    );

    let chrome_src = std::fs::read_to_string(dir.join("chrome.rs")).expect("read chrome.rs");
    assert!(
        chrome_src.contains("use_aeon_machine::<WalletAccountMenuMachine>()"),
        "ui/chrome.rs must drive WalletAccountMenu from WalletAccountMenuMachine"
    );

    let devices_src = std::fs::read_to_string(dir.join("devices.rs")).expect("read devices.rs");
    assert!(
        devices_src.contains("use_aeon_machine::<DeviceBackupMachine>()"),
        "ui/devices.rs must drive PairDevicePanel from DeviceBackupMachine"
    );

    let apps_src = std::fs::read_to_string(dir.join("apps.rs")).expect("read apps.rs");
    assert!(
        apps_src.contains("use_aeon_machine::<NotesMachine>()"),
        "ui/apps.rs must drive NotesPanel from NotesMachine"
    );

    let collectables_src =
        std::fs::read_to_string(dir.join("collectables.rs")).expect("read collectables.rs");
    assert!(
        collectables_src.contains("use_aeon_machine::<AssetSendMachine>()"),
        "ui/collectables.rs must drive SendCollectablePanel from AssetSendMachine"
    );
    assert!(
        collectables_src.contains("use_aeon_machine::<AssetBurnUiMachine>()"),
        "ui/collectables.rs must drive BurnAssetPanel from AssetBurnUiMachine"
    );
}

#[test]
fn statecharts_panel_ssr_renders_all_62_migrated_charts() {
    fn host() -> Element {
        let profile = crate::state::SessionSummary {
            handle: "alice".to_string(),
            chain: "main".to_string(),
            address: "1111111111111111111114oLvT2".to_string(),
            identity_key: format!("02{}", "a".repeat(64)),
            account_id: "acct-0".to_string(),
            account_index: 0,
            toolbox_db_name: "handcash-toolbox-0".to_string(),
            generation: 1,
            has_mnemonic: true,
            derivation: "brc100".to_string(),
        };
        let snap = crate::state::WalletSnapshot::default();
        rsx! {
            crate::ui::panels::StatechartsPanel { profile, snap }
        }
    }
    let mut dom = VirtualDom::new(host);
    dom.rebuild_in_place();
    let html = dioxus_ssr::render(&dom);
    assert!(html.contains("62 / 62"), "expected 62 / 62 badge in StatechartsPanel HTML");
    for id in handcash_machines::manifest::TS_MANIFEST_IDS {
        assert!(
            html.contains(id),
            "StatechartsPanel HTML missing manifest chart id `{id}`"
        );
    }
}
