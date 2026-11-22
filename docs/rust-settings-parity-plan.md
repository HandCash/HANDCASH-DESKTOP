# Rust Desktop Settings Parity Plan (Slice 5 Remainder)

**Target:** `native-desktop/crates/handcash-app/` (`src/ui/panels.rs`, `src/machines.rs`, `src/state.rs`, plus a dedicated `src/ui/settings/` module split once subpages grow)
**Reference:** `src/components/SettingsPanel.tsx` and `src/components/settings/*`
**Parent task:** `543f8547-6f82-48f7-bd29-eae4dbb8f5c4` (HandCash Desktop fully Rust)

---

## 1. Current State in Rust (`panels.rs`)

### Working today
- **Preferences:** Appearance (`System` / `Dark` / `Light`, persisted via `AppServices::save_appearance`), Accepted coins (`Bitcoin` / `All`, persisted via `save_accepted_coins`), static Version row (`APP_VERSION`, engine phase).
- **Subpages wired:**
  - `Backup` — reveal/copy 24-word mnemonic.
  - `Import` — file picker for BRC-38 JSON into per-account SQLite WAL (`import_brc38_json`).
  - `Unlock` — change vault password (`change_password`).
  - `WalletHealth` — basic counters (spendable UTXOs, 1Sat items, engine phase/gen, HTTP/HTTPS bridge URLs).
  - `About` — static version & description.

### Currently stubbed (`data-aeon-state="unavailable"`)
1. `HandCashRecovery`
2. `HistoryBackup`
3. `DeviceHandoff`
4. `SigninEmail`
5. `WipeWallet`
6. `RecoverTx`
7. `Logs`
8. `ChartApps`
9. `Labs`
10. `Statecharts`

### Missing on the Settings root list
- **Sound** toggle in Preferences (`src/wallet/soundPrefs.ts` / `soundService.ts`) using `aeon_ui::switch`.
- **Live status badges / descriptions** on nav rows (e.g. backup status, update available badge from `native-desktop/src/release_update.rs`, wallet health alert badge).
- **Update check / install control** wired to `ReleaseUpdater` (`native-desktop/src/release_update.rs`).
- **Statecharts** nav row under Support/Labs (currently in `SettingSubpage` enum and `setting_icon`, not listed on the root panel).

---

## 2. Architecture & Invariants (Mandatory)

1. **Chart-first Aeon UI:** Multi-step settings flows (wipe confirmation, history restore/upload, log upload, tx recovery, device handoff) must be driven by explicit state machines in `crates/handcash-app/src/machines.rs` (emitting `data-aeon-state`), not ad-hoc boolean signals.
2. **Shared durable storage keys:** Persist preferences in `native-desktop/src/durable.rs` using the exact `handcash.*` keys from `src/storage/registry.ts` (e.g. `handcash.labs`, `handcash.sound.*`, `handcash.brc100.connectedApps`, history backup config) so existing desktop data stays compatible.
3. **History settings are merge-only:** Settings → History restore merges BRC-39/BRC-38 history; never offer ledger replacement or forced cloud overwrite there. Auto-upload must respect `historyEmptyGuard` semantics and refuse when the account is displaced/held elsewhere.
4. **Logs carry no identity:** Session logs must read from `native-desktop/src/host_log.rs` (already scrubbed by `log_privacy.rs`). Never display or upload unredacted hex IDs, addresses, amounts, handles, or display names.
5. **No fake controls:** Keep any unbacked backend action explicitly marked `data-aeon-state="unavailable"` until its Rust engine/host service is wired and tested.
6. **Module split:** Move `SettingsPanel` and `SettingSubpagePanel` out of `src/ui/panels.rs` into `src/ui/settings/mod.rs` + per-domain submodules (`preferences.rs`, `security.rs`, `support.rs`, `labs.rs`) to keep files readable and testable.

---

## 3. Phased Delivery Plan

### Phase A — Quick Wins (Host/Durable Already Exists)
*No new network protocol work; purely wiring existing Rust host services & durable storage.*

1. **Module extraction (`src/ui/settings/`):**
   - Move `SettingsPanel`, `SettingSubpagePanel`, `SECURITY_ITEMS`, `setting_icon`, `setting_tone` from `src/ui/panels.rs` into `src/ui/settings/mod.rs`.
2. **Preferences parity:**
   - **Sound toggle:** Read/write sound preference in `durable.rs` (matching `src/wallet/soundPrefs.ts`), render with `aeon_ui::switch::Root`.
   - **Release updater row / About:** Wire `ReleaseUpdater` (`native-desktop/src/release_update.rs`) into Settings Version/About so users can check for updates, view status/version, and trigger install/restart.
3. **Labs (`SettingSubpage::Labs`):**
   - Port `src/wallet/labs.ts` flag definitions and `LabsPanel.tsx` toggles backed by `LABS_STORAGE_KEY` in `durable.rs`.
   - Keep all experimental flags off by default.
4. **Session Logs (`SettingSubpage::Logs`):**
   - Read ring buffer / current log file from `native-desktop/src/host_log.rs`.
   - Support View (scrollable mono viewer), Copy (via `copy_to_clipboard`), and scrubbed Upload (matching `.cursor/rules/remote-support-logs.mdc` and `log_privacy.rs`).
5. **Wipe Wallet (`SettingSubpage::WipeWallet`):**
   - Add `WipeWalletMachine` (`Idle` → `Confirming` → `Wiping` → `Done` / `Error`) requiring explicit typed confirmation / password check.
   - Clear vault, per-account SQLite WAL files, and durable keys safely; transition `AppSessionMachine` back to onboarding.
6. **Statecharts (`SettingSubpage::Statecharts`):**
   - Render live inspection of Rust app machines (`AppSessionMachine`, nav/settings state, engine phase/generation, bridge state) analogous to `StatechartsPanel.tsx`.
   - Gate row visibility behind Labs or Support section per TS parity.

### Phase B — Wallet Core & Backup Subpages
*Requires wiring `native-desktop/src/brc39_archive.rs`, `wallet_core`, and `AppServices`.*

7. **History Backup (`SettingSubpage::HistoryBackup`):**
   - Wire `brc39_archive.rs` for manual backup export/upload and **merge-only** restore.
   - Display last backup timestamp, URL/endpoint configuration, and holding/empty-local guard status.
   - Enforce: refuse upload if displaced; refuse auto-overwrite of non-empty remote from empty local.
8. **Recover from Transaction (`SettingSubpage::RecoverTx`):**
   - Port `RecoverFromTxPanel.tsx`: txid input validation (64-hex), chain lookup via Rust chain client, claim/ingest BSV/1Sat/BNT output into local SQLite WAL, refresh `WalletSnapshot`.
9. **Wallet Health (`SettingSubpage::WalletHealth`) expansion:**
   - Add SQLite WAL integrity/size, pending/unbroadcast tx count, last chain ingest timestamp, and BRC-100 bridge self-check actions.
10. **Backup & Unlock polish:**
    - `Backup`: confirm-before-reveal guard + key-slice (Shamir) backup/export if supported by `wallet_core`.
    - `Unlock`: OS keyring / device-lock preference alongside password change.

### Phase C — Multi-Device, Recovery & Chart Apps
*Depends on Rust ports of BRC-246/249 vault link, cloud recovery, and chart-app runtime.*

11. **HandCash Recovery (`SettingSubpage::HandCashRecovery`) & Device Handoff (`SettingSubpage::DeviceHandoff`):**
    - Port QR/link device pairing and vault-link handoff flow once Rust vault-link/holding service lands.
12. **Sign-in Email (`SettingSubpage::SigninEmail`):**
    - Port email registration/verification flow against BRC-CLOUD recovery endpoint (`handcash.signinEmail*` durable keys).
13. **Import (`SettingSubpage::Import`) expansion:**
    - Extend beyond BRC-38 JSON to HandCash legacy/Twetch/Yours/mnemonic/WIF sweep flows once Rust import lanes are ported.
14. **Apps / Chart Apps (`SettingSubpage::ChartApps`):**
    - Wire local single-purpose chart apps runner & list (`CHART_APPS_DESCRIPTION`) once Rust chart-app host exists.

---

## 4. Verification Gates (Per Phase)

Run in `native-desktop/` before committing each phase:
- `cargo check --workspace`
- `cargo test --workspace` (unit tests for each new state machine, durable key round-trip, log scrubbing, and merge-only history guard)
- `cargo clippy --workspace --all-targets -- -D warnings`
- Manual check in the native Dioxus window: theme inheritance, scroll ownership inside `settings-scroll-body`, and no panics when toggling/navigating every subpage.
