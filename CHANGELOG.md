# Changelog

## [1.2.70] - 2026-08-06

### Fixed

- **One bad deposit threw away every other deposit in the scan.** Legacy sweeps
  let `SetupClient.fundWalletFromP2PKHOutpoints` build its own input BEEF. That
  builder reads raw transactions from two hardcoded URLs and asks GorillaPool
  alone for merkle proofs; when a proof comes back empty it walks every parent
  input instead. So one silent proof miss fans out into a request per ancestor
  per level against the same two hosts it depends on — they rate-limit, the
  throttled response carries no CORS headers so the browser reports
  `TypeError: Failed to fetch`, and the resulting throw is raised *outside* the
  per-outpoint `try`. The whole batch died with it, which is why a P2P payment
  could simply never arrive. The wallet now builds the BEEF itself
  (`legacyBeef.ts`) through the toolbox's multi-provider service rotation,
  caches raw transactions and proofs (neither can change), spaces requests out,
  and contains a failure to the one outpoint it belongs to. Unprovable outpoints
  stay retryable instead of being marked done.
- **`Services.getHeight()` had no failover.** It reaches past `getChainTracker()`
  into `services.options.chaintracks`, so 1.2.69's fallback never saw the call
  and every height lookup still failed against the dead Chaintracks host. The
  monitor holds that same object, so patching it covers both callers.

### Removed

- **`ReviewProvenTxs` monitor task.** It is a lagged backup audit for reorgs that
  `TaskReorg` already handles from header events, and it resumes from the last
  height it recorded — a wallet that has never completed a run starts at block 0
  and issues 100 header lookups a minute, forever, about transactions that are
  not ours. That load was competing with deposit lookups on the same
  rate-limited providers.

## [1.2.69] - 2026-08-06

### Fixed

- **Nothing new synced: the chain tracker was down.** `mainnet-chaintracks.babbage.systems`
  answers HTTP 500 (`At least one bulk ingestor must implement getPresentHeight`).
  `Beef.verify` needs a chain tracker, and the toolbox points every incoming path
  at that one host — so internalizing an ordinal failed as "valid AtomicBEEF",
  legacy sweeps failed as "valid Beef when factoring options.trustSelf", and
  `ReviewProvenTxs` errored on every pass. All three read like corrupt data; all
  three were one dead host. Merkle-root checks now fail over to WhatsOnChain,
  which serves the exact blocks these BEEFs reference.
- **Incoming ordinals could never be internalized.** The BSV SDK validates
  `internalizeAction`'s `customInstructions` at a hard 1000 characters. We attached
  the BRC-150 v2 remittance, which is ~400k — our own budget was set to 400,000,
  i.e. 400x over a limit we never checked against. Every incoming item threw
  before anything was written. The remittance is built locally from chain data and
  is not sender-supplied, so the receive path now stores identity only and
  `verifyItemAuthenticity` rebuilds provenance on demand as it already did.

## [1.2.68] - 2026-08-06

### Fixed

- **Incoming PtP payments could be permanently written off.** The legacy sweep
  that credits every received payment goes through `fundWalletFromP2PKHOutpoints`,
  whose `createAction` passes only `{ trustSelf: 'known' }` — so it inherits the
  SDK's delayed broadcast. A reported `success: true` therefore means "queued
  locally", not "sent". We then durably marked the outpoint imported, and
  `legacyImportGuard` marks are permanent by design.
- v1.2.40 deleted the self-heal that covered exactly this case
  (`retryableStuckSweeps` / `forgetLegacyImported` / `txExistsOnChain`) because it
  was making sync crawl. After that there was no un-mark path left in the wallet
  at all: a sweep that never reached a miner left the coins unspent on the address
  behind a permanent blacklist, while the log claimed "balance should already
  include them".
- The heal is restored, and stricter than before. It only runs in the stuck state
  (nothing imported, marks present, coins still on the address), and it now
  requires a *recorded sweep txid that is provably absent* from the chain. The
  old version treated "no recorded txid" as retryable, which is what booked one
  deposit three times; absent proof, the mark stands.

## [1.2.67] - 2026-08-06

### Fixed

- Release build for 1.2.66 failed typecheck on a new test file's mock types.
  Same payment fixes as 1.2.66, shipped.

## [1.2.66] - 2026-08-06

### Fixed

- **BSV payments were never broadcast by the send itself.** `acceptDelayedBroadcast`
  defaults to **true** in the SDK, and `sendSatsToAddress` passed no options — so
  `createAction` only queued the transaction for the monitor's `TaskSendWaiting`
  loop. Worse, the toolbox skips `throwIfAnyUnsuccessfulCreateActions` in delayed
  mode, so a broadcast that never happened returned a txid and looked like a
  success. Payments now send undelayed and a failure is an error. Collectable
  sends already did this, which is why items went out and money did not.
- Pre-send "checking balance" was running the full chain ingest, including an
  indexer walk for every unidentified one-sat. A payment cannot spend an ordinal,
  so the spend heal now sweeps funding only — no tip lookups, no item or latch
  internalization on the path where the user is waiting.

## [1.2.65] - 2026-08-06

### Fixed

- Desktop sync felt slower than mobile for a silly reason: `yieldToUi` used
  `requestIdleCallback` with a 120ms timeout, and during ingest the main thread
  stays busy so every yield waited out the full timeout. Electron has ric;
  Android WebViews often do not — so mobile already fell through to
  `setTimeout(0)` and finished sooner. Yields now always use `setTimeout(0)`.
- First post-unlock chain poll and the toolbox monitor start immediately on
  desktop; phone shells keep the longer deferral that protects unlock taps.
- Peer BRC-153 transfers: a co-created 2-sat latch is local proof that OUTPUT:0
  is an ordinal tip. Latch-proven tips bypass the 10-minute miss backoff and
  surface as "Item arriving" instead of silently sitting in held dust.
- Top bar control heights aligned across Activity / Collectables / Friends.
- HandCash handles display as `$handle`; BRC-CLOUD claims require an HMAC claim
  ticket (or operator key).

## [1.2.64] - 2026-08-06

### Fixed

- Images stopped loading past the first few. The concurrent-decode cap added in
  v1.2.58 handed out a slot when a frame came near the viewport but only
  returned it on unmount, so the first three visible cards held all three slots
  for as long as they stayed on screen and every other image queued forever.
  The cap exists to limit simultaneous *decodes*, so the slot now goes back the
  moment an image settles; the `src` stays attached to keep the frame painted.
- Raised the cap from 3 to 6, and a request that never answers now gives up its
  slot after 10s so one dead host cannot hold the queue shut.
- Extracted the semaphore to `imageLoadSlots.ts` with tests, including a guard
  for the starvation case above.

## [1.2.63] - 2026-08-06

### Fixed

- The crash was the BRC-39 cloud backup, and it was a self-sustaining loop.
  Auto-sync runs on every unlock and encrypts the whole wallet with Argon2id at
  the canonical BRC-39 parameters — 7 passes over 128 MiB — on the UI thread.
  That is the ~3s block in every log, which is why the stall followed whichever
  tab happened to be tapped and why `[cloud-backup] auto-sync ok` never once
  appears: the WebView was killed mid-KDF, so the upload never recorded success,
  so the next launch tried again. New NFTs made it worse by enlarging the
  BRC-38 document that gets encrypted.
- Argon2id and AES-GCM now run in a dedicated worker, which is terminated after
  each backup so its 128 MiB WASM heap is returned instead of held for the
  session. The UI thread no longer blocks on a backup.
- Added a durable crash-loop breaker. An attempt is marked open before the
  export and reconciled at boot; an attempt that never closed counts as a
  failure and delays the retry (5m → 30m → 2h → 12h → 24h). A success clears
  the streak, and a manual "Back up now" ignores the hold.
- Automatic backups no longer re-derive the vault key. `createBrc39BackupBytes`
  was running a second 210k-iteration PBKDF2 to re-check a password the session
  had already proven at unlock.

## [1.2.62] - 2026-08-06

### Fixed

- True freeze was wallet-toolbox `TaskMonitorCallHistory`: on every unlock it
  JSON.stringifies the entire services call log and writes it to IndexedDB on the
  main thread. Every crash log showed that line right before a ~3s stall while
  tapping Friends/Apps/Identity/Settings — not Collect-specific. That task is
  removed, and the rest of the monitor loop starts only after idle.
- Activity NFT thumbnails restored (lazy DeferredImage).
- DeferredImage no longer force-loads every card 350ms after mount.

## [1.2.61] - 2026-08-06

### Fixed

- True freeze cause was wallet sync, not tabs. Latest log: soft-latch ingest mid-tap
  then a 2.8s main-thread stall. Latch dust stays on the address after basket
  insertion, so every Dashboard poll re-fetched BEEF and ran `internalizeAction`
  on the UI thread. Known latches are skipped, failed imports back off for 5
  minutes, BEEF work yields to the UI, the first post-unlock poll waits for idle,
  and background polls no longer run the spendable audit.

## [1.2.60] - 2026-08-06

### Fixed

- Latest log was Settings → Identity then a 3s stall on first QR open. Identity QR
  pre-warms at unlock and is cached per key. Light tabs stay mounted once visited;
  Collectables still unmounts when you leave it.
- Activity had the same remount cost. The feed snapshot is cached per limit, rows
  render in batches, and NFT activity lines use an icon in the list — full ordinal
  images only on the payment detail view, not 200 decodes at once.

## [1.2.59] - 2026-08-06

### Fixed

- Latest crash log was rapid Activity ↔ Identity tab taps. Identity regenerated its
  QR on every mount; it is now cached per identity key. Light tabs stay mounted
  once visited; Collectables still unmounts when you leave it.

## [1.2.58] - 2026-08-06

### Fixed

- Revert the keep-alive nav experiment. Mounting every visited tab at once stacked
  panel trees and ordinal images until Android killed the WebView — logs showed 3s
  main-thread stalls with heap still at 10MB, which is native memory pressure, not
  a JS OOM. Only the active section mounts again, like yesterday.
- Collect opens from cache immediately; network refresh waits for idle time.
  Cards render in small batches per frame instead of all at once.
- Ordinal images decode at most six at a time, and authenticity checks run when
  you open an item — not for the whole basket after every list.

## [1.2.57] - 2026-08-06

### Fixed

- Sections scroll again. Keeping panels mounted put a wrapper element between
  the stage and each panel, which broke the flex chain the panels size against:
  nothing could scroll, and the longest list — Settings — froze on open while
  the layout tried to resolve a percentage height against an unbounded parent.
  A slot is now `display: contents`, so a visible panel sits in the stage's flex
  chain exactly as it did before it stayed mounted.
- The stage picks its layout mode from the section on screen. With every visited
  section mounted, a background panel's empty state was reflowing the visible
  one.
- Opening a friend, an app or a setting no longer tears down every mounted
  section, so coming back does not remount them all at once.

## [1.2.56] - 2026-08-06

### Fixed

- Rapid nav-bar tapping no longer freezes the UI. Root section panels stay
  mounted and are shown/hidden instead of remounting whole trees on every tap.
  Soft SFX is rate-limited, and nav breadcrumbs are debounced so the log path
  itself cannot pile up during a burst of taps.

## [1.2.55] - 2026-08-06

### Added

- Freeze detection. A blocked main thread raises no error and stops all other
  logging, so a 500ms timer now reports how late it ran, long tasks over 800ms
  are attributed where the runtime supports it, and a 5s heartbeat marks exactly
  when the app stopped responding.
- Foreground/background transitions are logged, which separates an OS reclaim
  after backgrounding from a freeze the user was staring at.

### Fixed

- Image viewport observers are created once per frame instead of on every
  load/release flip, since re-observing re-fires the initial callback and an
  element resting on the boundary could oscillate.
- The log tail is only written when there are new lines, halving the
  synchronous storage writes the diagnostics themselves cost.

## [1.2.54] - 2026-08-06

### Fixed

- Ordinal images are released once they scroll well clear of the viewport.
  Decoded bitmaps live in native memory rather than the JS heap, and ordinals are
  served at full resolution, so a grid of them could get the WebView killed by
  the OS while the JS heap still looked idle.

### Added

- Logs can be uploaded from Mobile, not just Desktop, and a recovered crash log
  is sent automatically at boot when an upload URL is configured.
- Navigation breadcrumbs and a warning past 40 simultaneously decoded images, so
  a crash log shows which screen the app was on and how much it was holding.

## [1.2.53] - 2026-08-06

### Added

- Logs survive a crash. The tail is mirrored to durable storage (immediately on
  any error) and reloaded on the next start, so the log viewer opens with the
  previous session's final lines instead of only the fresh restart.
- The session banner records the running version, heap use and device, which is
  what pins a crash to a build.
- Heap pressure is sampled while visible and logged past 70% of the JS heap
  limit. An OOM kill raises no error, so this is the only footprint it leaves.

## [1.2.52] - 2026-08-06

### Changed

- An address holding only ordinals no longer logs a scary "no funding
  classified" warning. Only UTXOs that matched no class at all are reported.
- The all-basket spendable audit is attempted once per session. Storage builds
  that cannot filter on an undefined basket are remembered, so each sync goes
  straight to the default basket instead of throwing and retrying.

## [1.2.51] - 2026-08-06

### Fixed

- Opening Collect with many BRC-150 ordinals no longer OOMs the WebView. Listing
  no longer pulls every item's remittance BEEF (~400k chars each) or verifies it
  on the critical path. Authenticity still runs automatically after paint — one
  tip at a time, with UI yields — and verdicts are cached durably.

## [1.2.50] - 2026-08-06

### Fixed

- Audio unlock listeners no longer run on every tap for the life of the app —
  they unbind once the AudioContext is running. Tone nodes also tear down on a
  timer, because some Android WebViews never fire `onended` after `stop()`.
- Cap session receive-chime outpoints, prune inscription hit/miss maps, and
  expire stale permission-connect timestamps so a long unlock cannot grow
  unbounded Sets.

## [1.2.49] - 2026-08-05

### Fixed

- Collectables paint from a durable cache on open instead of waiting on
  `listOutputs`. Last session's inventory is shown immediately; the network
  refresh updates it in the background.
- Ordinal images load again. Android WebViews often never fire
  `IntersectionObserver` for elements already on screen; the frame is checked
  synchronously first, with a short fallback so a broken observer can never leave
  images on the skeleton forever.

### Changed

- GorillaPool is only consulted for ordinals remittance cannot verify. A P2P tip
  that already carries `origin:` (and optional BRC-150 provenance) is listed and
  detailed from local data — no indexer walk. Unverified tips on the receive
  address are still resolved once, then cached.

## [1.2.48] - 2026-08-05

### Fixed

- Tapping the nav bar no longer degrades the app click by click. Each sound left
  its oscillator and gain node wired to the destination, so the audio graph grew
  by a node per tap and was reprocessed every quantum. Nodes are now disconnected
  when the tone ends.
- Sending money no longer stalls on work it cannot use. The pre-send heal forced
  the spendable audit, which spends one UTXO-status request per output and, now
  that it never releases, only reports. Sends skip it.
- Classifying scanned UTXOs no longer re-walks the indexer for the same outpoint.
  Any 1-sat output that could not be resolved was walked again — up to ~100 serial
  requests each — on every background poll and before every send. Results come
  from `inscriptionCache` now, with a back-off for dust that never resolves.
- Flipping through the nav bar no longer stacks duplicate `listOutputs` queries;
  concurrent collectable listings join the in-flight read.

## [1.2.47] - 2026-08-05

### Fixed

- Collect page no longer freezes the phone. Listing items resolved every item
  through the indexer before painting, and each resolution walks the chain
  backwards up to 7 hops, spending a GorillaPool lookup plus a WhatsOnChain
  transaction fetch plus a lookup per input at each hop — hundreds of serial
  requests per open, repeated every 30s. The list now paints from the output's own
  tags and `customInstructions`, which is all it renders.
- Ordinal images are deferred until near the viewport again, so opening the grid
  no longer fetches every full-size image at once. Deferral is driven by an
  observer on the frame rather than `loading="lazy"`, which cannot work while the
  image is hidden.

### Added

- `inscriptionCache.ts` remembers resolved inscription metadata per outpoint, and
  keeps it across restarts. What an outpoint is inscribed with cannot change, so a
  resolved item is never walked again; misses back off for 10 minutes.

## [1.2.46] - 2026-08-05

### Fixed

- Change no longer disappears after a send. Sync called `reviewSpendableOutputs`
  with `release`, which writes `spendable: false` permanently based on
  `services.isUtxo` — and that returns `or.isUtxo === true`, so an indexer that
  has not yet seen our unconfirmed change, or a UTXO service that merely errored,
  both read as "spent". Sync now audits and reports only; it can no longer write
  off a single output.

### Changed

- Outputs are written off only on affirmative evidence: a spend the network
  rejected because an input was already spent (`staleOutputRelease.ts`). That
  still clears outputs spent on another device sharing the identity, which is
  what release was for, without the collateral damage.
- Removed `sendSettleGuard`. Its 10-minute window only delayed the write-off, so
  change from a transaction that took longer to confirm was destroyed anyway.

## [1.2.45] - 2026-08-05

### Fixed

- Ordinal images never loaded: `DeferredImage` hides the `<img>` until it loads, and a
  `display: none` image never satisfies lazy loading's intersection check, so it never
  fetched and sat on the skeleton forever. The component now always loads eagerly and
  ignores a caller's `loading` prop. Off-thread decoding (`decoding="async"`) is kept.

## [1.2.39] - 2026-08-05

### Changed

- Patch release (every push must ship a new version).

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
