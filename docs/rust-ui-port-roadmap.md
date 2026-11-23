# HandCash Desktop — Pure-Rust UI Port Roadmap (`handcash-app`)

**Target crate:** `native-desktop/crates/handcash-app/` (Dioxus Native / Blitz + `aeon-ui 0.4.0` + `HANDCASH_CSS` / `LAYOUT_COMPACT_CSS`).
**Source of truth:** `src/components/` (158 `.tsx` components) & `src/machines/` (XState v5 charts).

---

## Completed Slices

### Slice 0 — Foundation & Real Wallet Data
- Pure-Rust shell + BRC-100 direct handler (`src/brc100_native.rs`).
- Real `toolbox-sqlite/` WAL reader (`ToolboxDb::read_wallet_snapshot`), active sub-account resolution (`handcash.vault-accounts.v1:<masterIdentityKey>` + `handcash.toolbox.dbPointer.*`), and Omarchy/HandCash `--hc-*` theme override parity (`src/theme.rs`).
- Base `AuthShell` / `AuthFlow`, `Dashboard`, `WhatIsBsvPanel`, `ReceivePanel`, `IdentityPanel`, `SettingsPanel` (Backup, Import BRC-38, Unlock/Password, Wallet Health, About).

### Slice 1 — Wallet Chrome, Multi-Account Menu & Full Send/Receive/Activity
- **`src/ui/chrome.rs`**: `FiatCurrencyMenu` (12 fiat currencies persisted to `handcash.brc100.fiatCurrency`), `WalletAccountMenu` (multi-account switcher reading `handcash.vault-accounts.v1:*`, holding status, per-account profile edit jump, **Add wallet** via `create_vault_account`), `WalletActionDock`, `AppToastHost`.
- **`src/ui/send.rs`**: Multi-stage `SendPanel` (`editing.destination` → `editing.amount` → `confirming` / `failure`), `classify_recipient` (P2PKH, `peerpay:`, compressed pubkey, `$handle`), `BSV` / `SATS` toggle, balance guard, fee preview, `WalletActionDock`.
- **`src/ui/activity.rs`**: `ActivityFeed` + `PaymentFiltersPanel` (`Type`, `Status`, `App`, `When`) + `PaymentDetailsPanel` (`NavChild::PaymentDetails`, TXID copy, Open in WhatsOnChain).
- Persisted appearance preference (`handcash.appearance`) in `SettingsPanel`.

### Slice 2 — Collectables & Assets
- **`src/ui/collectables.rs`**:
  - `InventoryPanel` — Grid/List view toggle (`CollectionViewToggle`, persisted to `handcash.collectables.view`), search filter, item count badge, BRC-150 verify batch action, click-to-inspect.
  - `CollectableVerifyMark` — strictly displays `Verified · BRC-150` only for proven BRC-150 items; indexer/marker claims stay `Unverified identity`.
  - `CollectableDetailsPanel` (`NavChild::CollectableDetails`) — basket, MIME, click-to-copy origin/outpoint/issuer key, Open in WhatsOnChain, BRC-150 proof check, `WalletActionDock` with Burn & Send.
  - `SendCollectablePanel` (`NavChild::SendCollectable`) — 2-stage recipient validation + confirm dock.
  - `BurnAssetPanel` (`NavChild::BurnAsset`) — 2-stage irreversible burn confirmation gate.
  - Future engine follow-ups: `DeferredImage` (rendering `art_blob_hash` bytes from `cold_blobs`), `DeferredModelViewer`, `BntShelf`, `CollectFacepile`, `AssetHistoryList`.

### Slice 3 — WalletNav-Docked Action Bar CTAs & Friends
- **`src/ui/chrome.rs` (`WalletActionBarNav`) + `src/ui/dashboard.rs`**:
  - Baked all child-flow CTAs directly into `.wallet-nav-titlebar-tabs[data-permission=""]` using `<footer class="wallet-action-bar wallet-action-bar--nav">` (matching `src/components/WalletActionBar.tsx` + `src/components/WalletNav.tsx` 1:1), replacing the section tabs while `SendPanel`, `CollectableDetailsPanel`, `SendCollectablePanel`, `BurnAssetPanel`, `AddFriendPanel`, or `FriendDetailsPanel` is open.
- **`src/ui/friends.rs` + `src/state.rs`**:
  - `FriendsPanel` — real account-scoped contacts (`handcash.brc100.friends:<chain>:<identityKey>`), Grid/List `CollectionViewToggle`, live search, count badge, Add friend button.
  - `AddFriendPanel` (`NavChild::AddFriend`) — `$handle`, `peerpay:`, or 66-hex wallet key validation + optional custom label, with `Cancel` / `Add friend` CTAs baked into the WalletNav action bar.
  - `FriendDetailsPanel` (`NavChild::FriendDetails`) — rename non-handle contacts, copy wallet key, **Send BSV** (opens `SendPanel` pre-filled with the friend's key), and two-step **Remove** baked into the WalletNav action bar.

### Slice 4 — Blitz Layout Fidelity & Connected Apps
- **`src/theme.rs` (Blitz/Taffy containment & layout fixes)**:
  - Replaced `display: contents` rules (`.wallet-nav-slot`, `.dashboard-side > .history-panel .history-row > .history-body/.history-amount-block`) with explicit flex rules so side-column "Your activity" rows render icon + title + subtitle + amount.
  - Added strict `100vh` / `min-height: 0` / `overflow-y: auto` scroll containment across `.app-shell` → `.stage` → `.dashboard` → `.wallet-nav-shell` → `.nav-section-scroll-body` & `.history-list` so bottom sections never hang off screen.
  - Added Blitz-safe `.collection-grid` / `.collection-grid-card` / `.connected-app-list` rules matching `handcash.css`.
- **`src/ui/apps.rs` + `src/state.rs`**:
  - `ConnectedAppsPanel`: reads real `handcash.brc100.connectedApps:<chain>:<identityKey>`, Grid/List view toggle in titlebar pill, live search, BRC-73 expiry filtering.
  - `AppDetailsPanel` (`NavChild::AppDetails`): grant metadata + **Open** / two-step **Disconnect** CTAs baked into `WalletActionBarNav`.

### Slice 4.5 — Hero Chrome Parity, Multi-Wallet/Currency Dropdowns, Live FX, Item Artwork & Activity Fidelity
- **Dropdown & Hero Placement (`src/theme.rs`, `src/ui/dashboard.rs`, `src/ui/chrome.rs`)**:
  - Removed `overflow: hidden` from `.dashboard-main` and added explicit `[data-menu-open="true"]` stacking (`z-index: 80; overflow: visible`) on `.wallet-hero` and `.wallet-hero-head` so `WalletAccountMenu` (right-anchored) and `FiatCurrencyMenu` (left-anchored) render cleanly above `.wallet-nav-shell` without Blitz/Stylo `:has()` clipping.
  - Aligned `.wallet-hero-head` (`justify-content: space-between`) with `FiatCurrencyMenu` on the left and `WalletAccountMenu` on the right (`margin-left: auto`), matching `src/components/Dashboard.tsx`.
  - Fixed `TOOLBOX_DB_POINTER_V1_PREFIX` (`handcash.toolboxDatabasePointer.v1:`) so restored multi-account SQLite databases resolve 1:1 with the TS app.
- **12-Currency Live & Cached FX Switching (`src/state.rs`, `src/ui/mod.rs`, `src/ui/dashboard.rs`, `src/ui/side.rs`, `src/ui/activity.rs`)**:
  - Added `FxRates` reading `handcash.brc100.bsvUsd` from durable store immediately and refreshing live 12-currency rates in the background (CoinGecko with WhatsOnChain fallback).
  - Hero `FiatCurrencyMenu` pill, toggleable hero balance (`DisplayCurrency::Usd` ↔ `DisplayCurrency::Bsv`), `WhatIsBsvPanel` live BSV price, `ActivityFeed`, and `PaymentDetailsPanel` all update immediately when switching currencies.
- **Collectables Metadata, Honesty & Artwork (`handcash-storage/src/toolbox_db/mod.rs`, `src/state.rs`, `src/ui/collectables.rs`)**:
  - Extended `ToolboxDb::read_wallet_snapshot` to parse `outputs.custom_instructions` JSON and `output_tags` (`origin:`, `name:`, `type:`) and expose `read_cold_blob`.
  - Decoded 1Sat ordinal inscriptions (`handcash_bitcoin::ord::parse_ord_envelope`) from `cold_blobs` into `data:<mime>;base64,...` URIs (`WalletSnapshot::item_art`) rendered in both Grid/List `InventoryPanel` cards and `CollectableDetailsPanel`, plus MAP name/MIME enrichment.
  - Removed hardcoded `"verified"` status; items default to `"unproven"` and only upgrade to `"brc150"` from `handcash.collectables.proven.v2` / `v1`.
- **Activity Timestamps & Durable `appActivity` Merge (`handcash-storage/src/toolbox_db/mod.rs`, `src/state.rs`, `src/ui/activity.rs`, `src/machines.rs`)**:
  - Parsed `transactions.created_at` ISO-8601 UTC timestamps into epoch ms (replacing `tx_row_id` so relative times render accurately).
  - Merged/enriched activity rows with `handcash.brc100.appActivity:<chain>:<identityKey>` from durable store (titles, counterparties, app origins, timestamps) and fixed `"outgoing"` direction matching in both `activity.rs` and `PaymentFilters`.
  - Guaranteed left & right subscripts on every activity row (counterparty / app / TXID / status + relative time and secondary sats in full Activity view).
- **Brand Assets, Fonts, Gradients, Pill Effects, Compact/Mobile Layout & Identity (`src/icons.rs`, `src/ui/mod.rs`, `src/theme.rs`, `src/state.rs`, `src/ui/panels.rs`)**:
  - Replaced placeholder SVG brand mark with embedded `public/brand/handcash-mark-green.png` data URI.
  - Loaded Google Fonts (`Archivo` 400–700 + `Syncopate` 700) in `HandCashApp` so display figures and body typography match the TS app.
  - Restored `--hc-glow` radial gradients, panel atmosphere gradients, and pill sheen/bevel + inverted selector track (`--wallet-nav-select` / `--wallet-nav-unselected`) effects.
  - Added `@media (max-width: 860px)` compact/mobile layout rules mirroring `layout-compact.css` (single-column stack, compact BSV ticker row, hidden duplicate side activity, bottom-docked `WalletNav` bar).
  - Hydrated `IdentityPanel` with real durable data (`handcash.publicIdentities.v1`, `handcash.identityProfiles.v1`, claimed handle, BAP Profile ID, display name, bio, copyable receive address, account/derivation, and public identities list).

---

## Remaining Slices & Fidelity Gaps (In Priority Order)

> **Fast path:** the prioritised cutover plan, with workstreams A–D and the
> crypto-review gate, is in `docs/rust-settings-parity-plan.md` §0. Items
> below are scoped there.

### Fidelity Upgrades Needed on Existing Slices
1. **Native Broadcast**: Wire `SendPanel`, `SendCollectablePanel`, and `BurnAssetPanel` confirm actions into `handcash-engine` ARC broadcast + `CommitSignedTx`.
2. **Interactive BRC-100 Permission Sheet**: Connect `brc100_native.rs` approval prompts to a docked permission sheet (`ConnectPermissionDialog` / `ActionPermissionDialog` / `AutoPayControls`).
3. **Additional Media & Avatar Parity**: `DeferredModelViewer` (3D/GLB), `AppAvatar` favicons, `ProfileAvatar` images, `BntShelf`, `CollectFacepile`, `AssetHistoryList`, and live sparkline points in `WhatIsBsvPanel`.

### Slice 5 — Settings, Diagnostics & Security Subpages
- **Target module:** `src/ui/settings.rs`.
- **TS components:** `SettingsPanel.tsx`, `settings/WalletHealthPanel.tsx`, `settings/WalletHealthAlertBadge.tsx`, `settings/HistoryBackupUrlField.tsx`, `settings/LabsPanel.tsx`, `settings/SettingsFiatDropdown.tsx`, `AboutHandCashPanel.tsx`, `DevKeysPanel.tsx`, `StatechartsPanel.tsx`, `UnlockSettingsPanel.tsx`, `CreateKeysBackupPanel.tsx`, `WalletBackupPanel.tsx`, `RecoverFromTxPanel.tsx`, `WipeWalletPanel.tsx`.
- **Status (in progress, lives in `src/ui/panels.rs` for now):**
  - Done:
    - The `SettingsPanel` list matches the TS sections and order: HandCash Recovery, the seven `SECURITY_ITEMS` (Wipe wallet uses the danger tone), Preferences, Apps, Support, Labs and About.
    - Preferences has Appearance, the Accept (BSV only / BSV and crypto) toggle persisted to `handcash.acceptedCoins.v1`, and Version.
    - Ported subpages: Backup, Import, Unlock, Wallet health, About, Labs, Session logs and Statecharts.
    - Recover from tx: the scan works; importing found items does not yet.
  - Remaining:
    - Subpages: HandCash Recovery, History backup, Device backup, Sign-in email, Wipe wallet and Apps. Each currently opens an honest "not available in the native Rust build yet" panel.
    - Preferences rows: Currency, Sound effects, Updates and Screenshot.

### Slice 6 — Auth, Onboarding & Device Pairing
- **Target module:** Expand `src/ui/auth.rs`.
- **TS components:** `OnboardEntryPanel.tsx`, `OnboardFiatPanel.tsx`, `OnboardProtectPanel.tsx`, `DeviceSignInPanel.tsx`, `DeviceHandoffPanel.tsx`, `PairDevicePanel.tsx`, `SigninEmailPanel.tsx`, `ConfirmPasswordGate.tsx`.

### Slice 7 — Swaps, Multi-Chain Coins & QR Scanner
- **Target module:** `src/ui/swap.rs`.
- **TS components:** `SwapPanel.tsx`, `SwapOffersPanel.tsx`, `SwapDetailPanel.tsx`, `SwapVisuals.tsx`, `CoinDepositDetails.tsx`, `CoinDepositProgress.tsx`, `TickerCoinSelector.tsx`, `AmountPad.tsx`, `QrScanner.tsx`.

---

## Build, Test & Install Commands

```bash
# Unit & SSR tests
cargo test --manifest-path native-desktop/crates/handcash-app/Cargo.toml

# Release build
cargo build --release --manifest-path native-desktop/crates/handcash-app/Cargo.toml

# Install release binary
install -m 755 native-desktop/target/release/handcash-native /home/spider/Applications/handcash/HandCash/handcash-native
```
