# Rust UI parity upgrade plan (2026-11-24)

Closes the gaps found in the 2026-11-24 re-audit (`docs/rust-ui-parity-matrix.md`). It replaces the "Order of work" list in the matrix and the "Remaining Slices" list in `docs/rust-ui-port-roadmap.md`. Target: `native-desktop/crates/handcash-app` (Rust Aeon / Dioxus). Reference: `src/components` (152 non-test `.tsx`).

## Where we are

- 76 of 152 TS components are not referenced in Rust at all.
- Some rows marked `match` are 4–7× smaller than their TS source: activity, payment details, messages, DevKeys and Google recovery.
- 29 TS DOM fixtures are recorded in `native-desktop/fixtures/ui`, but Rust replays only 6 of the 26 fixture folders (`parity.rs`): empty-state, brand-logo, app-toast-host, wallet-action-bar, payment-filters and settings-wallet-health-row.
- Send, 1Sat transfer and burn stop at a "wiring is next" toast. `brc100_native.rs` returns 501 for the signing methods.

## Definition of done (every component)

1. **Record.** The TS recorder (`src/components/rustUiParity.test.ts`) writes one fixture per meaningful state (empty, loaded, error, disabled, selected) to `native-desktop/fixtures/ui/<component>/`.
2. **Port.** Port the component under the same name, or say in a header comment which Rust function owns it.
3. **Replay.** A `parity.rs` test replays every fixture for it through `normalize_html` and passes.
4. **Behaviour.** Port the behaviour cases from the component's TS tests as Rust unit tests.
5. **Honest gating.** A control without a real Rust service is disabled and shows truthful copy (`data-aeon-state="unavailable"`), never a "prepared" toast.
6. **Mark it.** Only then does the matrix row become `match`.

A phase is done when every row in it is `match`, and `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` pass.

Generic primitives (search field, prompts, popover) go upstream in `~/AeonUI` (`aeon-ui-engine`) first. HandCash-specific ones stay in `ui/primitives.rs`. Aeon compounds are never forked here.

## Phases

| # | Phase | Components | Backend needed | Blocked on |
|---|---|---|---|---|
| 0 | Honest scoreboard | Replay the 20 recorded-but-unreplayed fixture folders; add a coverage script that lists every `.tsx` with no Rust reference or no fixture; regenerate matrix counts from it | none | — |
| 1 | Shared primitives | CommandConfirmPrompt, AsyncActionPrompt, CopyableError, SearchField, PanelFilter, NavBreadcrumb, TopBarPopover, WalletNavChrome, ExclusiveActionRegion, DeferredImage, AmountPad, SettingsSection, SettingsControlRow, SettingsIconToggle, ShortcutHint | none | — |
| 2 | Deepen shallow ports | RecentActivity + activity/ActivityJobRows, SigninApprovalRows, PairingCodeEntry; PaymentDetailsPanel; messages/ChatSidebar, ChatThread, MessageBubble, ChatComposer; DevKeysPanel; ChartAppView; ReceivePanel + AnimatedQr; LogViewerPanel; WalletStatusPill + TopBarPopover; HistoryBackupUrlField; LabsPanel | existing: `list_chat_messages`, `send_chat_message`, `read_logs`, `render_qr_svg` | — |
| 3 | App permission prompts (BRC-100) | ConnectPermissionDialog, ActionPermissionDialog, PermissionRequestPanel, PermissionDetailsPanel, PermissionItemPreview, ConnectScopesList, ScopeIcon, GrantDurationPicker, GrantExpiryLine, WalletRequestTemplate, IdentityPublishReview | grant store and prompt queue in Rust; read-only methods first | signing-bearing approvals wait for phase 9 |
| 4 | Devices and recovery | PairDevicePanel, DeviceSignInPanel QR relay, GoogleLoginPanel, GoogleEmailRecoveryMethods, QrScanner | pairing relay (`build_local_pair_qr_json` exists), Google OAuth in Rust, camera capture | camera: Blitz has no camera API (decide: native capture vs paste/image file) |
| 5 | Import | import/ImportPanel, ImportSourceView, ImportItemBrowser, ImportSecretForm, importSourceIcons | per-source importers beyond `import_brc` | — |
| 6 | Collectables and tokens | BntShelf, FungibleTokenFace, DeferredModelViewer, AssetHistoryList, CollectableSendingMark, "Copy image", "Forget from wallet" | token balances (BNT), per-asset history, 3D model rendering | model viewer: Blitz has no WebGL (decide: poster image + open externally) |
| 7 | App browser | AppBrowserPanel, AppBrowserTabSwitcher, AppsSearchBar, AppLaunchPanel, AppLaunchMenu, apps-page/SettingsAndLaunchButton | guest webview host (`native-desktop/src/app_browser.rs` exists for the wry shell) | how a Blitz window hosts a guest webview |
| 8 | Swaps and coins | SwapPanel, SwapOffersPanel, SwapDetailPanel, SwapVisuals, activity/SwapActivityRow, CoinDepositDetails, CoinDepositProgress, NetworkPicker, AutoPayControls, TickerCoinSelector, FiatCurrencyPanel | Rust port of `src/wallet/coins/*` and the swap engine, under the other-coin crypto boundary | coin wallet port |
| 9 | Broadcast (crypto review) | SendPanel broadcast, SendCollectablePanel transfer, BurnAssetPanel burn, signing BRC-100 methods | native ARC send (task-1795507936533), 1Sat transfer, burn | independent crypto review |
| 10 | Platform extras | UpdatePrompt, ScreenshotToast, calls/CallDock, StatechartsPanel (list view, no Mermaid) | `release_update.rs` exists; window capture; calls service | calls service |

Not ported (web-only plumbing; the matrix will say so): ModalPortal, KeepAliveSlot, RenderProbe, FitSlot, MermaidDiagram.

## Order and parallel work

- Do phases 0 and 1 first, in one chat. Every later phase depends on them, and phase 0 makes progress measurable.
- Phase 2 then runs in parallel chats, one per group: activity and payment details, messages, the rest.
- Phases 3, 5 and 6 can start once phase 1 lands.
- Phases 4, 7 and 8 each need a decision first (camera, model viewer, guest webview hosting, coin wallet port). Ask for each when its phase starts.
- Phase 9 follows the crypto review and the native send task. Until then, those controls stay gated with honest copy.
- Phase 10 is last.

## Immediate cleanup (part of phase 0)

Replace the three "wiring is next" toasts (`ui/send.rs:228`, `ui/collectables.rs:1416`, `ui/collectables.rs:1661`) with disabled confirm buttons and truthful "Sending is not available in this build yet" copy, per rule 5.
