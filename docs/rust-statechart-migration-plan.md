# Rust Statechart & Unit-Test Migration Plan

**Status:** Active — All **62 / 62** statecharts migrated to `handcash-machines`; UI `use_aeon_machine` wiring & TS unit-test porting in progress  
**Crate:** `native-desktop/crates/handcash-machines` (pure Rust on `aeon-core` + `aeon-primitives::Statechart`)  
**Goal:** Migrate all **62** TypeScript XState statecharts (`src/machines/machineManifest.ts`) to pure Rust without behavioral loss, wire `handcash-app` Dioxus UI directly to `aeon_dioxus::use_aeon_machine`, drive ad hoc `use_signal` flow flags down via an automated Rust Aeon adherence ratchet, and port the **609** TypeScript/Vitest unit test files into the Rust workspace crates.

## Architecture

1. **Zero-loss statechart runtime (`handcash-machines`)**
   - Every statechart implements `aeon_primitives::Statechart` directly (`State`, `Context`, `Event`, `Input`, `ID`, `initial`, `transition`, `state_value`, `state_attr`), so every chart plugs straight into `aeon_dioxus::use_aeon_machine` and `aeon_primitives::Actor`.
   - Every statechart implements `handcash_machines::HandCashChart`:
     - `MANIFEST_ID` — exact key in `src/machines/machineManifest.ts` (enforced by live drift test `ts_manifest_file_matches_const_catalog`).
     - `TOP_LEVEL_STATES` — exact top-level state names matching `machineStateManifest()`.
     - `type Effect` + `step(snapshot, event) -> (Snapshot, Vec<Effect>)` — pure declarative side-effect emission (no hidden I/O inside transitions; tested 1:1 with `EffectActor`).
     - `can(snapshot, &event)` and `is_done(&state)` — exact mirrors of XState `snapshot.can(event)` and `snapshot.status === 'done'`.
2. **UI projection (`handcash-app`)**
   - Replace hand-rolled enums (`SendStage`, `UnlockState`, `AppSessionMachine`, etc.) and ad hoc `use_signal` flow booleans with `use_aeon_machine::<M>()` and `data-aeon-state: machine.state_attr()`.
   - Automated `native-desktop/crates/handcash-app/src/aeon_adherence.rs` test ratchets per-file `use_signal` ceilings, enforces `use_aeon_machine` bindings, forbids reintroducing deleted hand-rolled enums (`SendStage`, `UnlockState`), and SSR-verifies `StatechartsPanel` renders all 62 migrated charts.
3. **Unit test migration (609 TS test files -> Rust workspace)**
   - Every migrated statechart landed with a 1:1 port of its TS `*.test.ts` cases in `handcash-machines` (284 tests across 62 charts).
   - Domain, crypto, storage, engine, component, and feature tests port into their owning crates (`handcash-primitives`, `handcash-bitcoin`, `handcash-storage`, `handcash-net`, `handcash-engine`, `handcash-machines`, `handcash-shell`, `handcash-app`).

---

## Scoreboard

| Metric | Baseline (start) | Current (verified) | Target |
|---|---:|---:|---:|
| Migrated statecharts (`handcash-machines`) | 0 / 62 | **62 / 62 (100%)** | 62 / 62 |
| Rust workspace tests (`cargo test --workspace`) | 193 | **494 (+301)** | full TS parity |
| `handcash-app/src/ui/*.rs` `use_signal(` calls | 198 | **164 (-34)** | ratchet down per wave |
| UI files bound to `use_aeon_machine` | 0 / 20 | **11 / 20 (21 charts wired)** | all flow-bearing UI |
| Hand-rolled enums/machines deleted (`SendStage`, `UnlockState`, `AppSessionMachine`) | 0 | **3 deleted** | 0 hand-rolled enums |

### Per-Crate Rust Test Breakdown (494 total)

| Crate | Tests | Notable TS Ports Landed |
|---|---:|---|
| `handcash-machines` | 284 | All 62 statecharts + `manifest` live TS drift check + `passwordPolicy` + `wipeHistoryGate` + `handleFormat` |
| `handcash-app` | 86 | `aeon_adherence` (4 tests), 31 SSR DOM parity fixtures, `paymentFilters.test.ts`, `burnEconomics.test.ts`, `appBrowserUrl.test.ts`, `health`, `theme`, `css_scope`, `device_peer`, `messagebox` |
| `handcash-shell` | 56 | Host log privacy, sidecar protocol, native shell IPC |
| `handcash-primitives` | 26 | `base58check.test.ts`, `hashes.test.ts`, `coinCrypto.test.ts` (BRC-42 + coin self-keys + low-S DER), `brc140Backup.test.ts`, `hexBinary.test.ts`, `brc39`, `delta_seal`, `vault` |
| `handcash-bitcoin` | 18 | BEEF/AtomicBEEF, BUMP SPV, header PoW, 1Sat `ord`, BRC-150 provenance, BAP/BRC-248 issuer identity, P2PKH signer |
| `handcash-engine` | 16 | `spendVerdict/classify.test.ts`, `layers`, `holdingFreshness`, `spend_pipeline`, `projector`, `scheduler` |
| `handcash-storage` | 6 | SQLite WAL store, BRC-38 export/import, toolbox DB, atomic CAS change allocation |
| `handcash-net` | 2 | Network client & retry tests |

---

## Statechart Catalog (62 / 62 Done in `handcash-machines`)

All 62 statecharts from `src/machines/machineManifest.ts` are ported losslessly into `native-desktop/crates/handcash-machines/src/` with 1:1 tests and verified by `ts_manifest_file_matches_const_catalog`.

### Wave 1 — Core shell, session, auth, status, send, account holding (15 / 15 Done)

| # | Manifest ID | TS Source | Rust Module | UI Wired |
|---|---|---|---|---|
| 1 | `fiatCurrencyMenu` | `src/machines/fiatCurrencyMenuMachine.ts` | `fiat_currency_menu.rs` | Yes (`ui/panels.rs` `SettingsFiatDropdown`) |
| 2 | `settingsPreferences` | `src/machines/settingsPreferencesMachine.ts` | `settings_preferences.rs` | Yes (`ui/panels.rs` `SettingsPanel`) |
| 3 | `actionLifecycle` | `src/machines/actionLifecycleMachine.ts` | `action_lifecycle.rs` | Next (`ui/activity.rs`) |
| 4 | `asyncAction` | `src/machines/asyncActionMachine.ts` | `async_action.rs` | Next (`ui/primitives.rs`, `ui/friends.rs`) |
| 5 | `wipe` | `src/machines/wipeMachine.ts` | `wipe.rs` | Yes (`ui/panels.rs` `WipeWalletPanel`) |
| 6 | `send` | `src/machines/sendMachine.ts` | `send.rs` | Yes (`ui/send.rs` `SendPanel`, `SendStage` deleted) |
| 7 | `accountMove` | `src/wallet/accountMoveMachine.ts` | `account_move.rs` | Ready (TS: used by spend-from-viewed `accountView.ts`, no longer by `walletAccountMenu`) |
| 8 | `walletAccountMenu` | `src/machines/walletAccountMenuMachine.ts` | `wallet_account_menu.rs` | Stale: TS replaced MOVE/MOVE_PHASE/MOVED + `moving` with `VIEW` (view-only, no move on select) on 2026-11-27; re-port needed (`ui/chrome.rs` `WalletAccountMenu`) |
| 9 | `app` | `src/machines/appMachine.ts` | `app.rs` | Yes (`ui/mod.rs` `App`, `AppSessionMachine` deleted) |
| 10 | `unlock` | `src/machines/unlockMachine.ts` | `unlock.rs` | Yes (`ui/auth.rs` `AuthScreen`, `UnlockState` deleted) |
| 11 | `walletStatus` | `src/machines/walletStatusMachine.ts` | `wallet_status.rs` | Yes (`ui/mod.rs` status bar) |
| 12 | `publicIdentities` | `src/machines/publicIdentitiesMachine.ts` | `public_identities.rs` | Yes (`ui/panels.rs` `PublicIdentitiesPanel`) |
| 13 | `walletCoordinator` | `src/wallet/walletCoordinatorMachine.ts` | `wallet_coordinator.rs` | Engine-level |
| 14 | `txLifecycle` | `src/wallet/txLifecycleMachine.ts` | `tx_lifecycle.rs` | Engine-level / `ui/activity.rs` |
| 15 | `authenticity` | `src/wallet/authenticityMachine.ts` | `authenticity.rs` | Next (`ui/collectables.rs`) |

### Wave 2 — Send / Burn / Collectable / Recovery wallet-layer & UI charts (13 / 13 Done)

| # | Manifest ID | TS Source | Rust Module | UI Wired |
|---|---|---|---|---|
| 16 | `bsvSend` | `src/wallet/bsvSendMachine.ts` | `bsv_send.rs` | Engine-level |
| 17 | `brc29Send` | `src/wallet/brc29SendMachine.ts` | `brc29_send.rs` | Engine-level |
| 18 | `itemSend` | `src/wallet/itemSendMachine.ts` | `item_send.rs` | Engine-level |
| 19 | `collectableSend` | `src/wallet/collectableSendMachine.ts` | `collectable_send.rs` | Engine-level |
| 20 | `collectableSendRun` | `src/wallet/collectableSendRunMachine.ts` | `collectable_send_run.rs` | Engine-level |
| 21 | `burn` | `src/wallet/burnMachine.ts` | `burn.rs` | Engine-level |
| 22 | `assetBurnUi` | `src/machines/assetBurnUiMachine.ts` | `asset_burn_ui.rs` | Yes (`ui/collectables.rs` `BurnAssetPanel`) |
| 23 | `assetSend` | `src/machines/assetSendMachine.ts` | `asset_send.rs` | Yes (`ui/collectables.rs` `SendCollectablePanel`) |
| 24 | `serverWalletRecover` | `src/wallet/serverWalletRecoverMachine.ts` | `server_wallet_recover.rs` | Next (`ui/panels.rs`) |
| 25 | `historyRecovery` | `src/machines/historyRecoveryMachine.ts` | `history_recovery.rs` | Next (`ui/auth.rs`, `ui/panels.rs`) |
| 26 | `deviceBackup` | `src/machines/deviceBackupMachine.ts` | `device_backup.rs` | Yes (`ui/devices.rs` `PairDevicePanel`) |
| 27 | `walletJob` | `src/machines/walletJobMachine.ts` | `wallet_job.rs` | Engine-level |
| 28 | `modelViewer` | `src/machines/modelViewerMachine.ts` | `model_viewer.rs` | Next (`ui/collectables.rs`) |

### Wave 3 — Auth, Onboarding, Devices, QR, Permissions, Updates (12 / 12 Done)

| # | Manifest ID | TS Source | Rust Module | UI Wired |
|---|---|---|---|---|
| 29 | `entryMesh` | `src/machines/entryMeshMachine.ts` | `entry_mesh.rs` | Next (`ui/auth.rs`) |
| 30 | `onboardEmail` | `src/machines/onboardEmailMachine.ts` | `onboard_email.rs` | Next (`ui/auth.rs`) |
| 31 | `emailRecovery` | `src/machines/emailRecoveryMachine.ts` | `email_recovery.rs` | Next (`ui/auth.rs`) |
| 32 | `relaySignin` | `src/machines/relaySigninMachine.ts` | `relay_signin.rs` | Next (`ui/auth.rs`) |
| 33 | `pairingCode` | `src/machines/pairingCodeMachine.ts` | `pairing_code.rs` | Yes (`ui/activity.rs` `PairingCodeEntry`) |
| 34 | `qrReveal` | `src/machines/qrRevealMachine.ts` | `qr_reveal.rs` | Next (`ui/devices.rs`, `ui/panels.rs`) |
| 35 | `qrScanner` | `src/machines/qrScannerMachine.ts` | `qr_scanner.rs` | Yes (`ui/devices.rs` `QrScanner`) |
| 36 | `permissionDecision` | `src/machines/permissionDecisionMachine.ts` | `permission_decision.rs` | Yes (`ui/permissions.rs` `PermissionRequestPanel`) |
| 37 | `grantExpiry` | `src/machines/grantExpiryMachine.ts` | `grant_expiry.rs` | Yes (`ui/apps.rs` `AppDetailsPanel`) |
| 38 | `update` | `src/machines/updateMachine.ts` | `update.rs` | Next (`ui/panels.rs`, `ui/platform_extras.rs`) |
| 39 | `devKeysPanel` | `src/machines/devKeysPanelMachine.ts` | `dev_keys_panel.rs` | Yes (`ui/apps.rs` `DevKeysPanel`) |
| 40 | `notes` | `src/machines/notesMachine.ts` | `notes.rs` | Yes (`ui/apps.rs` `NotesPanel`) |

### Wave 4 — Import, Apps, Browser, Calls, Recordings (11 / 11 Done)

| # | Manifest ID | TS Source | Rust Module | UI Wired |
|---|---|---|---|---|
| 41 | `legacyImport` | `src/machines/legacyImportMachine.ts` | `legacy_import.rs` | Yes (`ui/import.rs` `ImportPanel`) |
| 42 | `importItemBrowser` | `src/machines/importItemBrowserMachine.ts` | `import_item_browser.rs` | Next (`ui/import.rs`) |
| 43 | `importQueue` | `src/machines/importQueueMachine.ts` | `import_queue.rs` | Next (`ui/import.rs`) |
| 44 | `importWriteGrant` | `src/machines/importWriteGrantMachine.ts` | `import_write_grant.rs` | Next (`ui/import.rs`) |
| 45 | `appBrowser` | `src/machines/appBrowserMachine.ts` | `app_browser.rs` | Next (`ui/app_browser.rs`) |
| 46 | `appBrowserPage` | `src/machines/appBrowserPageMachine.ts` | `app_browser_page.rs` | Next (`ui/app_browser.rs`) |
| 47 | `appLauncher` | `src/machines/appLauncherMachine.ts` | `app_launcher.rs` | Yes (`ui/apps.rs` `AppsPanel`) |
| 48 | `chartApps` | `src/machines/chartAppsMachine.ts` | `chart_apps.rs` | Yes (`ui/panels.rs` `ChartAppsPanel`) |
| 49 | `call` | `src/machines/callMachine.ts` | `call.rs` | Next (`ui/messages.rs`) |
| 50 | `callView` | `src/machines/callViewMachine.ts` | `call_view.rs` | Next (`ui/messages.rs`) |
| 51 | `recordingPlayer` | `src/machines/recordingPlayerMachine.ts` | `recording_player.rs` | Next (`ui/platform_extras.rs`) |

### Wave 5 — Market, BNT/IPT, Coins, Swaps, Ticker (11 / 11 Done)

| # | Manifest ID | TS Source | Rust Module | UI Wired |
|---|---|---|---|---|
| 52 | `offer` | `src/machines/offerMachine.ts` | `offer.rs` | Engine / Market |
| 53 | `marketPurchase` | `src/machines/marketPurchaseMachine.ts` | `market_purchase.rs` | Engine / Market |
| 54 | `marketSellerSettlement` | `src/machines/marketSellerSettlementMachine.ts` | `market_seller_settlement.rs` | Engine / Market |
| 55 | `bnt` | `src/machines/bntMachine.ts` | `bnt.rs` | Next (`ui/collectables_extra.rs`) |
| 56 | `bntHoldings` | `src/machines/bntHoldingsMachine.ts` | `bnt_holdings.rs` | Next (`ui/collectables_extra.rs`) |
| 57 | `iptAcceptRequest` | `src/machines/iptAcceptRequestMachine.ts` | `ipt_accept_request.rs` | Next (`ui/collectables_extra.rs`) |
| 58 | `coin` | `src/machines/coinMachine.ts` | `coin.rs` | Next (`ui/side.rs`) |
| 59 | `swap` | `src/machines/swapMachine.ts` | `swap.rs` | Next (`ui/swaps.rs`) |
| 60 | `swapOffers` | `src/machines/swapOffersMachine.ts` | `swap_offers.rs` | Next (`ui/swaps.rs`) |
| 61 | `swapSettle` | `src/machines/swapSettleMachine.ts` | `swap_settle.rs` | Next (`ui/swaps.rs`) |
| 62 | `ticker` | `src/machines/tickerMachine.ts` | `ticker.rs` | Next (`ui/dashboard.rs`) |

---

## UI `use_signal` & Aeon Adherence Ratchet (`handcash-app/src/ui/*.rs`)

Enforced automatically by `handcash-app/src/aeon_adherence.rs` (`cargo test -p handcash-app aeon_adherence`). Ceilings strictly decrease as panels adopt `aeon_dioxus::use_aeon_machine::<M>()`:

| File | Baseline | Current Ceiling | Wired Charts | Remaining Target Charts |
|---|---:|---:|---|---|
| `ui/panels.rs` | 62 | **51** | `FiatCurrencyMenuMachine`, `WipeMachine`, `SettingsPreferencesMachine`, `PublicIdentitiesMachine`, `ChartAppsMachine` | `HistoryRecoveryMachine`, `UpdateMachine`, `AsyncActionMachine` |
| `ui/auth.rs` | 29 | **28** | `UnlockMachine` (`UnlockState` deleted) | `EntryMeshMachine`, `OnboardEmailMachine`, `EmailRecoveryMachine`, `RelaySigninMachine`, `HistoryRecoveryMachine` |
| `ui/friends.rs` | 15 | 15 | — | `AsyncActionMachine` |
| `ui/mod.rs` | 14 | **12** | `AppMachine` (`AppSessionMachine` deleted), `WalletStatusMachine` | `UpdateMachine` |
| `ui/apps.rs` | 12 | **7** | `NotesMachine`, `GrantExpiryMachine`, `AppLauncherMachine`, `DevKeysPanelMachine` | — |
| `ui/collectables.rs` | 10 | **7** | `AssetSendMachine`, `AssetBurnUiMachine` | `CollectableSendMachine`, `AuthenticityMachine`, `ModelViewerMachine` |
| `ui/dashboard.rs` | 8 | 8 | — | `TickerMachine`, `FiatCurrencyMenuMachine` |
| `ui/import.rs` | 8 | **5** | `LegacyImportMachine` | `ImportItemBrowserMachine`, `ImportQueueMachine`, `ImportWriteGrantMachine` |
| `ui/primitives.rs` | 7 | 7 | — | `AsyncActionMachine` |
| `ui/permissions.rs` | 5 | 5 | `PermissionDecisionMachine` | — |
| `ui/activity.rs` | 4 | **3** | `PairingCodeMachine` | `ActionLifecycleMachine`, `TxLifecycleMachine` |
| `ui/send.rs` | 7 | **4** | `SendMachine` (`SendStage` deleted) | — |
| `ui/collectables_extra.rs` | 3 | 3 | — | `BntHoldingsMachine`, `IptAcceptRequestMachine` |
| `ui/side.rs` | 3 | 3 | — | `CoinMachine` |
| `ui/devices.rs` | 5 | **2** | `DeviceBackupMachine`, `QrScannerMachine` | `QrRevealMachine` |
| `ui/chrome.rs` | 3 | **1** | `WalletAccountMenuMachine` | `FiatCurrencyMenuMachine` |
| `ui/messages.rs` | 1 | 1 | — | `CallMachine`, `CallViewMachine` |
| `ui/platform_extras.rs` | 1 | 1 | — | `UpdateMachine`, `RecordingPlayerMachine` |
| `ui/swaps.rs` | 1 | 1 | — | `SwapMachine`, `SwapOffersMachine`, `SwapSettleMachine` |
| `ui/app_browser.rs` | 0 | 0 | — | `AppBrowserMachine`, `AppBrowserPageMachine` |
| **Total** | **198** | **164** | **21 charts wired across 11 files** | **Continue ratcheting per wave** |

---

## TS/JS Unit Test Migration Plan (609 non-live `.test.*` files)

| Group | TS Test Files | Target Rust Crate | Status & Next Wave |
|---|---:|---|---|
| `src/machines/*.test.ts` + `src/wallet/*Machine.test.ts` | 52 | `handcash-machines` | **Done (62/62 charts, 284 tests)** |
| `src/wallet/primitives/*`, `src/wallet/brc*`, vault/keys/crypto | ~85 | `handcash-primitives` | **In progress (Wave T1):** `base58check`, `hashes`, `coinCrypto`, `brc140Backup`, `hexBinary`, `brc39` ported (26 tests); next: `brc140IssuedSet`, `brc29Uri`, `mnemonicDerivation`, `phraseDerivation`, `bsvBoundary` |
| `src/wallet/spendVerdict/*`, `1sat`, BRC-150, BEEF, tx/scripts | ~90 | `handcash-bitcoin` & `handcash-engine` | **In progress (Wave T2):** `spendVerdict/classify`, `burnEconomics`, `issuerIdentity`, `brc150`, `beef`, `bump`, `ord` ported (34 tests); next: `oneSatAuthenticity`, `oneSatProvenance`, `beefSubset`, `chainProofKind`, `burnPlan` |
| `src/wallet/kernel/*`, `src/storage/*`, BRC-38/39, durable/IDB | ~75 | `handcash-storage` & `handcash-engine` | **Wave T3:** `layers`, `holdingFreshness`, WAL/CAS/BRC-38 roundtrip landed; next: `kernel/*` fate tests, `custodyJournal`, `historyEmptyGuard`, `historyReplaceGuard` |
| `src/wallet/directSession/*`, `deviceSignin/*`, `deviceTransfer/*`, `scanLogin/*`, `chainProbe/*`, holding/messagebox | ~95 | `handcash-net` & `handcash-app` | **Wave T4:** `device_peer`, `messagebox`, `logPrivacy` landed; next: `chainProbe/classify`, `accountHolderRecord`, `accountHolding`, `accountRelease`, `directHandover` |
| `src/wallet/import/*`, `bnt/*`, `swap/*`, `coins/*`, `arcUsdc/*`, `ltc/*`, `bch/*`, `btc/*`, `doge/*`, `calls/*`, `marketOffer/*`, `notes/*`, `compute/*` | ~155 | `handcash-engine` / domain crates | **Wave T5:** next after core wallet parity |
| `src/components/*`, `src/features/*`, `src/apps/*`, `src/contracts/*`, `src/perf/*`, `src/meridian/*` | ~57 | `handcash-app` (Dioxus SSR + pure logic) | **In progress (Wave T6):** 31 SSR DOM parity fixtures, `paymentFilters`, `appBrowserUrl`, `handleFormat`, `dependencyHealth`, `aeon_adherence` landed (86 tests); next: component/feature SSR & pure-logic suites |
| **Total** | **609** | **Rust workspace** | **494 passing Rust tests (+301 from 193 baseline)** |

---

## Change Log

- **2026-11-25 (Wave 1–5 Statecharts):** Created `handcash-machines` crate on `aeon-core` + `aeon-primitives::Statechart`, added live 62-chart manifest drift test against `src/machines/machineManifest.ts`, and migrated all **62 / 62** statecharts with 284 unit tests (`StatechartsPanel` SSR verified for all 62).
- **2026-11-25 (UI Wiring Batch 1 + Core Unit Test Ports):** Wired 10 statecharts directly into 7 `handcash-app` UI files via `aeon_dioxus::use_aeon_machine` (`SendMachine`, `UnlockMachine`, `FiatCurrencyMenuMachine`, `WipeMachine`, `SettingsPreferencesMachine`, `WalletAccountMenuMachine`, `DeviceBackupMachine`, `NotesMachine`, `AssetSendMachine`, `AssetBurnUiMachine`), deleted hand-rolled `SendStage` and `UnlockState` enums, ratcheted `aeon_adherence.rs` from 198 -> 178 `use_signal(` calls, and ported `base58check`, `hashes`, `coinCrypto`, `brc140Backup`, `hexBinary`, `paymentFilters`, `appBrowserUrl`, `handleFormat`, `spendVerdict/classify`, and `burnEconomics` TS unit tests (494 workspace tests passing, zero clippy warnings).
- **2026-11-25 (UI Wiring Batch 2):** Wired 11 more statecharts across 8 `handcash-app` UI files (`AppMachine`, `WalletStatusMachine`, `PublicIdentitiesMachine`, `ChartAppsMachine`, `LegacyImportMachine`, `PermissionDecisionMachine`, `GrantExpiryMachine`, `AppLauncherMachine`, `DevKeysPanelMachine`, `PairingCodeMachine`, `QrScannerMachine` — now **21 charts wired across 11 / 20 UI files**), deleted hand-rolled `AppSessionMachine`/`AppSessionState`, and ratcheted `aeon_adherence.rs` ceilings from 178 -> **164** `use_signal(` calls (-34 from 198 baseline).
