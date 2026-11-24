# Rust UI parity matrix (TS `src/components` → `native-desktop/crates/handcash-app`)

Goal: 100% UI/UX parity with the TS app. Every portable TS component has a 1:1 Rust Aeon (`aeon-dioxus`) surface; backend-gated actions (native broadcast/signing awaiting crypto review, Blitz camera, WebGL 3D, guest webview, multi-chain swap engine, calls) stay honestly gated with disabled controls and `data-aeon-state="unavailable"`.

Styling is shared: the Rust app includes `src/styles/handcash.css` + `layout-compact.css` verbatim, so matching class names + `data-aeon-*` attributes = matching visuals.

Last audited: 2026-11-24.

## Automated Coverage Scoreboard (`node scripts/rust-ui-parity-coverage.mjs`)

- **Portable TS components ported in Rust:** **151 / 151 (100%, 0 unreferenced)**
- **Web-only plumbing excluded (not needed in Rust):** 5 (`ModalPortal`, `KeepAliveSlot`, `RenderProbe`, `FitSlot`, `MermaidDiagram`)
- **TS DOM fixtures replayed against `dioxus-ssr` (`parity.rs`):** **29 / 29 files (26 / 26 folders)**
- **Phase 3–10 SSR + honest-gating smoke suite (`parity.rs`):** passing

## Chrome / nav / dashboard

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| WalletNav, main-nav/Nav, WalletNavChrome, NavBreadcrumb | `ui/dashboard.rs`, `ui/primitives.rs` | match | all nav sections routable |
| Dashboard, DashboardSideColumn, WhatIsBsvPanel | `ui/dashboard.rs`, `ui/side.rs` | match | |
| WalletActionBar, WalletActionDock | `ui/dashboard.rs`, `ui/chrome.rs` | match | TS DOM fixtures replayed |
| WalletAccountMenu, FiatCurrencyMenu, FiatCurrencyPanel | `ui/chrome.rs` | match | TS DOM fixtures replayed |
| WalletStatusPill, TopBarPopover | `ui/mod.rs`, `ui/primitives.rs` | match | |
| AppToastHost | `ui/chrome.rs` | match | TS DOM fixture replayed |
| UpdatePrompt | `ui/platform_extras.rs` | match | projects `ReleaseUpdater` phases |
| ScreenshotToast | `ui/platform_extras.rs` | match | native capture trigger pending |
| CallDock (`calls/`) | `ui/platform_extras.rs` | match | calls service gated (`unavailable`) |
| EmptyState, BrandLogo | `ui/mod.rs` | match | TS DOM fixtures replayed |
| Skeleton (all variants), LoadingSpinner, ExclusiveActionRegion | `ui/primitives.rs` | match | |
| ModalPortal, KeepAliveSlot, RenderProbe, FitSlot, MermaidDiagram | web-only | match | web-only plumbing excluded by `rust-ui-parity-coverage.mjs` |

## Send / receive / activity

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| SendPanel | `ui/send.rs` | match | broadcast honestly disabled (`data-aeon-state="unavailable"`, awaiting native ARC send + crypto review) |
| AmountPad | `ui/primitives.rs` | match | key rules unit-tested |
| ReceivePanel, AnimatedQr | `ui/panels.rs` | match | |
| ScanPanel, QrScanner | `ui/panels.rs`, `ui/devices.rs` | match | camera capture gated (`unavailable`) with paste-to-Send fallback |
| RecentActivity, PaymentFiltersPanel, PaymentDetailsPanel | `ui/activity.rs` | match | TS DOM fixtures replayed |
| `activity/ActivityJobRows`, `SigninApprovalRows`, `SwapActivityRow`, `PairingCodeEntry` | `ui/activity.rs` | match | pairing digit rules unit-tested |
| AutoPayControls | `ui/permissions.rs` | match | limits + note rules unit-tested |

## Collectables / tokens

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| InventoryPanel, CollectionViewToggle, CollectableVerifyMark, CollectableDetailsPanel | `ui/collectables.rs` | match | issuer shelves, sort, art prefetch |
| SendCollectablePanel, BurnAssetPanel | `ui/collectables.rs` | match | broadcast honestly disabled (`unavailable`, awaiting crypto review) |
| CollectableSendingMark, FungibleTokenFace, DeferredModelViewer, AssetHistoryList, BntShelf | `ui/collectables_extra.rs` | match | WebGL 3D + BNT transfer/burn honestly gated (`unavailable`) |
| AssetIssuers, IssuerIdentityMark, DeferredImage, CollectFacepile, MiddleEllipsisName | `ui/collectables.rs`, `ui/primitives.rs` | match | |

## Friends / identity / messages

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| FriendsPanel, AddFriendPanel, FriendDetailsPanel | `ui/friends.rs` | match | TS DOM fixtures replayed |
| IdentityPanel, IdentityCards, PublicIdentitiesPanel | `ui/panels.rs` | match | |
| IdentityPublishReview | `ui/permissions.rs` | match | on-chain BAP signing honestly gated (`unavailable`) |
| ProfileAvatar, ProfileIdenticon, ProfileFingerprint, PeerAvatar | `ui/primitives.rs`, `ui/chrome.rs`, `ui/friends.rs`, `ui/collectables.rs` | match | |
| MessagesPanel, `messages/ChatComposer`, `ChatSidebar`, `ChatThread`, `MessageBubble` | `ui/messages.rs`, `ui/friends.rs` | match | unread badge + file-size unit-tested |
| NotesPanel | `ui/apps.rs` | match | sealed per-account private notes |

## Apps / BRC-100

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| ConnectedAppsPanel, AppDetailsPanel, AppAvatar, ScopeIcon, GrantExpiryLine | `ui/apps.rs` | match | TS DOM fixtures replayed |
| ConnectPermissionDialog, ActionPermissionDialog, PermissionRequestPanel, PermissionDetailsPanel, PermissionItemPreview, ConnectScopesList, GrantDurationPicker, WalletRequestTemplate | `ui/permissions.rs` | match | signing-bearing approvals honestly gated (`unavailable`) |
| AppBrowserPanel, AppBrowserTabSwitcher, AppLaunchPanel, AppLaunchMenu, AppLauncherGrid, AppsSearchBar, `apps-page/SettingsAndLaunchButton` | `ui/app_browser.rs`, `ui/apps.rs` | match | embedded Blitz webview gated (`unavailable`) with system-browser launch |
| ChartAppsPanel, ChartAppView | `ui/panels.rs` | match | 5 verified built-in chart apps + state runner |

## Settings

| TS component / row | Rust | Status | Gating / Notes |
|---|---|---|---|
| SettingsPanel, SettingsNavRow, SettingsSection, SettingsControlRow, SettingsIconToggle | `ui/panels.rs`, `ui/primitives.rs` | match | TS DOM fixtures replayed |
| Preferences · Appearance, Accept, Currency (`SettingsFiatDropdown`), Sound effects, Updates | `ui/panels.rs` | match | TS DOM fixtures replayed |
| Support · Wallet health row + WalletHealthAlertBadge + WalletHealthPanel | `ui/panels.rs`, `health.rs` | match | TS DOM fixtures replayed; live probes + UTXO heal |
| Support · Screenshot + ShortcutHint, Session logs (`LogViewerPanel`) | `ui/panels.rs`, `ui/primitives.rs` | match | shortcut keys unit-tested |
| WalletBackupPanel, CreateKeysBackupPanel, KeySliceList | `ui/panels.rs`, `ui/auth.rs` | match | TS DOM fixture replayed |
| `import/ImportPanel`, `ImportSecretForm`, `ImportSourceView`, `ImportItemBrowser`, `importSourceIcons` | `ui/import.rs`, `ui/panels.rs` | match | BRC-39/BRC-38 merge live; legacy sweep honestly gated (`unavailable`) |
| UnlockSettingsPanel, ConfirmPasswordGate, PasswordField | `ui/panels.rs`, `ui/auth.rs` | match | |
| RecoverFromTxPanel | `ui/panels.rs` | match | scan + claim live |
| LabsPanel, StatechartsPanel, AboutHandCashPanel, SettingsFeatureAbout, DevKeysPanel | `ui/panels.rs`, `ui/apps.rs` | match | |
| HistoryBackupPanel, HistoryBackupUrlField, HistoryRecoveryPanel | `ui/panels.rs`, `ui/auth.rs` | match | |
| WipeWalletPanel | `ui/panels.rs` | match | password gate + `DELETE` confirm + history gate |
| HandCashRecoveryPanel, GoogleEmailRecoveryMethods, GoogleLoginPanel | `ui/panels.rs`, `ui/devices.rs` | match | Google OAuth recovery honestly gated (`unavailable`) |
| DeviceHandoffPanel, SigninEmailPanel, PairDevicePanel | `ui/panels.rs`, `ui/devices.rs` | match | QR pairing code + peer linking live |
| NetworkPicker | `ui/swaps.rs` | match | non-BSV chains honestly marked pending |

## Auth / onboarding / devices

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| AuthShell, AuthMeshBackground, OnboardEntryPanel, `auth/AuthEntryTaglines` | `ui/auth.rs` | match | TS DOM fixture replayed |
| AuthScreen · Create, Restore (phrase / key slices / root key), Unlock | `ui/auth.rs` | match | TS DOM fixtures replayed |
| CreateKeysBackupPanel, OnboardAcceptPanel, OnboardFiatPanel, OnboardProtectPanel | `ui/auth.rs` | match | TS DOM fixtures replayed |
| DeviceSignInPanel, PairDevicePanel | `ui/auth.rs`, `ui/devices.rs` | match | |

## Swaps / coins

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| SwapPanel, SwapOffersPanel, SwapDetailPanel, SwapVisuals | `ui/panels.rs`, `ui/swaps.rs` | match | direct swap execution honestly gated (`unavailable`, awaiting Rust coin/swap engine) |
| CoinDepositDetails, CoinDepositProgress, TickerCoinSelector | `ui/swaps.rs`, `icons.rs` | match | deposit count + confirmation pips unit-tested |

## Shared primitives

| TS component | Rust | Status | Gating / Notes |
|---|---|---|---|
| CommandConfirmPrompt, AsyncActionPrompt, CopyableError, SearchField, PanelFilter, SelectionCheckbox | `ui/primitives.rs`, `ui/collectables.rs` | match | search + filter unit-tested |
