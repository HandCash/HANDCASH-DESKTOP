# Changelog

## [1.2.37] - 2026-08-05

### Fixed

- Pre-prompt spend heals no longer throw `runChainIngestDuringSpend requires an active spend session`. Chain refresh uses the top-level ingest path outside a spend lock, and nests only while send is already exclusive.
- Soften the BSV toast CRT texture — wider scanlines and a haze instead of a dense pixel grid.

## [1.2.36] - 2026-08-05

### Fixed

- Sending a collectable no longer fails with "Every signableTransaction input must have a sourceTransaction". The input BEEF now covers every outpoint the send spends, so a tip and a latch from different transactions are both provable.
- The proof latch is signed with its own satoshi value instead of the tip's 1 sat, so latched transfers produce valid signatures.
- A collectable whose tip still carries its inscription envelope is recognised as spendable instead of reporting "locked to a key this device cannot sign".

## [1.2.35] - 2026-08-05

### Added

- Activity history for collectables shows the item name and thumbnail instead of a 1-sat payment amount.
- BRC-99 `p 1sat <scope>` baskets for item permissions (`*`, `collection:`, `creator:`, `origin:`); plain `1sat` remains the coarse fallback. Unsupported `p` schemes are rejected.

## [1.2.34] - 2026-08-05

### Fixed

- Sending a collectable now releases the tip (and its prior latch) from the item basket immediately, so a sent item stops listing in the sending wallet and cannot appear in two wallets at once.
- The legacy-import grace window no longer blocks a forced spendable review. Outputs this device just spent are released on spend heal and explicit Refresh; the release is only held when the same pass swept legacy funding.

## [1.2.33] - 2026-08-05

### Fixed

- Misfiled funds recover again: the inscription probe no longer walks ancestor transactions, so funding outputs descended from an ordinal spend stopped being treated as collectables and left in the item basket.
- Refresh now reports what happened to item-basket money — recovered, held with an inscription, locked to another key, below the fee floor, or a sweep error — instead of only logging to the console.

## [1.2.32] - 2026-08-05

### Fixed

- Sound effects play on Android: one shared `AudioContext` that is resumed on the first gesture, instead of a fresh suspended context per beep.

## [1.2.31] - 2026-08-05

### Changed

- Remove backup gating from send, BRC-100 permissions, and the Dashboard nag — backup stays optional in Settings.
- Simplify key-slice backup UI (email-first, trustholder choice above slices).
- Mobile top bar / Settings version comes from the Mobile package, not Desktop’s semver.

## [1.2.30] - 2026-08-05

### Changed

- Dashboard **Scan** offers **Add as friend** (identity keys) or **Send**, instead of jumping straight to Send.
- Collectable send uses the same send-panel layout as BSV send so mobile stacking matches Desktop.
- Removed the “one-sat waiting on the index” note from Collectables / sync status.

## [1.2.29] - 2026-08-05

### Fixed

- **Authenticity is lossless again on collectable sends.** Soft-latch was attaching structural v3 remittance and marking items `proven` without tip→origin BEEF or on-chain induction. Sends now attach BRC-150 v2 remittance; the 2-sat latch companion UTXO still ships for the latch profile. Bare v3 no longer counts as proven.

## [1.2.28] - 2026-08-05

### Changed

- **BRC-153 soft-latch sends are live** again: collectable transfers create tip (1 sat) + latch (**exactly 2** sats, P2PKH), co-spend prior latch when present, attach v3 remittance with relative `OUTPUT:N` tip/latch refs.
- Soft-latch dust is a protocol constant (`LATCH_DUST_SATS = 2`): never listed as a collectable, never fund-swept, internalized to basket `1sat-latch`. Spec updated accordingly.

## [1.2.27] - 2026-08-05

### Fixed

- **Legacy balance could be filed into the collectables basket.** The migration trusted the cloud item list outright, so any outpoint it named was excluded from the funding sweep and internalized into basket `1sat` — regardless of how many satoshis it actually held. Basket `1sat` is not counted toward spendable balance, so that money disappeared from the wallet.
- Cloud-named items are now cross-checked against the live UTXO: anything that is not exactly 1 satoshi is swept as funding. Outpoint matching is case-insensitive.
- `internalizeAction` verifies output value from the fetched BEEF before filing to basket `1sat`, covering every import path.

### Added

- Recovery on refresh: item-basket outputs worth more than a satoshi are swept back into spendable change. Outputs that resolve as inscriptions, or that are locked to another key, are reported and left alone.

## [1.2.26] - 2026-08-05

### Fixed

- **Receiving a collectable no longer shows a duplicate item.** The BRC-153 soft-latch shipped the latch as a bare 1-sat P2PKH output, which is indistinguishable from an ordinal tip on chain — receivers imported it as a second collectable with the same origin.
- Collectables listing skips latch-tagged outputs and deduplicates basket `1sat` by origin, so wallets already holding a phantom item heal on refresh.

### Changed

- Latched sends are held (`isLatchedSendEnabled()` → `false`) until the latch carries an on-chain marker script and a non-1-satoshi value; sends fall back to BRC-150 v2 remittance. v3 verify stays live.
- BRC-153 spec records the requirement that latch outputs be identifiable from the transaction alone.

## [1.2.25] - 2026-08-05

### Fixed

- Soft-latch send TypeScript build (signable input map typing).

## [1.2.24] - 2026-08-05

### Changed

- **BRC-153 soft-latch sends are live** (no feature gate): collectable transfers create tip + `1sat-latch` latch, co-spend prior latch when present, attach v3 remittance with relative `OUTPUT:N` tip/latch refs.

## [1.2.23] - 2026-08-05

### Changed

- **BRC-153** latched 1Sat provenance (renumbered from draft 151 — official registry reserves 151 for opinions).
- Manifest `/health` advertise 1Sat BRC capabilities (`147`, `150`, `153`; v2/v3 verify; latched send gated).
- Collectable sends use `tryBuildProvenanceForSend` (v2 today; v3 when Commit/Settle ships).

## [1.2.22] - 2026-08-05

### Added

- **BRC-151** latched 1Sat provenance (draft spec + phase 1): v3 remittance parse/verify, `1sat-latch` basket profile, BOLT-inspired O(1) path for collectables.
- Tap **Synced** status pill to refresh wallet (chain ingest + optional history pull).

## [1.2.21] - 2026-08-05

### Fixed

- Receive page QR no longer clipped; breadcrumb headers match section header typography.

## [1.2.20] - 2026-08-05

### Fixed

- Legacy balance no longer vanishes after “Payment received” — import runs before spendable review.
- 2-minute grace window after legacy sweep so indexers can catch up before outputs are released.
- Heal path when outpoints were marked imported but funds still sit on the legacy address.
- Receive toast only fires when spendable balance actually rises (not on import attempt alone).

## [1.2.19] - 2026-08-05

### Changed

- Wallet-layer coordinator (`walletCoordinatorMachine`) — chain ingest, spend, history replica, and recompose cannot overlap illegally.
- Spend-path chain heal uses nested ingest (no deadlock with in-flight send); Dashboard Refresh waits for active spend.

## [1.2.18] - 2026-08-05

### Fixed

- Unify chain ingest under `chainIngest.ts` + `ingestLegacyAddress.ts` (Refresh and migrate share one pipeline).
- Legacy receive scan prefers WhatsOnChain; reclaim falsely blacklisted UTXOs still unspent on-chain.
- Migration runs spendable review before legacy import (same as Refresh).

### Changed

- Remove `syncFunds.ts` — use `refreshFromChain()` from `chainIngest.ts`.

## [1.2.17] - 2026-08-05

### Fixed

- Prevent double legacy/1sat imports via outpoint guards and a shared chain-ingest queue (migrate + Dashboard sync).
- Serialize BRC-39 history upload/restore; skip soft-pull while local history is dirty.
- Receive toasts use the selected display denomination; longer toast duration; CRT toast contrast.

### Changed

- Serialize `internalizeAction` with spends; block collectable-send / handle-claim re-entry; skip overlapping Dashboard poll ticks.
## [1.2.16] - 2026-08-05

### Fixed

- **Peer-to-peer collectable send.** Basket `1sat` transfers now declare `unlockingScriptLength` and complete signing with the device root key. A too-broad error map had been rewriting the BRC-100 validation failure as "Invalid recipient address or identity key."
- **Sticky panel labels.** Solid background extends through the scroll-stage top padding so list content no longer peeks above the box label.

### Added

- **Handle claim (separate from balance migration).** BRC-100 `claimCloudHandle` / `getClaimedCloudHandle` bind a cloud `$alias` to the Desktop identity key via BRC-CLOUD.
- **GrapheneOS note** in Settings → About when HandCash Mobile detects GrapheneOS (sideload updates, no Play Services, backup disabled).

## [1.2.15] - 2026-08-04

### Changed

- **Key slices backup UX.** Settings → Key slices is a flexible slice manager: per-slice destination cycling (←/→), bulk destination shift, rotate-all with a confirm prompt (new integrity set), and a single progress header. Removed the awkward “Save N more slice(s)” primary label — confirm is **Done — slices saved** once two distinct handoffs exist. Cloud deposit stays a separate entry for HandCash + Haste.

## [1.2.14] - 2026-08-04

### Added

- **Scan to link** for multi-device pairing. Pair settings has a primary **Scan to link** camera flow; Dashboard Scan routes device-link QRs to Use on another device. QR scanning falls back to `@zxing/browser` when `BarcodeDetector` is missing (Android WebView / Capacitor).

## [1.2.13] - 2026-08-04

### Added

- **Immutable on-device UTXO archive.** Every BRC-39 export (download, cloud upload, or post-spend snapshot) also writes a write-once file under `userData/brc39-archive/{identity}/`. Existing snapshots are never overwritten (`wx` exclusive create); identical content is deduped. History settings lists local snapshots and can merge-restore them. Survives cloud PUT overwrite and IndexedDB factory wipe.

## [1.2.12] - 2026-08-04

### Added

- **Add money** action on the dashboard — opens the Exolix swap at `handcash.io/wallet/swap`, which pays BSV back into this device over the BRC-100 bridge. Override the host with `VITE_MARKET_BASE_URL`.

### Removed

- Manual **Refresh** button. The dashboard already polls the chain every 12s (parity) or 30s, and now also merges strictly-newer BRC-39 history on a 60s cadence, so there is nothing left for the button to do. Spend paths still force a full spendability review before broadcasting.

## [1.2.11] - 2026-08-04

### Fixed

- macOS “HandCash is damaged and can’t be opened”. With `identity: null` electron-builder skipped signing entirely, so the bundle shipped with only the linker's default signature (`Identifier=Electron`, no sealed resources) and `codesign --verify` failed — Apple Silicon rejects that regardless of quarantine state. `scripts/afterPack.cjs` now ad-hoc signs each packaged `.app` before the DMG/zip is built.
- Mac release workflow now runs `codesign --verify --deep --strict` and asserts the signature is bound to `io.handcash.brc100`, so a broken signature fails CI instead of shipping.

### Notes

- Still not notarized, so first launch needs `xattr -cr /Applications/HandCash.app`. On macOS 15+ right-click → Open no longer bypasses Gatekeeper; the GUI route is **System Settings → Privacy & Security → Open Anyway**.
- To repair an install from 1.2.10 or earlier: `xattr -cr /Applications/HandCash.app && codesign --force --deep --sign - /Applications/HandCash.app`.

## [1.2.10] - 2026-08-04

### Fixed

- Pin `@bsv/wallet-toolbox-client` to `2.4.4` so the `listOutputsIdb` patch applies in CI (`npm ci` was resolving 2.5.0).

## [1.2.9] - 2026-08-04

### Fixed

- Vendor `aeon-ui-engine@1.3.9` in-repo (`file:vendor/aeon-ui-engine`) so unsigned Mac/Linux/Windows CI can build without npm publish or access to the private AeonUI repo.

### Notes

- **Unsigned Mac BETA (notarization later):** download DMG from GitHub Releases. If Gatekeeper says “damaged”, run `xattr -cr /Applications/HandCash.app`. Auto-update opens the DMG instead of ShipIt.

## [1.2.8] - 2026-08-04

### Fixed

- Attempted HTTPS git URL for `aeon-ui-engine` (superseded by vendored path in 1.2.9).

## [1.2.7] - 2026-08-04

### Fixed

- Pin `aeon-ui-engine` to GitHub `v1.3.9` so CI builds Messages/BRC-218 UI (npm 1.3.5 was missing Thread/Composer/Prompt parts).
- Mac release workflow YAML (unsigned DMG builds — notarization still later).

## [1.2.6] - 2026-08-04

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.2.5] - 2026-08-04

### Added

- Wallet layer model (`chainIngest`, `historyReplica`, `localState`) with `recomposeWallet` on unlock/restore/pair sync.
- BRC-150 provenance helpers; empty-local history guard; soft BRC-39 pull on Refresh.
- Aeon `KeySliceList` for BRC-140 slice backup (progress, per-row state, distinct-slice confirm).

### Changed

- Trustholder backup uses the same dynamic list UX as offline split key backup.

### Fixed

- Mac auto-update still skips ShipIt on unsigned builds — opens the arch-matched DMG instead so `/Applications/HandCash.app` is not left damaged.

## [1.2.4] - 2026-08-04

### Added

- Cloud key backup (BRC-232) Settings panel for HandCash + Haste trustholder deposits.
- Modular Settings helpers (History URL field, status rows).

### Changed

- Restore Friends list/grid root (search kept); Message stays on friend details.
- Status pill: hide soft sync / backup probes; chain health wins over cloud “pending”.
- Unlock auto cloud sync is push-only; refuse older/unknown remote history pulls.
- Scan QR always opens the camera (no backup-settings redirect).
- Clearer Keys backup copy (“copy/save slices”); leaner fixed panel label bars.

### Fixed

- Auth no longer blocks on chain/cloud sync before entering the wallet.

## [1.2.3] - 2026-08-04

### Added

- Messages tab (BRC-218 compose commands, in-thread `/pay` `/request` `/escrow` cards).
- BRC-CLOUD messagebox client (send/list/ack) with local-first store.
- In-wallet log viewer; cloud backup health in the status pill.

### Changed

- Friends → Message opens the Messages thread.
- Mobile inherits Messages (short tab label: Msgs).

## [1.2.2] - 2026-08-02

### Changed

- Add the finalized, approved BRC-147/150 1Sat Ordinals specifications to the Desktop standards package.

## [1.2.1] - 2026-08-02

### Changed

- Remove Twonk support; keep item permission hardening (view/send/receive separate from Pay).

## [1.2.0] - 2026-08-01

### Added

- Item permissions: view (optional collection/creator), send, and receive — separate from Pay.

### Changed

- Pay and Auto-pay never cover NFT / collectable spends.

## [1.1.16] - 2026-08-01

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.15] - 2026-07-31

### Changed

- BRC-125 PeerPay URIs on Receive (default QR) and Send (paste + optional sats).
- BRC-112 balance-basket fallback; BRC-114 time-label helpers for activity windows.

## [1.1.14] - 2026-07-31

### Changed

- BRC-140 key slices (2-of-3) for recovery; store slices in different places.
- BRC-38/39 wallet data backup (download/import wallet.brc39; optional custom URL — HandCash host left blank).
- Settings: open app logs folder for support.
- Restore via BRC-140 share paste on auth.

## [1.1.13] - 2026-07-31

### Changed

- Remove Chat (Lab chat, BRC-218 composer, in-thread pay cards, and related nav/settings).

## [1.1.12] - 2026-07-31

### Changed

- Surface sync / held 1-sat / migrate-style errors in the wallet UI (not console-only).
- Clarify identity key vs payment address on Identity, Receive, and Send.
- Require backup confirmation before first outbound send or app connect.
- Unlock nudge when the BRC-100 bridge is hit while the wallet is locked.
- Windows release CI workflow (`latest.yml` + installers on tag).
- Gate `encrypt` with other action methods; document migrate bridge hosts.

## [1.1.10] - 2026-07-31

### Changed

- Compact collectable details (side hero, scroll); Origin/Outpoint at bottom; traits via Aeon MetricStrip.
- Inventory Send affordance; Lab/About statecharts cleanup; settings chart id fix.
- Consume aeon-ui-engine ^1.3.5.

## [1.1.9] - 2026-07-31

### Changed

- In-chat pay/request confirm (no Send redirect); Lab Chat flag; quieter receive SFX on sync.
- Statecharts: stable fit/zoom, taller labels, click a linked state to open its chart.

## [1.1.8] - 2026-07-31

### Changed

- Chat (BRC-218 commands), opt-in wallet SFX, favicon retry, compact statecharts, desktop icon mark inset.

## [1.1.7] - 2026-07-31

### Changed

- Mac updates open the arch-matched GitHub DMG (ShipIt still blocked until Developer ID).
- Screenshot to clipboard (⌘⇧S) with version badge; About statecharts.

## [1.1.6] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.5] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.4] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.3] - 2026-07-31

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.2] - 2026-07-30

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

## [1.1.1] - 2026-07-30

### Changed

- Fix Mac release CI workflow YAML so dmg integrity checks run on tag push.

All notable changes to HandCash Desktop are documented here.

## [1.1.0] - 2026-07-30

### Added

- Cursor-style update mode (default / manual / none) with `appUpdate` statechart.
- Aeon 1.2.0 product shell: brand palette, StatusBanner, Prompt, `launch:mac`.
- Collectables send/detail flow; GitHub prerelease update feed wiring.

### Fixed

- Update Mode selectable without Electron bridge; durable prefs for mode.
- Missing `app-update.yml` on arm64 `dir` packages (feed URL + launch inject).

## [1.0.0] - 2026-07-30

### Added

- Initial BETA release — self-custodial BRC-100 Desktop wallet.
