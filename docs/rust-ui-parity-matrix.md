# Rust UI parity matrix (TS `src/components` → `native-desktop/crates/handcash-app`)

Goal: 100% UI/UX parity with the TS app. The Rust build is **not complete** until every row is `match`.
Rule: no fake controls. A surface without a real Rust service stays `data-aeon-state="unavailable"` (status `stub`) until its backend lands.
Status: `match` · `partial` (named diffs) · `stub` (honest unavailable copy) · `missing` (no Rust surface).
Styling is shared: the Rust app includes `src/styles/handcash.css` + `layout-compact.css` verbatim, so matching class names = matching visuals.

Last audited: 2026-11-22.

## Re-audit 2026-11-24 (overrides the statuses below where they conflict)

Method: every non-test `.tsx` under `src/components` (152 files) was checked for its name anywhere in `native-desktop/crates/handcash-app/src`, and the `.tsx` line count was compared with the Rust function that claims to port it. Line count is only a rough guide, but a 5× gap shows the port left things out.

Result: **76 of 152 components are not referenced anywhere in Rust**, and several rows marked `match` above are much smaller than their TS source. In practice the true count is under 20 `match` rows, not 36.

Rows marked `match` above that are really `partial`:

| Row | TS lines | Rust lines | What is missing |
|---|---|---|---|
| RecentActivity + PaymentDetailsPanel | 1613 + 1231 | `ActivityFeed` 195 + `PaymentDetailsPanel` 237 | most of the feed (job rows, sign-in approvals, swap rows, pairing code entry, grouping), most of the details panel |
| MessagesPanel + messages/* | 814 | `MessagesPanel` 223 | ChatThread, MessageBubble, ChatSidebar, ChatComposer are not ported as components |
| HandCashRecoveryPanel + GoogleLoginPanel + GoogleEmailRecoveryMethods | 156 + 303 + 229 | 133 | Google sign-in and email recovery methods are absent |
| ChartAppsPanel + ChartAppView | 151 + 374 | 234 | ChartAppView not referenced |
| DevKeysPanel | 670 | 211 | most of the panel |
| SettingsSection / SettingsControlRow / SettingsIconToggle / LabsPanel / ShortcutHint / HistoryBackupUrlField | 23–138 each | not referenced | inlined or dropped; unverified |

Stubs and placeholders: `SwapPanel` (13 lines, EmptyState) vs 570 + 361 + 174 + 63 TS lines; `ScanPanel` (22 lines, links to Send) vs 252 + QrScanner 305; ARC send, 1Sat transfer and burn all end in a "wiring is next" toast (`send.rs:228`, `collectables.rs:1416`, `collectables.rs:1661`).

Whole features with no Rust surface: Import browser (`import/*`, ~1750 lines), BRC-100 permission dialogs (10 components, ~1340 lines), App browser/launcher (~710 lines), PairDevicePanel + AnimatedQr + QrScanner (~1300 lines), Swaps/coins (Swap*, CoinDeposit*, NetworkPicker, AutoPayControls, AmountPad, FiatCurrencyPanel), BntShelf / FungibleTokenFace / DeferredImage / DeferredModelViewer / AssetHistoryList / CollectableSendingMark, UpdatePrompt, LogViewerPanel, CallDock, shared prompts (CommandConfirmPrompt, AsyncActionPrompt, CopyableError, PanelFilter, SearchField, NavBreadcrumb, TopBarPopover, WalletNavChrome).

Probably not needed in Rust (web-only plumbing): ModalPortal, KeepAliveSlot, RenderProbe, FitSlot; MermaidDiagram/StatechartsPanel are dev-only.

The plan to close these gaps is `docs/rust-ui-parity-plan.md`; it replaces "Order of work" below.

Rule going forward: a row may be marked `match` only when a TS DOM fixture replays against the dioxus-ssr output (`parity.rs`), or when every sub-component in the row is referenced in Rust and its behaviour is listed in the Gap column.

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
| Skeleton (all variants), LoadingSpinner | ui/primitives.rs | match | spinner wired into activity pending mark |
| FitSlot, KeepAliveSlot, ModalPortal, ExclusiveActionRegion, RenderProbe, MermaidDiagram | — | missing | layout primitives; port as surfaces need them |

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
| CollectableSendingMark, FungibleTokenFace, AssetIssuers, IssuerIdentityMark, DeferredImage, DeferredModelViewer, AssetHistoryList, BntShelf, CollectFacepile | — | missing | MiddleEllipsisName ported in ui/primitives.rs (not yet wired into collectables) |

## Friends / identity / messages

| TS component | Rust | Status | Gap |
|---|---|---|---|
| FriendsPanel, AddFriendPanel, FriendDetailsPanel | ui/friends.rs | match | shared peer identity cards, import card, toolbar, messages shortcut |
| IdentityPanel | panels.rs | match | IdentityCards deck, Handle IPT, PublicIdentitiesPanel (create/edit profile, avatar upload, import key, backup/restore, share identity card) |
| ProfileAvatar, ProfileIdenticon, ProfileFingerprint, PeerAvatar | ui/primitives.rs, chrome.rs, friends.rs, collectables.rs | match | wired into WalletAccountMenu, IdentityPanel, FriendsPanel, FriendDetailsPanel, and Collectables issuer shelves |
| MessagesPanel, messages/ChatComposer, ChatSidebar, ChatThread, MessageBubble | ui/friends.rs `MessagesPanel` | match | contact sidebar, thread history, pay shortcut, message composer |
| NotesPanel | ui/apps.rs `NotesPanel` | match | sealed per-account private notes (`handcash.notes.v1`) |

## Apps / BRC-100

| TS component | Rust | Status | Gap |
|---|---|---|---|
| ConnectedAppsPanel, AppDetailsPanel | ui/apps.rs | match | AppLauncherGrid (Notes + 5 verified chart apps + connected web apps), AppAvatar, Developer keys |
| ConnectPermissionDialog, ActionPermissionDialog, PermissionRequestPanel, PermissionDetailsPanel, PermissionItemPreview, ConnectScopesList, ScopeIcon, GrantDurationPicker, GrantExpiryLine, WalletRequestTemplate | — | missing | BRC-100 prompts; signing-bearing approvals gated |
| AppBrowserPanel, AppBrowserTabSwitcher, AppLaunchPanel, AppLaunchMenu, AppLauncherGrid, AppsSearchBar, AppAvatar, apps-page/SettingsAndLaunchButton | — | missing | needs embedded webview story in Blitz |
| ChartAppsPanel, ChartAppView | panels.rs `ChartAppsPanel` | match | 5 verified built-in chart apps + AppReview + ChartAppView state runner |

## Settings

| TS component / row | Rust | Status | Gap |
|---|---|---|---|
| SettingsPanel sections, SettingsNavRow, SettingsSection, SettingsControlRow, SettingsIconToggle | panels.rs | match | |
| Preferences · Appearance, Accept | panels.rs | match | |
| Preferences · Currency (SettingsFiatDropdown) | panels.rs `SettingsFiatDropdown` | match | ported 2026-11-22 |
| Preferences · Sound effects | panels.rs | match | persisted in durable settings (`handcash.sfx.enabled`) |
| Preferences · Updates + Check update | panels.rs + `ReleaseUpdater` | match | bounded GitHub release check + download |
| Support · Wallet health row + WalletHealthAlertBadge | panels.rs + `health.rs` | match | live probes, status line, badge (2026-11-22) |
| WalletHealthPanel | panels.rs `WalletHealthPanel` | match | 5 probes + Refresh + live "Heal wallet UTXOs" (`heal_wallet_utxos`) |
| Support · Screenshot + ShortcutHint | — | missing | native capture |
| Support · Session logs (LogViewerPanel) | panels.rs | partial | copy says "open log folder"; TS "upload" |
| WalletBackupPanel, CreateKeysBackupPanel, KeySliceList | panels.rs Backup, auth.rs | match | 2-of-3 BRC-140 key slices + phrase + emergency key |
| import/ImportPanel, ImportSecretForm, ImportSourceView, ImportItemBrowser | panels.rs Import | partial | BRC-39 `.brc39` + BRC-38 `.json` merge; source views / item browser pending |
| UnlockSettingsPanel, ConfirmPasswordGate, PasswordField | panels.rs Unlock, auth.rs | match | |
| RecoverFromTxPanel | panels.rs `RecoverTxPanel` | match | scan + "Claim into wallet" (`claim_recover_tx` + BRC-150 pass) |
| LabsPanel, StatechartsPanel, AboutHandCashPanel, SettingsFeatureAbout, DevKeysPanel | panels.rs | partial | DevKeys missing |
| HistoryBackupPanel, HistoryBackupUrlField, HistoryRecoveryPanel | panels.rs `HistoryBackupPanel`, auth.rs | match | BRC-38 export (`AccountStore` + `ToolboxDb` fallback) → `.brc39` download/merge-restore + write-once `Brc39Archive` + custom host URL |
| WipeWalletPanel | panels.rs `WipeWalletPanel` | match | password gate, `DELETE` confirm, `check_wipe_history_gate`, preserves `brc39-archive/` |
| HandCashRecoveryPanel, GoogleEmailRecoveryMethods, GoogleLoginPanel | panels.rs `HandCashRecoveryPanel` | match | device roster + self-backup status (`Saved` / `Not saved`) |
| DeviceHandoffPanel, SigninEmailPanel | panels.rs `DeviceHandoffPanel`, `SigninEmailPanel` | match | QR pairing code, JSON peer link, linked devices, sign-in email CRUD |
| NetworkPicker | — | missing | |

## Auth / onboarding / devices

| TS component | Rust | Status | Gap |
|---|---|---|---|
| AuthShell, AuthMeshBackground, OnboardEntryPanel, auth/AuthEntryTaglines | ui/auth.rs | match | |
| AuthScreen · Create form | ui/auth.rs | match | button-only create → wrap secret (`none` lock) → keys-backup → accept → fiat → protect → `Created` |
| AuthScreen · Restore (phrase) form | ui/auth.rs | match | mnemonic textarea (`id=mnemonic`, rows 3), restore-role radiogroup (Replace old device / Keep both), restore note, alt links → history → protect |
| AuthScreen · Restore by key slices / root key | ui/auth.rs | match | 2-of-3 BRC-140 key slices (`recover_root_key_from_brc140_shares` + polynomial extension) and 64-hex emergency root key |
| AuthScreen · Unlock lede | ui/auth.rs | match | lock-mode-aware lede |
| CreateKeysBackupPanel (onboarding step) | ui/auth.rs | match | 2-of-3 BRC-140 key slices (`KeySliceList`) + 24-word phrase grid + Copy / confirm / defer |
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
