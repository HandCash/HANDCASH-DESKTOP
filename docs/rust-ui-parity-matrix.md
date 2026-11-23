# Rust UI parity matrix (TS `src/components` → `native-desktop/crates/handcash-app`)

Goal: 100% UI/UX parity with the TS app. The Rust build is **not complete** until every row is `match`.
Rule: no fake controls. A surface without a real Rust service stays `data-aeon-state="unavailable"` (status `stub`) until its backend lands.
Status: `match` · `partial` (named diffs) · `stub` (honest unavailable copy) · `missing` (no Rust surface).
Styling is shared: the Rust app includes `src/styles/handcash.css` + `layout-compact.css` verbatim, so matching class names = matching visuals.

Last audited: 2026-11-22.

## Chrome / nav / dashboard

| TS component | Rust | Status | Gap |
|---|---|---|---|
| WalletNav, main-nav/Nav, WalletNavChrome, NavBreadcrumb | ui/dashboard.rs | partial | Nav sections without Rust surfaces (Messages, Apps browser) not routable |
| Dashboard, DashboardSideColumn, WhatIsBsvPanel | ui/dashboard.rs, ui/side.rs | partial | WhatIsBsv sparkline |
| WalletActionBar, WalletActionDock | dashboard.rs `WalletActionBarNav`, chrome.rs | match | |
| WalletAccountMenu, FiatCurrencyMenu, FiatCurrencyPanel | chrome.rs | match | |
| WalletStatusPill, TopBarPopover | — | missing | |
| AppToastHost | chrome.rs | match | |
| UpdatePrompt | — | missing | needs Rust updater |
| ScreenshotToast | — | missing | needs native window capture |
| CallDock (calls/) | — | missing | needs calls service |
| EmptyState, BrandLogo | ui/mod.rs | match | |
| Skeleton, LoadingSpinner, FitSlot, KeepAliveSlot, ModalPortal, ExclusiveActionRegion, RenderProbe, MermaidDiagram | — | missing | layout primitives; port as surfaces need them |

## Send / receive / activity

| TS component | Rust | Status | Gap |
|---|---|---|---|
| SendPanel | ui/send.rs | partial | broadcast gated (crypto review); PeerPay send gated |
| AmountPad | — | missing | |
| ReceivePanel, AnimatedQr | panels.rs `ReceivePanel` | partial | animated QR |
| ScanPanel, QrScanner | panels.rs `ScanPanel` | stub | camera capture |
| RecentActivity, PaymentFiltersPanel, PaymentDetailsPanel | ui/activity.rs | match | |
| activity/ActivityJobRows, SigninApprovalRows, SwapActivityRow, PairingCodeEntry | — | missing | |
| AutoPayControls | — | missing | |

## Collectables / tokens

| TS component | Rust | Status | Gap |
|---|---|---|---|
| InventoryPanel, CollectionViewToggle, CollectableVerifyMark, CollectableDetailsPanel | ui/collectables.rs | partial | DeferredModelViewer, AssetHistoryList, CollectFacepile, BntShelf |
| SendCollectablePanel, BurnAssetPanel | ui/collectables.rs | partial | broadcast gated (crypto review) |
| CollectableSendingMark, FungibleTokenFace, AssetIssuers, IssuerIdentityMark, DeferredImage, DeferredModelViewer, AssetHistoryList, BntShelf, CollectFacepile, MiddleEllipsisName | — | missing | |

## Friends / identity / messages

| TS component | Rust | Status | Gap |
|---|---|---|---|
| FriendsPanel, AddFriendPanel, FriendDetailsPanel | ui/friends.rs | match | |
| IdentityPanel | panels.rs | partial | IdentityCards, IdentityPublishReview, PublicIdentitiesPanel |
| ProfileAvatar, ProfileIdenticon, PeerIdentity | — | missing | |
| MessagesPanel, messages/ChatComposer, ChatSidebar, ChatThread, MessageBubble | — | missing | needs messagebox service (≠ custody) |
| NotesPanel | — | missing | |

## Apps / BRC-100

| TS component | Rust | Status | Gap |
|---|---|---|---|
| ConnectedAppsPanel, AppDetailsPanel | ui/apps.rs | match | |
| ConnectPermissionDialog, ActionPermissionDialog, PermissionRequestPanel, PermissionDetailsPanel, PermissionItemPreview, ConnectScopesList, ScopeIcon, GrantDurationPicker, GrantExpiryLine, WalletRequestTemplate | — | missing | BRC-100 prompts; signing-bearing approvals gated |
| AppBrowserPanel, AppBrowserTabSwitcher, AppLaunchPanel, AppLaunchMenu, AppLauncherGrid, AppsSearchBar, AppAvatar, apps-page/SettingsAndLaunchButton | — | missing | needs embedded webview story in Blitz |
| ChartAppsPanel, ChartAppView | — | stub | |

## Settings

| TS component / row | Rust | Status | Gap |
|---|---|---|---|
| SettingsPanel sections, SettingsNavRow, SettingsSection, SettingsControlRow, SettingsIconToggle | panels.rs | partial | rows below |
| Preferences · Appearance, Accept | panels.rs | match | |
| Preferences · Currency (SettingsFiatDropdown) | panels.rs `SettingsFiatDropdown` | match | ported 2026-11-22 |
| Preferences · Sound effects | — | missing | needs Rust sound playback, else toggle would be fake |
| Preferences · Updates + Check update | panels.rs (version row only) | partial | needs Rust updater |
| Support · Wallet health row + WalletHealthAlertBadge | panels.rs + `health.rs` | match | live probes, status line, badge (2026-11-22) |
| WalletHealthPanel | panels.rs `WalletHealthPanel` | partial | 5 probes + Refresh match; "Heal wallet UTXOs" unavailable (no Rust heal service) |
| Support · Screenshot + ShortcutHint | — | missing | native capture |
| Support · Session logs (LogViewerPanel) | panels.rs | partial | copy says "open log folder"; TS "upload" |
| WalletBackupPanel, CreateKeysBackupPanel, KeySliceList | panels.rs Backup | partial | key slices |
| import/ImportPanel, ImportSecretForm, ImportSourceView, ImportItemBrowser | panels.rs Import | partial | source views, item browser |
| UnlockSettingsPanel, ConfirmPasswordGate, PasswordField | panels.rs Unlock, auth.rs | partial | ConfirmPasswordGate reuse |
| RecoverFromTxPanel | panels.rs `RecoverTxPanel` | partial | claim (signing, gated) |
| LabsPanel, StatechartsPanel, AboutHandCashPanel, SettingsFeatureAbout, DevKeysPanel | panels.rs | partial | DevKeys missing |
| HistoryBackupPanel, HistoryBackupUrlField, HistoryRecoveryPanel | — | stub | needs Rust BRC-38 export + cloud upload (BRC-39 encrypt exists) |
| WipeWalletPanel | — | stub | needs Rust wipe + history gate (after HistoryBackup) |
| HandCashRecoveryPanel, GoogleEmailRecoveryMethods, GoogleLoginPanel | — | stub | |
| DeviceHandoffPanel, SigninEmailPanel | — | stub | |
| NetworkPicker | — | missing | |

## Auth / onboarding / devices

| TS component | Rust | Status | Gap |
|---|---|---|---|
| AuthShell, AuthMeshBackground, OnboardEntryPanel, auth/AuthEntryTaglines | ui/auth.rs | match | |
| AuthScreen · Create form | ui/auth.rs | match | button-only create → wrap secret (`none` lock) → keys-backup → accept → fiat → protect → `Created` |
| AuthScreen · Restore (phrase) form | ui/auth.rs | match | mnemonic textarea (`id=mnemonic`, rows 3), restore-role radiogroup (Replace old device / Keep both), restore note, alt links → history → protect |
| AuthScreen · Restore by key slices / root key | ui/auth.rs | partial | 64-hex emergency root key restores directly; BRC-140 key-slice tab present with honest unavailable message until GF(256) combiner lands |
| AuthScreen · Unlock lede | ui/auth.rs | match | lock-mode-aware lede |
| CreateKeysBackupPanel (onboarding step) | ui/auth.rs | match | phrase grid + Copy / "I’ve saved it — continue" / "I’ll do this later"; key-slices tab shown disabled |
| OnboardAcceptPanel | ui/auth.rs | match | `AcceptedCoins` + `TickerCoinMark` icons |
| OnboardFiatPanel | ui/auth.rs | match | 12 `FiatCode` options with flag + ISO |
| OnboardProtectPanel | ui/auth.rs | match | None / Password / Touch ID (disabled) / Password + Touch ID (disabled) + `apply_onboard_lock` |
| DeviceSignInPanel, PairDevicePanel | ui/auth.rs | partial | DeviceSignInPanel scan frame + Back / Other ways routed; QR relay + PairDevicePanel pending |

## Swaps / coins

| TS component | Rust | Status | Gap |
|---|---|---|---|
| SwapPanel, SwapOffersPanel, SwapDetailPanel, SwapVisuals | panels.rs `SwapPanel` | stub | swap engine |
| CoinDepositDetails, CoinDepositProgress, TickerCoinSelector | — | missing | multi-chain |

## Misc

| TS component | Rust | Status |
|---|---|---|
| CommandConfirmPrompt, AsyncActionPrompt, CopyableError, SearchField, PanelFilter, SelectionCheckbox | — | missing (port with first consumer) |

## Remaining work (as of 2026-11-22)

In progress, uncommitted in the working tree: `icons.rs` (ChainMark, TickerCoinMark), `state.rs` (onboard lock, wrap secret, keys-backup flags), `vault.rs` (`PASSWORD_MIN_LENGTH`, `password_policy_error`, `generate_wrap_secret`), `health.rs`, `handcash-bitcoin/src/recover.rs`. Next edit is `ui/auth.rs`: pending-onboard state, preparing screen, the four onboarding steps, and button-only Create / mnemonic-only Restore. Unit tests for `password_policy_error` and `generate_wrap_secret` still to add.

Count: 11 rows `match`, 19 `partial`, 7 `stub`, 26 `missing`. Nothing is complete until every row is `match`.

## Order of work (user-visible first; ⚠ = gated on crypto review)

1. Auth/onboarding: Create and Restore forms to TS, onboarding steps (keys-backup, accept, fiat, protect), unlock lede; then HistoryRecoveryPanel and restore by key slices / root key. Settings: Rust UTXO heal service.
2. Shared primitives: Skeleton, LoadingSpinner, AsyncActionPrompt/CommandConfirmPrompt, ConfirmPasswordGate, CopyableError.
3. History backup: Rust BRC-38 export → `.brc39` file download/restore (merge-only), then cloud upload; then WipeWallet with history gate.
4. BRC-100 permission dialogs (Connect/Action) over the existing bridge; ⚠ for signing-bearing approvals.
5. Media: DeferredImage/ModelViewer, ProfileAvatar/Identicon, AppAvatar, AssetHistoryList, BntShelf, CollectFacepile.
6. Messages/Notes (messagebox service), DeviceSignIn/PairDevice/Handoff/SigninEmail.
7. App browser/launcher (Blitz webview decision), Swaps/Coins/QR scanner, Updater, Screenshot, Sound.
8. ⚠ Send/transfer/burn/claim broadcast enabled after independent crypto review.
