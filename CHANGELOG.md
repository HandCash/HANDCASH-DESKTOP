# Changelog

## [1.3.30] - 2026-08-31

### Fixed

- Market purchase confirmation shows the listed item name and image from the market listing (buyer does not hold the tip pre-purchase).
- Market settlement accepts buyer BSV change from inscription-wrapped toolbox outputs instead of rejecting with “non-buyer change output”.
- Market purchase remittance uses the listing name; busy-state tracks `listing.outpoint`.

## [1.3.29] - 2026-08-31

### Fixed

- Strip dead 1sat-ft address-scan routing after BRC-175 removal: beta FT-shaped tips stay **held** on Refresh instead of misfileing into basket `1sat` or looping reimport.
- Collect list again shows bare P2PKH NFT transfer tips (self-sent / received ordinals) — ord envelope is not required at the live outpoint.
- Drop 1sat-ft basket scans from ingest heal paths; tokens remain BRC-162 / basket `bsv21` only.

## [1.3.26] - 2026-08-30

### Fixed

- Mobile Collect no longer flashes empty during sync: a short or empty `listOutputs` page keeps the durable cache and merges new outpoints instead of replacing 777 cards with zero.
- View items / View tokens Allow persists on the originator (creates the connected row if missing; market hosts share one grant) so catalog reloads, reconnect, and `getTokenIcon` do not re-prompt. Send/list/buy still prompt.

## [1.3.25] - 2026-08-30

### Changed

- Split BSV-21 listAmt to an exact 162 lock before listing so advert.amt matches the 176 proof. Mobile Collect shortLabel. Inbound :3321 requests yield cloud-backup so the permission prompt is not stuck behind Argon2.


## [1.3.24] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.23] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.22] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.21] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.20] - 2026-08-29

### Changed

- Purchase intents last 15 minutes so a slow phone approval still posts.

## [1.3.19] - 2026-08-29

### Fixed

- Token cards keep the deploy cap as held / max instead of infinity.
- Approve preview no longer imports a missing TokensIcon (black screen).

### Changed

- Token UI hides origin/outpoint.

## [1.3.18] - 2026-08-29

### Fixed

- Market list/buy/cancel: 162 unlock hashes the full script, overlay listings carry the offer PushDrop, failed overlay publish marks Activity failed, cancel logs a failed row instead of dying silent.
- List/send approve and the Working panel show the same item card (collectable or token) in the side column.

### Changed

- Permission list title uses ticker/units. Duplicate generic "List item for sale" Activity rows are gone.

## [1.3.17] - 2026-08-29

### Changed

- Tokens are BRC-162 / basket bsv21. List and buy keep the 162 lock. Messagebox remittance re-signs a fresh timestamp. Collect stays 1sat. Token details paint issuer from Sigma or remittance. Activity is one history row.

## [1.3.16] - 2026-08-29

### Fixed

- **Leftover 1sat-ft keeps mint ticker and supply.** After a send, Tokens still show KING and the locked cap instead of a blank origin / no supply cap.
- **Fingerprint lock icon is the official Material filled 24px path.**


## [1.3.15] - 2026-08-29

### Fixed

- **1sat-ft mint icons no longer list as NFTs.** The image sibling on a colour genesis stays decorative. Refresh drops ones already filed in Collectables.


## [1.3.14] - 2026-08-29

### Changed

- Leftover 1sat-ft tips now inscribe {amt} on chain. Origin comes from the BRC-150 spend-chain walk. Remittance is a fast path only.

## [1.3.13] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.12] - 2026-08-29

### Changed

- Patch release (every push must ship a new version).

## [1.3.11] - 2026-08-28

### Fixed

- **Leftover 1sat-ft no longer lists under Collectables.** Hashed origin-only cards and misfiled FT tips stay on Tokens. Named 1sat items still paint during sync.
- **Fungible identity is the origin.** Cards, details, and send show the 1sat-ft origin (middle-ellipsis `txid…txid_vout`), not the local held outpoint.
- **History-less 1sat items can finish BRC-150.** Parent hops fetch WhatsOnChain / indexer BEEF when local storage misses. Same-origin siblings reuse that cached origin tx; each tip still proves its own hops down to origin.

## [1.3.10] - 2026-08-28

### Fixed

- **Sync no longer beeps without a toast.** Rediscovered 1sat items stay silent unless a new receive actually toasts.
- **Unverified 1sat cards stay on Collectables during sync.** A longer live list wins over a shorter cache; BRC-150 can fetch BEEF from the network instead of hiding on a local miss.
- **Issuer row is omitted when the mint has none.** No "Not supplied". Leftover remittance still copies `issuer:` when the origin JSON had it.

### Changed

- Nav and inventory say Collectables. Dashboard identity chip has no pfp next to the balance.
- Settings appearance and updates are icon pills (Monitor / Moon / Sun, Repeat / Touch / Block).
- Screenshot is a real **Take screenshot** button with the shortcut under it. Check update is a real button.


## [1.3.9] - 2026-08-28

### Fixed

- **KING leftover follows the live tip.** After send `2a562450`, remittance is change `68931` — never re-seed spent `9abe8bdb` `69000`.
- **Dashboard tip-chase backs off.** Stale inbox/chat hints no longer re-run funding-only Refresh every 5s; new txids still ingest immediately.
- **Animated QR no longer burns CPU.** Frame assembly is incremental instead of a full redraw chase.

### Changed

- Settings uses Aeon controls. Send, burn, camera, and QR share the same sheet language.
- Identity chip shows handle, then BRC-169 key, then PeerPay — one label.
- Collect stays 1sat. Token details paint issuer from Sigma or remittance. Activity is one history row. Tokens stays 1sat-ft. FOX / BSV-21 is dead.

## [1.3.8] - 2026-08-28

### Fixed

- **Linux AppImage `tsc` is clean again.** Unused locals (`opts`, leftover imports, `BEEF_TIMEOUT_MS`) and reclaim/icon type errors no longer fail `build:renderer`.

## [1.3.7] - 2026-08-28

### Fixed

- **Tokens balances match the live UTXO set.** After send/burn, leftover 1sat-ft tips show remaining `amt` (KING `69000 / 69420`) instead of the spent mint total.
- **Spent genesis burns stay hidden.** Burned KING origins are marked spent-forever and cannot come back from cache.
- **Bare leftover change still lists.** Toolbox often drops the 1-sat P2PKH change; leftover remittance is seeded so Tokens still paints the held tip.

## [1.3.6] - 2026-08-28

### Fixed

- **Tokens list is 1sat-ft only.** Durable cache drops leftover Collectable / FOX / Pixel Foxes rows so they cannot return on reload.
- **Refresh no longer hammers WhatsOnChain `/unspent/all`.** Spendable indexer review is report-only and is skipped (WOC 429 + CORS were stalling sync).
- **CoinGecko / WhatsOnChain FX cools down for 15 minutes after a 429.** Price panel keeps the last cached rate instead of retrying in a loop.

### Changed

- Collect stays 1sat collectables. Tokens stays BRC-175 `1sat-ft`. BSV-21 / FOX is leftover and is not listed.
- Desktop Scan lives off main nav. Touch ID circle sits under the password field.

## [1.3.5] - 2026-08-28

### Fixed

- **1Sat FT tips unlock correctly on send/burn.** Inscribed tip sighash uses the
  full locking script (inscription ‖ P2PKH), matching collectables / BSV-21.
- **Bare FT transfer tips are no longer painted as collectables.** Address scan
  walks tip lineage; `application/1sat-ft+json` ancestors hold instead of basket
  `1sat` (stops “Received ITEM” spam after FT sends).
- **Misfiled FT tips reclaim into `1sat-ft`.** Refresh drops NFT duplicates and
  moves bare FT-lineage tips out of basket `1sat`.
- **Touch ID no longer prompts on window close / alt-tab.** Hide locks after a
  grace period; device unlock waits until the lock screen is visible again.
- **Chaintracks hangs fail over in ~3s** to Bitails/public headers; Taal ARC is
  demoted so 401 noise is not first on every broadcast.

### Changed

- Colour (1sat-ft) burn path + amount preview; click-to-copy error banners on
  burn/send fungible.
- Docs: BRC-175 mirror + BRC-147 bare-transfer coexistence notes.


## [1.3.4] - 2026-08-27

### Fixed

- **Self-sent 1Sat ordinals now appear on Refresh.** Inscribed tips are invisible
  to WhatsOnChain/Bitails address UTXO lists; Refresh also queries GorillaPool
  for unfiltered 1-sat tips (alongside the existing BSV-21 `bsv20` probe) and
  imports them into basket `1sat`.

## [1.3.3] - 2026-08-27

### Changed

- **Peer remittance asset kind is `1sat-ft`.** Same id as the storage basket
  (renamed from the brief `onesat-ft` alias).

## [1.3.2] - 2026-08-27

### Changed

- **Peer remittance asset kind is `onesat-ft`.** Replaces wire `colour` so P2P
  settle matches basket `1sat-ft`.

## [1.3.1] - 2026-08-27

### Changed

- **1Sat fungibles use basket `1sat-ft` only.** Removed the legacy `colour`
  basket dual-read from list, permissions, and layer counts.

## [1.3.0] - 2026-08-27

### Added

- **1Sat fungibles (BRC-175).** Tip→origin tokens in basket `1sat-ft` with
  face-value `amt` (balance = Σ amt). Sends spend tips and create payee + change
  tips with conserved units; locked supply on the origin is optional.
- **Combine tips** on token details when you hold 2+ tips — same balance, one tip,
  small network fee (self-send, no peer notify).
- **Device unlock factors** for vault v3 (Desktop + shared unlock settings).

### Changed

- Legacy BSV-21 Collect rows stay read-only; native fungible send uses the 1Sat
  path only.

## [1.2.303] - 2026-08-23

### Fixed

- **Settings scroll works on Linux.** Nested `overflow` on the settings body was
  eating wheel events while the outer stage could not scroll. The main settings
  list now scrolls on `wallet-nav-stage` only; detail screens scroll on
  `nav-child-body`. Horizontal overflow from the sticky header plate is clipped.

## [1.2.302] - 2026-08-23

### Fixed

- **Settings scrolls on Linux and Windows.** Detail screens now use the same flex
  scroll container as Send/Receive; the main list no longer traps overflow.

### Changed

- **Settings layout simplified.** Removed list/grid toggle (inline controls do not
  fit a grid). Sections are Security, Preferences, Support, and About. Log upload
  and folder actions moved into the session log viewer; the index is shorter.

## [1.2.301] - 2026-08-23

### Fixed

- **BSV-21 sends no longer remain stuck on “Preparing”.** Fungible sends declared
  custom token inputs without supplying their source BEEF, so the toolbox could
  reserve the action and wait indefinitely while resolving them. Token sends now
  provide the selected transactions explicitly, continue through the manual
  signing path, and abort any preparation still stalled after 45 seconds.

## [1.2.300] - 2026-08-23

### Fixed

- **BSV-21 sends no longer remain stuck on “Preparing”.** Fungible sends declared
  custom token inputs without supplying their source BEEF, so the toolbox could
  reserve the action and wait indefinitely while resolving them. Token sends now
  provide the selected transactions explicitly, continue through the manual
  signing path, and abort any preparation still stalled after 45 seconds.

## [1.2.299] - 2026-08-23

### Fixed

- **BSV-21 sends no longer refuse as “unrecognized lock”.** `listOutputs` often
  omits the locking script (same toolbox `scriptOffset` gap as collectables), and
  inscribed tips can carry the ord envelope before or after the P2PKH branch.
  Basket-held plain tips now send; foreign locks still refuse when the script is
  present and does not pay this wallet.
- **Windows scrollbars show and drag again.** Hover-only scrollbar thumbs stayed
  invisible in Electron on Windows (and Linux). Nav panels, activity lists, and
  the main stage now keep a visible thumb and a normal 10px track.

## [1.2.298] - 2026-08-23

### Changed

- **Settings list or grid.** Security and About destinations match Connected apps /
  Friends — toggle in the header; Application and Logs stay full-width rows.
- **BSV logo easter egg everywhere.** Triple-tap the market logo for the classic dragon;
  Recent activity follows; no selected chrome on the hidden toggle.
- **Flatter send surfaces.** BSV panel and recipient picker drop extra box shadows.
- **Clearer log upload copy.** “Upload logs” explains when to send and that the URL is
  pre-filled unless support gives you another.

## [1.2.297] - 2026-08-23

### Fixed

- **Windows builds publish again.** The build step ran under PowerShell, which rejects
  `rm -rf`, and the checksum verifier was unparseable by node — so no Windows installer
  has shipped since those landed. Same app code as 1.2.296, which reached macOS and Linux
  only.

## [1.2.296] - 2026-08-23

### Fixed

- **Incoming BSV-21 tokens now arrive.** A token transfer re-inscribes its JSON, so the
  output is P2PKH plus an ord envelope — a shape the address explorers report as
  nonstandard and list against no address. Every provider behind the address scan missed
  it, so tokens sent from outside the wallet never appeared. The ordinal index is now
  asked alongside the address scan and finds them.
- **Token balances credit the transferred amount.** Import read the amount from the
  token's origin, which holds the mint's balance or an earlier hop's, so a transfer could
  land showing the sender's prior total instead of what they sent.

### Changed

- **Collectables paint on arrival** when an app hands one over, instead of waiting for the
  next Refresh to notice the tip.

## [1.2.295] - 2026-08-23

### Fixed

- **Windows OTA checksum mismatches.** CI regenerates `latest.yml` from the NSIS
  installer before upload and verifies sha512; channel metadata publishes after
  the `.exe`. Updater clears stale cache and retries once on checksum failure.

## [1.2.294] - 2026-08-23

### Changed

- **Settings rows** now use standard Material icons with a consistent leading slot.
- **Identity tab** compacts to a hero row (QR + handle) and field list — less wasted
  vertical space on mobile, aligned with Settings / Apps density.
- **Light-mode skeletons** use a dark shimmer so connected-app loading states stay
  visible on white sheets.

## [1.2.293] - 2026-08-23

### Fixed

- **Light mode Messages uses the paper sheet.** Chat scope tokens for the
  messages shell and sidebar head now follow the light brand surface instead of
  leftover dark rail colors.

## [1.2.292] - 2026-08-23

### Fixed

- **The hero balance updates when a payment lands outside Dashboard Refresh.**
  BRC-29 internalize, SPV tip ingest, and inbox poll now push the display balance
  to the session chart so mobile and desktop paint the new total without waiting
  for the next manual sync.
- **Receive toasts fire only when the balance actually rises.** Re-internalizing
  an already-swept payment, or crediting money that was already in the wallet,
  no longer announces "Payment received."
- **A failed item send releases sealed funding inputs.** After sign+seal, any
  failure path (including inbox errors) now un-seals inputs so the balance does
  not stay artificially low until the next maintenance pass.

### Changed

- **Wallet progress lives on the phrase sweep panel only.** The Activity feed no
  longer shows a generic "Importing" row with a progress bar — that chrome is on
  Settings → Import phrase while a sweep runs.

## [1.2.291] - 2026-08-23

### Fixed

- **Refresh no longer toasts "Payment received" for money you already had.**
  Any balance rise during Refresh used to announce a new payment — including
  when sealed inputs were reclaimed, pending change was restored, or a thin
  Toolbox was healed. The toast now fires only when this pass actually swept new
  funding from your legacy address.
- **The hero balance no longer drops when a confirmed-only read omits pending
  change.** A live local send credits pending change on the display path only;
  a lower confirmed total is normal and must not paint $0.03 when the wallet
  still holds $0.15 including in-flight change. The partner-app balance cache
  now keeps the full display total instead of shrinking on confirmed-only reads.
- **Unlock no longer downgrades the hero from a confirmed-only read** while the
  display path is still crediting pending change from live local sends.

## [1.2.290] - 2026-08-23

### Fixed

- **Collectables stranded by stale import marks heal on large inventories.**
  Orphan 1-sat mark healing only listed the first 2000 basket rows, so wallets
  with more items never cleared stale "already imported" marks and Refresh could
  not re-claim tips still live on the address. Healing now pages through the
  full basket the same way Collect does.
- **Deposits marked imported without a sweep txid can sweep again.** Legacy v1
  import marks and sweeps that never recorded a txid blocked every retry. When
  the outpoint is still on the address scan, Refresh now forgets the mark and
  sweeps again instead of leaving funds stranded behind a permanent guard.
- **Sync health reports tips still awaiting indexer identity.** `pendingTips`
  was always empty, so the status pill and poll cadence never reflected 1-sat
  outs held while the indexer names them.

## [1.2.289] - 2026-08-22

### Fixed

- **Refresh now rebuilds missing change scripts before restoring spendable
  balance.** BRC-39 merges and device sync can leave change outputs with
  satoshis but no locking script. Maintenance tried to promote those rows back
  to spendable, skipped them as unscripted, and moved on — so spendable stayed
  at zero while the display still credited the same coins as pending change. Pay
  could not select them. Refresh now runs a chain-backed script rebuild (looped
  until a pass heals nothing) before the spendable-restore loop.

## [1.2.288] - 2026-08-22

### Changed

- Patch release (every push must ship a new version).

## [1.2.287] - 2026-08-22

### Fixed

- Ship the 1.2.286 stdout crash fix, whose installers never built: the new
  test imported a relative path without a file extension, which the renderer
  typecheck accepts but the Electron build (`nodenext`) rejects.

## [1.2.286] - 2026-08-22

### Fixed

- **A lost log stream no longer looks like a crash.** When HandCash outlived
  whatever was reading its output — a terminal the holder closed, a launcher
  that exited — the next diagnostic line failed with `write EPIPE`, and because
  nothing was listening for that error it escalated into an "Uncaught Exception"
  dialog over a wallet that was working fine. Write failures on the output
  streams are now handled where they happen. The file log, which is what support
  actually reads, is unaffected.

## [1.2.285] - 2026-08-22

### Changed

- **Sweep** replaces “Import phrase” in Settings for moving another wallet in.
- **Removed “Open a web app” URL field** on mobile (apps open via Scan / deep
  links / connected apps). Dropped the balance hero sync subtitle.

## [1.2.284] - 2026-08-22

### Fixed

- **Phrase import now auto-restores history when a cloud backup exists.** Second
  devices with the same seed pull BRC-39 automatically instead of waiting for a
  manual tap or showing a stale zero balance. Skip is only offered when no backup
  is on the host. Restore uses wipe-local-then-pull; auto push still refuses to
  overwrite a protected remote with empty or thin local state.

## [1.2.283] - 2026-08-22

### Changed

- **Tighter empty states and nav padding.** Empty tabs no longer scroll on
  nothing; connected-apps drops the inline URL launcher (apps still open via
  Scan and deep links).

## [1.2.282] - 2026-08-22

### Fixed

- **Collectables that vanished from a device now come back on Refresh.** The
  wallet keeps a durable note of every 1-sat tip it has imported so the same
  item is never internalized twice. That note lives outside the item database,
  so when the database was replaced or restored thin, the note survived and
  Refresh skipped hundreds of items as "already imported" — leaving them
  invisible even though they were sitting unspent on the address. Refresh now
  clears the note for any tip that is live on the address but missing from the
  basket, and re-imports it. Items the holder deliberately forgot, and tips a
  send just spent, are left alone.
- **A large re-import paints as it goes.** Items are imported in batches, and
  the inventory now refreshes after each one instead of after all of them, so a
  recovery of several hundred items no longer looks frozen on a stale count.

### Changed

- Refresh reports its own progress — including the phase after the status pill
  clears — so a long import reads as work in progress rather than as finished.

## [1.2.281] - 2026-08-22

### Fixed

- **A cold launch no longer shows a balance of zero.** Unlock raced the local
  read against a 500 ms timer that resolved to a literal zero, so an identity
  without a stored figure entered the wallet looking empty until a later read
  healed it. Unlock now opens on this identity's last confirmed figure when one
  exists, waits for a real answer when it does not, and refuses rather than
  reporting zero when the store cannot be read. A balance that is genuinely
  zero still shows zero.
- **Collectables stay on screen while history restores.** Recompose replaces
  local state before pulling BRC-39, and a basket read in that window succeeded
  against a half-restored database — so a launch holding hundreds of items
  painted them, replaced them with none, then rebuilt to a handful, persisting
  the empty list for next time. Only the relist that runs after local state is
  replaced can now empty the view, and a truly empty inventory still reads as
  empty.

## [1.2.280] - 2026-08-22

### Fixed

- **"Internal error." when unlocking a wallet that is open elsewhere.** Chromium
  locks the IndexedDB partition holding toolbox state, so a second copy of
  HandCash on one profile could not read it and the unlock screen showed
  Chromium's raw text — a correct password looked rejected and the wallet looked
  corrupt. A second instance now focuses the running window and exits, so the
  collision cannot happen; opening an old copy before an upgraded one was enough
  to trigger it.
- **An unlock failure explains itself.** A store that cannot be opened now says
  to quit any other copy or restore with the recovery phrase, and notes that
  coins are on-chain rather than in that file; a full disk says so instead of
  implicating the wallet. An unreadable store opens the recovery form the way a
  phrase mismatch already does, and the untranslated error stays in the app log
  for support.

## [1.2.279] - 2026-08-22

### Added

- **Phrase import finds Centi funds.** Centi keeps its coins under
  `m/44'/145'/0'/0/n`, and only coin type `236'` was ever scanned, so a Centi
  phrase came back empty. Both Centi chains are now scanned — receive and
  change, twenty addresses each — and every hit is signed with the child key
  that locks it. Use Settings → Import phrase; wallet Restore still expects a
  HandCash phrase.

### Changed

- **A market listing reads as a listing.** Creating an offer said "Sending…",
  the crumb read "Activity / Activity", and the detail body showed the internal
  method name as "ACTION: approve". A listing now says "Listing…", a
  cancellation "Cancelling…", and a purchase "Buying…", the crumb carries the
  row's own title, and the detail shows status and app instead of a method.

## [1.2.278] - 2026-08-21

### Fixed

- **Listing an item no longer rebuilds its origin.** Publishing inlined every
  BRC-150 path body the proof carried by reference — for a batch-mint item, a
  multi-megabyte origin — and inlining it is what pushed the proof past the
  overlay's size budget, so the result was measured, discarded, and the proof
  the wallet already held was published instead. The wallet now checks what the
  overlay will fetch for itself before spending anything on it.

## [1.2.277] - 2026-08-21

### Fixed

- **Apps that look for `localhost` can find the wallet.** The BRC-100 bridge now
  also listens on the IPv6 loopback. `WalletClient('auto')` from `@bsv/sdk`
  dials `localhost`, which resolves to `::1` before `127.0.0.1` on most hosts,
  so a client that did not retry the IPv4 address saw no wallet at all. Only the
  loopback is added, and a host without IPv6 keeps the existing listeners.

## [1.2.276] - 2026-08-21

### Fixed

- **Release builds typecheck again.** Cross-repo overlay contract tests stay in
  `vitest` and are no longer compiled as part of the app, so CI no longer
  requires a sibling BRC-CLOUD checkout.


## [1.2.275] - 2026-08-21

### Fixed

- **Listing approval can no longer be clicked twice, and a timed-out request no longer stays on Approving…** One permission prompt accepts one decision. After approve, the wallet paints the processing panel before provenance work starts. A bridge timeout cancels the orphaned prompt.
- **Market inventory shows origin-verified collectables, not only items that arrived with remittance.** The wallet projects its durable BRC-150 verdict and the origin it walked to. A minted or imported tip rebuilds a publishable proof at listing time.
- **BRC-100 discovery is `POST /getVersion`, matching WalletClient.** Method responses are labelled `application/json`.
- **Listings emit the overlay's 20-field signed BRC-48 PushDrop and a self-contained BRC-150 proof.** Batch-mint origins that exceed 1 MB JSON may slim to txid-only; the overlay hydrates those bodies itself within a bound.
- **Collectable sends seal their inputs** so a later BSV send cannot pick the same coins. Sealed inputs of a transaction that never reached a node can be released, and Refresh reclaims coins the indexer still reports unspent.
- **History backup refuses to encrypt a BRC-38 document over 64 MiB**, so a large inventory cannot OOM the renderer.


## [1.2.274] - 2026-08-21

### Changed

- Patch release (every push must ship a new version).

## [1.2.273] - 2026-08-21

### Fixed

- **Market listings now use revocable on-chain BRC-48 offer tokens.** Listing,
  cancellation, purchase, and seller settlement follow explicit state machines
  with durable crash recovery.
- **Signed settlements cannot be aborted or erased by general no-send cleanup.**
  Buyers retain the transaction data needed to rebroadcast, and sellers ingest
  proceeds and retire the item and offer before acknowledging a sale.
- **Applications can no longer trigger the wallet's internal SPV bypass through
  labels.** The exception is scoped to wallet-owned BEEF ingestion.

## [1.2.272] - 2026-08-21

### Changed

- Version opened so Mobile can publish an APK against a clean UI-core pin. No
  wallet behaviour changed; the push-time version guard runs as a Node hook.

## [1.2.271] - 2026-08-21

### Fixed

- **Release builds produce installers again.** The Toolbox patch was still pinned
  to 2.4.4 while the wallet installs 2.10.2, so `npm ci` failed in `postinstall`
  and 1.2.268 through 1.2.270 shipped no downloads. The patch is regenerated for
  2.10.2, and a stale patch now fails `npm test` and the pre-push hook instead of
  a release workflow nobody was watching.
- **Legacy P2PKH sweeps and BRC-29 receipts no longer need a merkle proof of a
  just-seen output.** Those Toolbox edits had silently stopped applying, so
  importing visible funds and internalizing a fresh payment could refuse work
  the wallet is meant to do.

## [1.2.270] - 2026-08-21

### Changed

- **Collect groups items by collection.** A collection is one facepile and a
  quantity, not a flat list of every output. Loose items stay on their own.
- **This wallet can list and buy collectables on HandCash Market.** A listing is
  a seller-signed advert with a BRC-150 origin proof. Buy is gated on that proof.
  The advertised price is what the buyer pays; 5% of it is the market fee and
  the rest is the seller. Settlement is atomic between the two wallets — the
  market never holds keys or funds.
- **Phrase import can resume an item sweep** instead of starting over after a
  stop. PeerPay links open Send as a request, and a phone can open a BRC-100 app
  in the wallet's own browser when Chrome cannot reach loopback.
- **A burn appears in Activity the moment you confirm it**, and ends there as
  burned or as a named failure, instead of only after the spend queue and the
  network had their turn. A burn also reuses the tip the wallet already holds,
  so an item no longer fails to burn because an indexer was slow.
- **You can forget an item instead of burning it.** Forget removes it from this
  wallet without broadcasting anything; the output stays where it is on chain.
  Listing, cancelling, buying, and selling on Market are recorded in Activity.

## [1.2.269] - 2026-08-20

### Changed

- **Collect now scales by paging instead of loading the wallet into the
  renderer.** It opens on the newest 1,000 outputs, loads older pages only when
  requested, bounds its durable startup cache, and avoids cloning very large
  address scans into redundant in-memory ownership sets.
- **Hosted key custody has been removed.** Cloud trustholder enrollment,
  deposit, retrieval, OTP restore, provider endpoints, and their feature flags
  are gone, and stale enrollment/share-plan records are purged locally.
  Recovery remains local through phrase, emergency root key, or any two
  offline BRC-140 slices; BRC-39 continues to back up history only.
- **Burn is now the last action on a token and on an item, never the button next
  to Send.** Both asset pages order their actions the same way — the everyday
  action first, then copy/save, then the destructive one set apart at the end of
  the row. Removing an unrecoverable device backup follows the same rule.
- **Device backup says what it holds in plain sentences.** The screen headings
  are now “This wallet is backed up to N devices” and “This wallet is storing N
  backups”, each row adds the device platform instead of repeating its heading,
  and an empty section is one line rather than a paragraph. “Link” is gone from
  the feature: the QR is this device’s code, adding a device is “Add a device”,
  and opening a stored copy is “Restore”. Add sits below the state it changes.

### Fixed

- **The token page no longer runs its heading text under the token icon.** The
  hero reserved a 96px column while the avatar size buckets forced 112px, so the
  eyebrow, symbol, balance, issuer, and attestation badge stacked into whatever
  space was left. The icon is now pinned to its column and the heading is three
  lines: symbol with the attestation badge beside it, balance, issuer. Decimals,
  outputs, and deploys read as three equal cards instead of loose text.
- **A ticker icon this wallet inscribed itself now shows up.** Resolving icon
  bytes required a live indexer service, so a freshly minted token fell back to
  the hash identicon even though the inscription was sitting in local storage.
  The lookup now goes through the local-first BEEF path, and the icon cache
  accepts the larger bitmaps a real uploaded image produces.

## [1.2.268] - 2026-08-20

### Changed

- **Device backup now reads as two physical locations, not one abstract device
  list.** The screen separately shows where this wallet is backed up and which
  wallet backups are stored on this device, including a plain empty state for
  each side. Unconfigured, same-wallet, missing-copy, and unsafe reciprocal
  devices sit in their own small sections instead of blurring those two facts.
  Direction choices now say exactly where the encrypted copy will be stored,
  and the Settings row summarizes copies “elsewhere” versus “stored here.”

### Fixed

- **A token mint no longer stalls on proofs that cannot exist yet.** Minting
  supply spends the auth tip of a genesis deployed seconds earlier, so that tip
  and whichever change ancestors are still in the mempool have no merkle proof.
  Enrichment asked the indexer for them anyway — one eight-second timeout per
  ancestor, unbounded — and the whole `createAction` outran the bridge deadline
  while the issuing app was told the mint had failed. Proof hydration now has a
  fixed budget, after which the mint signs against the raw BEEF it already
  holds; every spend body is present, so signing is unaffected, and the monitor
  still broadcasts once headers land.
- **An in-flight spend is no longer reported as a failure.** The bridge waited a
  flat two minutes for any method and then answered
  `WALLET_BRIDGE_TIMEOUT` — the same code it uses for a read that never ran,
  even though `createAction` / `signAction` / `internalizeAction` may already
  have signed. Those three now get a five-minute budget and, past it, a distinct
  `WALLET_BRIDGE_PENDING` that tells the caller to reconcile rather than retry.
  A renderer reply that arrives after the HTTP call was answered is logged
  instead of dropped silently.
- **A long spend keeps the scheduling priority it was given.** The spend-priority
  hold expired after ninety seconds so a leaked one could not disable item
  ingest forever, but a mint waiting on an unmined ancestry legitimately runs
  past that — and when the hold lapsed, chain ingest and history backup piled
  back on top of the spend they were meant to yield to. The hold now takes a
  heartbeat from the work itself: expiry catches an abandoned hold, never a busy
  one, and stall reports still quote the real held duration.

- **A funded wallet no longer opens at zero while Mobile reads local state.**
  Cold unlock raced the owned-cash scan against a 2.5-second timeout and wrote
  literal zero into the app machine. The phone then finished the real read
  (`710,091 sats` in the reported session) but only logged it, leaving the hero
  at zero. The last successful display balance is now durably scoped to the
  wallet identity and painted during sync; the completed fresh read always
  replaces it. Confirm/send still reads Toolbox and fails closed, so stale
  display state is never spend authority.

## [1.2.267] - 2026-08-20

### Fixed

- **Identity-key item deliveries no longer disappear behind a ten-minute
  retry.** A large AtomicBEEF can exceed the messagebox body limit, leaving the
  recipient to fetch it by txid. If that first fetch raced the sender's silent
  `postBeef`, the ordinary indexer-failure cache suppressed every five-second
  inbox poll for ten minutes. Durable, un-ACK'd item and token hints now use a
  ten-second backoff while ordinary indexer failures retain their conservative
  backoff. Once accepted, the temporary inventory card is also durable across
  renderer restarts, scoped to the receiving identity, and retained for the
  full settlement window until the real basket row appears.

## [1.2.266] - 2026-08-20

### Added

- **A 3D collectable renders as a 3D object.** An item whose body is a GLB or GLTF was shown as a broken image frame, because the panel only knew how to paint bitmaps. Such an item now mounts an interactive viewer — drag to orbit, scroll to zoom, with a slow auto-rotate and studio lighting — behind the same deferral rule as every other image: a skeleton holds the space until the first frame is actually drawn, a render that fails or hangs says so by name and offers a retry, and the media action becomes Save model instead of Copy / Save image. Detection is by MIME and by body extension, so a JPEG item keeps the bitmap path exactly as before.

### Changed

- **Burning is a screen, not a dialog.** A burn is composed like a payment, so it now lives where payments live: its own side panel with a breadcrumb (Items → token → Burn), not a modal floating over the page it came from. The chart is unchanged — amount is writable only while editing, confirm restates one fixed amount, confirming hands off to the wallet — but the flow can now be backed out of the way every other flow can, and the destination after a token burn is the token page whose Activity the row lands in.
- **The burn panel says what it costs in one glance.** The economics are an aligned breakdown ending in a bold effect-on-Pay row with its fiat estimate, the amount field carries an All button and the held amount beside it, and the confirm face's second line tells you what survives — *Leaves 750 DEMO* for a partial token burn, or that an item's BRC-150 lineage ends with it — instead of repeating the name already above it.
- **The token page leads with the token.** Icon, ticker, balance and issuer are one card with an attestation badge, and Send / Burn / Copy ID sit directly beneath it rather than stranded below a wall of metadata. Rows that only repeated the hero or the metric chips are gone, long ids stay on one line with the full value in the tooltip and the clipboard, and values the deploy never supplied read as quiet rather than as data.

## [1.2.265] - 2026-08-20

### Changed

- **A burn is composed like a payment.** It was one dialog that let you retype the amount beside the button that destroys it, then sat spinning, then left that same button live under an error. The chart is now the send chart — `closed → editing → confirming → handoff | failure` — so the amount is writable only while editing, the confirm face restates one fixed amount with no field to change it, and confirming hands the burn to the wallet and closes: the toast and the Activity row carry the result, as with a send. A refusal returns as its own stage with Close / Edit, and cannot burn again without going back through editing.
- **A token burn no longer opens with your whole balance selected.** The field starts empty with the held amount shown beside it, Review stays blocked until an amount that you actually hold is typed, and the economics preview coalesces keystrokes instead of selecting real outputs per digit. Burns now play the wallet's success and error sounds, and the trigger reads `Burning…` while one is in flight.

### Fixed

- **Statecharts actually show a chart.** The live readout, a wrapping wall of page chips and a caption line took about 160px of header, and the diagram got whatever was left of the settings body — in a short window that was two pixels, so the page looked like text with no chart. The chart now claims a real minimum height (the body scrolls), the live readout folds to one summary line behind an Aeon disclosure, the page list scrolls in a single row that keeps the selected page in view, and the caption floats over the chart instead of taking a row from it.
- **The selected statechart page is legible on the light theme.** White on the sheet's mid green was 3.6:1 and read as a disabled pill. Which chart you are reading is chrome, not wallet state, so it takes the same near-black selection treatment as the wallet nav tabs — 16.7:1 on paper.
- Settings → Statecharts carries the burn UI chart, so the Mermaid matches the machine that ships.

## [1.2.264] - 2026-08-19

### Fixed

- **Green reads as green in Settings on the light theme.** `--hc-success` was never actually defined, so every "saved / confirmed / one-way" status fell back to the dark sheet's neon mint — 1.27:1 on white, effectively invisible. It is now a token: the neon on black, and the brand hue at L26% on paper (5.6:1). Two rules that lifted their green *toward white* now mix toward the sheet's own ink instead, which is the right direction on both sheets.
- **Settings greens are deep on the light sheet.** The palette accent (L33%, 3.5:1) is fine on a dashboard tile but pale under the dense small type in Settings, so the accent is re-pointed for that subtree only — every label, status, inline link and tag deepens at once and matches the success ink beside it.

## [1.2.263] - 2026-08-19

### Changed

- **Large collections migrate far faster.** Collectables from an imported phrase now share a transaction — up to 25 tips per broadcast instead of one each — and the source transactions for a page are fetched in parallel rather than one after another. Bundling is an explicit decision: a rejected bundle is halved by name (`bundleRejected`) and retried down to single tips, so one unspendable tip cannot stall a run and no item ever travels a protocol path other than the one it was planned for.
- **The wallet no longer re-reads the chain after every few items.** Chain ingest walks the whole wallet, so running it per batch made each later batch slower — exactly the crawl a hundred-thousand-item import hits. Migrated tips are already in the local `1sat` basket, so the chain check now runs once when a run ends, including when it is paused or stops for funds. Progress shows a live items-per-minute rate.
- **Device backup is one screen at a time.** The panel is a projection of `deviceBackupMachine`: a device list, then one device, where you choose a single recovery direction — protect this wallet there, or protect that wallet here. QR codes stay hidden until asked for, each device reads as one line naming its direction, and Recover and Remove live on the device instead of in a row of buttons.
- **Settings says less.** Ledes on History backup, Import phrase and trustholder deposits are one line each, with protocol detail left in the About footer where it belongs. Row statuses are short and honest: `Not backed up`, `2 devices · one-way`, `Both directions — unsafe`.

## [1.2.262] - 2026-08-19

### Added

- **A token now has a real detail page.** Ticker, balance, raw units, decimals, held output count, representative outpoint, every deploy id behind a merged balance, icon inscription, issuer, and cosigner terms are all shown, alongside the transactions for that token only. Issuer attestation is labelled as what it actually is — a Sigma (BRC-77) address match on deploy — rather than presented as proof of supply, which no wallet can verify.
- **Tokens and collectables can be burned, ending them on chain.** A burn is planned once as an explicit path and refuses by name for cosigned, mixed, covenant-locked, unknown, or foreign locks; it never falls through to a send, a sweep, or a local abandon. A BSV-21 burn writes the canonical `op: "burn"` record and returns token change when the amount is partial. An item burn spends its 1-sat tips into a single multi-sat output, which is what actually terminates each origin, and that output is internalized as ordinary managed change so the recovered satoshis become spendable Pay balance.
- **The burn prompt shows the economics before anything is destroyed.** Asset satoshis selected, satoshis consumed by protocol outputs, cash recovered, the estimated network fee, and the net effect on Pay are all named — small burns normally cost more in fees than they return, and the prompt says so instead of implying a profit. Completed and failed burns keep their own Activity rows with the destroyed amount, recovered satoshis, fee, and txid.
- **An app can ask this wallet to prove which identity it controls.** The proof uses only existing BRC-100 methods (`waitForAuthentication`, `getPublicKey`, `createSignature`) over a short-lived challenge bound to the requesting origin, and the wallet refuses a challenge that is cross-origin, expired, pre-hashed, weakly random, or not canonically serialized. The approval prompt states the app's purpose and that signing cannot spend. Apps discover the recipe from `/manifest.json`; the format and verification rules are documented in `docs/wallet-to-app-identity-proof.md`. This is not Sigma — Sigma remains the token issuer attestation.

## [1.2.261] - 2026-08-19

### Added

- **Collectables are now migrated per derivation branch, chosen deliberately.** A phrase can hold hundreds of thousands of tips on one branch and a handful on another. Each branch is listed with its count and its own checkbox; a branch too large to count exactly starts switched off, because destination change pays a fee per collectable and such a run can take hours and outlast the balance. Small branches stay on so a phrase can be verified cheaply first.

### Fixed

- **Running out of BSV part-way through a large migration now stops the run instead of failing every remaining tip.** A shortfall is a property of the wallet, not of the collectable being moved, so it ends the run under its own name, reports how many were moved, and leaves the resume cursor on the tip it did not reach — adding funds and running again continues from there.

## [1.2.260] - 2026-08-19

### Fixed

- **Collectables can now actually be migrated from an imported phrase.** Every tip failed CHECKSIG with "the top stack element must be truthy" because the sighash was built over a bare P2PKH, while a real tip's locking script is P2PKH followed by an inscription envelope or an `OP_RETURN` Sigma signature. The whole locking script is now used as the sighash scriptCode, the same way BSV-21 auth tips are already signed. Plain-P2PKH funding was unaffected, which is why cash swept while items never did.
- **A failed migrate no longer leaves a collectable in Collect that later vanishes.** The unsigned action kept its reserved inputs and still listed its `1sat` output — with the provenance attached, so it appeared as a verified item — until background review failed the transaction and removed it. Nothing had ever been broadcast, so the action is now aborted at the point of failure.
- **Tips carrying a Sigma signature or inscription envelope are no longer mistaken for foreign locks.** Eligibility requires the key's P2PKH to be present in the locking script rather than to be the entire script, so only genuinely unspendable tips (listed or covenant) are refused.

## [1.2.259] - 2026-08-19

### Fixed

- **Coins swept from an imported phrase now appear on Activity.** The sweep credited the balance but wrote no row, and no later pass could ever write one — Refresh only ingests this wallet's own addresses, never an imported phrase — so a completed sweep was indistinguishable from one that silently did nothing. Both paths now share one receipt recorder, and a sweep that landed before this fix is backfilled from its durable sweep mark (de-duped on the receive txid, so no coins are re-spent).
- **A phrase's cash outputs are no longer signed as if they were collectables.** The ordinal index lists every unspent output an address holds, so a Yours branch returned its 1.6M-sat cash output alongside its inscriptions; migrating it as a 1-sat tip signed the wrong sighash amount and failed script evaluation on every retry. Eligibility is now decided per output from the source transaction — value and lock must both match — and tips this phrase key cannot unlock (listed or covenant) are refused by name instead of retried forever.
- **Item counts and progress reflect collectables rather than raw index rows.** The preview counted cash outputs as items, and the migration's stop-early guard treated pages of skipped outputs as failed batches. Skips are now reported separately and only repeated failures with nothing moved end a run.
- **Migrated collectables get an Activity row of their own.**

## [1.2.257] - 2026-08-19

### Added

- **Settings → Import phrase brings an outside 12- or 24-word wallet into this one.** Both BRC-75 and legacy-HD roots are derived and previewed, so the phrase's real address is found before anything is spent. Funding is swept with the foreign key while this wallet keeps the change and pays the fee, and 1-sat items migrate in small resumable batches — a cursor is stored so a very large collection can continue across sessions instead of restarting.
- **Linked devices only count as linked once both sides hold a sealed spare.** Pairing reports each leg of the exchange separately (the spare this device made for the peer, and the peer's spare stored here) and the wizard stays open until both exist, so a link can no longer look complete while recovery would only work in one direction.

## [1.2.256] - 2026-08-18

### Fixed

- **BSV-21 peer sends now settle as tokens end to end.** The first token release reused the item messagebox card without identifying the asset, so the recipient routed the Atomic BEEF through collectable ingest and filed the output in `1sat`. The wire remittance now carries a tagged fungible payload, the payee validates the exact BSV-21 output from Atomic BEEF, broadcasts on the shared `peerDeliver` path, and internalizes it directly into `bsv21` with matching tags and custom instructions.
- **Token sends now obey the complete item send grammar instead of only its happy path.** Every selected input lock is recovered from BEEF and classified before the parent chart starts; missing, foreign, mixed, and cosigned locks fail closed by name. A signable `createAction` result follows the same explicit `signAction` edge as collectables, every settle must reach `done`, and sender broadcast remains impossible until peer delivery succeeds or takes the named fallback.
- **Spent token inputs and outbound remittance tips no longer return to the sender's balance.** The finish path records who may settle, keeps the original spent tip on Activity retries, hides pending spent rows, relinquishes the recipient output when it is not a self-send, and blocks retry or clear while the recipient can still broadcast.

## [1.2.255] - 2026-08-18

### Added

- **You can send a BSV-21 token from the wallet, the same way you send a collectable.** Tokens were listed under Collect but had no way out: a transfer could only happen through an app on the BRC-100 bridge. Token details and each card in the Collect carousel now open a Send screen with the same recipient grammar as an item send — friend, `$handle`, address, identity key, or a peer-pay URI — plus an amount field that respects the token's decimals and a Max button. The send picks tips largest-first, inscribes the transfer (and any change) as a BSV-21 output rather than a bare P2PKH, and hands the signed transfer to the same settle path items use: an identified peer receives it through their messagebox, a send to yourself settles locally, and a pasted address is broadcast by the sender. Cosigned tips (MNEE-shaped) and unrecognized locks refuse by name instead of quietly falling through to a plain spend, and a balance that mixes plain and cosigned tips says so rather than half-sending.

### Changed

- **An app that moves your tokens now asks to "Send token", not "Send item".** BSV-21 tips live in their own basket, but every permission prompt classified them as collectables, so a fungible transfer, receive, or release was described with item wording. Token spends, signs, receives, and releases are recognized on their own and read as tokens. Like item transfers, none of them are ever covered by Pay or Auto-pay.
- **A token send that dies is offered the same recovery as an item send.** A `send-token` row in Activity is now a spend attempt: the wallet re-checks whether enough of that token is still spendable before offering anything, rebroadcasts the transfer it already signed when one exists, recreates the send only when nothing was signed, and keeps the row untouched while the recipient can still broadcast it. It also inherits the longer grace period item sends get, so a peer-settled transfer is not called failed while it is still in the recipient's inbox.

## [1.2.254] - 2026-08-18

### Fixed
- **A collectable sent to your own handle now stays in Collect instead of vanishing.** A self-send settles on its own `selfReceive` path, not through item ingest, and that path only removed the tip it spent — the replacement tip is a different outpoint the basket has not listed yet, and the live address scan is invalidated by the send itself. Because the grid is rebuilt purely from the basket read, Collect came back one card short until a much later scan. The wallet now carries a tip it minted to itself through each rebuild until the basket returns it, and paints the card and its Verifying… spinner before the list read rather than a second behind it.

## [1.2.253] - 2026-08-18

### Fixed
- **A collectable sent to your own handle now paints and spins like any other receive.** 1.2.252 seeded the card and started the Verifying… spinner on the fresh-internalize path, but a send to yourself takes a different branch: `createAction` files the tip before the messagebox copy arrives, so that receive lands as "already internalized" and skipped straight to settling the Activity row — no seeded card, no spinner. Both ingest branches now share one paint step, so a self-send shows the card, the Activity row, and the spinner together, exactly like a receive from someone else.

## [1.2.252] - 2026-08-18

### Fixed
- **A received collectable lands in Collect at the same moment it lands in Activity.** 1.2.250 opened the Activity row at ingest, but ingest announced the arrival before the card existed: `internalizeAction` files the basket row while the list read and the address scan behind it take seconds, so Collect stayed empty — and with no card there was nothing to carry the Verifying… spinner. The tip is now seeded into the collectables cache as soon as it is internalized, which paints the card immediately and routes the arrival through the one place allowed to announce it, so the card, the spinner, and the Activity row all appear together. The following list replaces the seeded row, and a tip that is not ours is dropped by the ownership pass rather than guessed at. A send to your own handle no longer shows the collectable twice while the outgoing tip waits to be reviewed.

## [1.2.251] - 2026-08-18

### Fixed
- **An app's spend shows "Approving" in Activity instead of a bare dash.** The row for an app spend request is created the moment you approve, before any transaction exists, so it carries no amount — and the amount column tested for a missing USD rate before it tested for that, printing `—` (or `−…`). An unpriced pending spend now reads "Approving" and sets as a word rather than a number. Real sends are unaffected: they file a pending row with actual satoshis, which retires the placeholder.

## [1.2.250] - 2026-08-18

### Fixed
- **A balance that could not be read no longer reports itself as zero.** Every spendable-read strategy can time out at once when IndexedDB is saturated, and `fetchBalanceSats` returned `0` for that case — indistinguishable from an empty wallet. A funded wallet then looked broke, and the send gate refused the payment for insufficient funds. The read is now tagged (`ok` / `unavailable`): the hero number falls back to the last figure actually read rather than inventing a zero, and spend gates take the tagged read and refuse with "wallet storage is busy — nothing was sent" instead of a wrong arithmetic error.
- **A received collectable appears in Activity while it is being verified.** Tips discovered through the collectables cache — a peer-pay receive to your own handle, for one — only opened an Activity row once BRC-150 settled, because the row was created by the verify callback. The row is now opened the moment the card lands and shows "Verifying…", then settles in place when lineage proves; an already-proven arrival still lands settled in one step.
- **A collectable send shows a spinner in Activity, like a receive does.** Pending sends drew no progress mark at all, so the row looked inert until it settled. The sending mark reuses the receive spinner styling but stays distinct from the verify mark, so an outgoing item is never mislabelled as verified.

## [1.2.249] - 2026-08-18

### Fixed
- **Complete the BRC-165 held-row contract.** HandCash now stamps BRC-164 `id:` keys when collectables enter custody, resolves every `p 1sat input id <key>` label to exactly one held row and action input, removes the obsolete standing send grant, and advertises BRC-164/165 scopes through bridge capabilities.

## [1.2.248] - 2026-08-18

### Changed
- **P1Sat permissions now match the BRC-165 reference-wallet wire.** Collectables remain in storage basket `1sat`, while apps request `p 1sat all|collection|app|creator|id` and carry scope values in ordinary tags. Invalid or bare scopes fail closed, `app:` and `creator:` are distinct, BRC-164 id lookups stay narrowly filtered, and `p 1sat input id <key>` spends always require per-action approval outside Pay/Auto-pay.

## [1.2.247] - 2026-08-18

### Fixed
- **Friend and handle sends now get the confirming-funds message too.** 1.2.246 translated the raw insufficient-funds refusal on the plain-address path only, so a send to a friend, `$handle`, or identity key — which routes through BRC-29 peer pay — still showed the toolbox's `N more satoshis are needed` arithmetic. The wording now lives in one `insufficientFunds` module shared by both coin paths, so every payment reports the same spendable-vs-confirming split. The shared helper also refuses to say "still confirming" unless the confirming balance actually closes the gap, so it can never tell a genuinely short wallet to wait forever.
- **The friend suggestion dropdown is readable in light mode.** `.friend-suggest-list` (Send and Send collectable) hardcoded a near-black sheet that never flipped with the theme, so on the light sheet it rendered as a dark box with dark inherited text. It now uses the same light-mode surface tokens as the chat command menu; the dark theme is unchanged.

## [1.2.246] - 2026-08-18

### Fixed
- **Sends now say "still confirming" instead of a raw insufficient-funds line.** The displayed balance credits unconfirmed change of your own live sends, and the send gate credited it too — but `createAction` can only spend confirmed `spendable: true` coins. After rapid back-to-back sends, almost the whole balance can be unconfirmed change while the wallet is still syncing, so the gate green-lit the send and the toolbox then threw `N more satoshis are needed`. A coin send that fails on insufficient funds now reports the honest split ("X BSV spendable now, Y BSV waiting for confirmation — try again once it clears") when confirmed is short but confirming covers it, and a plain "not enough spendable BSV" otherwise. Coin selection is untouched; this only rewrites the failure message.

## [1.2.245] - 2026-08-18

### Fixed
- **Failed bridge calls now record why they failed.** The bridge logged only `status=400`, so an uploaded support log could show that a `signAction` or `internalizeAction` was rejected without naming the reason — the wallet's `code` / `description` never left the renderer. Non-2xx replies now log a bounded one-line summary (whitespace collapsed, truncated at 300 characters) so a BEEF-sized payload cannot flood the log while the actual refusal stays diagnosable.

### Changed
- **Withdrawn BRC-156 / soft-latch vocabulary is gone from app-facing discovery.** `/health` and `/manifest.json` advertised `1sat-latch`, `latchedSend`, and provenance `v3` for a standard that was cancelled. App capabilities now come from a single `oneSatAppCapabilities` constant that exposes only BRC-147, BRC-150, basket `1sat`, and BRC-150 `v2` provenance, with a test asserting no latch vocabulary can reappear on the wire. Token docs were updated to match: item identity and authenticity are the BRC-150 offline tip→origin proof, with no on-chain latch companion.

### Fixed
- **App permission rows fit Recent activity again.** The stored note prefixed “Approved” onto an action title that already led with a verb, while the row’s right column said “Allowed” — three ways of saying the same thing. The note now names only what was requested (“Approve payment”), and the verdict column keeps Allowed / Denied. Long app origins truncate with an ellipsis instead of pushing the row wide; the full host stays available on hover.
- **Apps hosted on a shared domain are named correctly.** `brc-cloud.bcryderman.workers.dev` displayed as “Workers” in connect prompts, activity, and app details because the name came from the second-to-last host label. Hosts such as `workers.dev`, `pages.dev`, `github.io`, `vercel.app`, and `netlify.app` are now named by the app’s own subdomain (“BRC Cloud”).

## [1.2.243] - 2026-08-18

### Changed

- **macOS update checks no longer depend on mutable ZIP channel metadata.** BETA builds already install through an architecture-matched DMG, so Mac now discovers that versioned asset directly from GitHub and bypasses electron-updater's stale ZIP cache—the source of false SHA-512 mismatch failures.
- **Mac release metadata is published last.** CI waits for every referenced DMG, ZIP, and blockmap upload to complete before exposing `latest-mac.yml`.

## [1.2.242] - 2026-08-17

### Changed
- **Key-slice backup uses the device Share sheet.** Each BRC-140 slice opens the OS share surface so the user can put it in Drive, email, a password manager, or another app they control — HandCash is not a destination and does not receive the slice. Desktop falls back to email when Web Share is unavailable; Mobile uses a native Android chooser.
- **Backup completion requires an explicit “I saved this slice” confirmation.** Sharing, copying, or downloading alone never marks a slice done. The final keys-backup confirm stays locked until two distinct slices are manually confirmed. Hosted trustholders stay behind the existing feature flag and remain hidden.

## [1.2.241] - 2026-08-17

### Added
- **Background change consolidation keeps signing fast on a fragmented wallet.** Many small BRC-29 receives leave the wallet with a large pool of little change outputs, and `createAction` coin selection walks that pool on every send. A rate-limited background pass now collapses the whole spendable change pool into a single managed-change UTXO with one self-payment, using the toolbox `maxPossibleSatoshis` "largest fundable amount" output — the same primitive the toolbox's own `sweepTo` uses, aimed at our own identity. The decision is an explicit tagged union (`changeConsolidationPath.ts`): it only fires when the pool is genuinely fragmented (≥ 30 spendable change outputs) and comfortably above the fee, and it holds otherwise. It runs in the exclusive spend region so it can never race a user send, yields when a spend is already waiting or a recompose owns the session, and only ever selects change — assets (`1sat`, `bsv21`) live in their own baskets and are never touched. Fully fail-closed and silent (no Activity row for money that never left the wallet).

## [1.2.240] - 2026-08-17

### Fixed
- **Send no longer scans the unspendable graveyard when confirmed coins already cover the payment.** The pre-`createAction` gate used to credit unconfirmed change on every Send — on a phone carrying hundreds of unspendable rows that was most of the wait before signing, even when toolbox `balance()` already had enough. Confirmed spendable is checked first; the graveyard scan only runs for the shortfall, stops once that shortfall is covered, and runs in one IndexedDB session instead of one per page.
- **BRC-29 key derivation overlaps the send prep.** The payment's two nonces and payee `getPublicKey` read only the root key and counterparty, so they now run concurrently with the nosend release and balance check rather than strictly after them. A new `keys ready` timing mark makes the derivation cost visible on the next log.
- **Legacy sweep is now an explicit tagged path.** `chooseLegacySweepPath` (`legacySweepPath.ts`) is the only decision that may admit an address UTXO into `importLegacyUtxos` — same pattern as `TipKind` / `SendPath` / `ItemSettlePath`. Classification puts sub-fee companion dust in `heldUneconomical` (never `funding`); payment-by-txid uses the same chooser; the sweep fail-closes again if anything else is passed in. A bare `satoshis > 1` test is forbidden so a future change cannot accidentally sweep assets or latch-style companions.
- **Back-to-back sends no longer reselect a just-spent coin.** The pass that marked consumed inputs unspendable (`rehideInputsOfLiveLocalTxs`) is chain-ingest maintenance and returns early while a spend is queued — exactly the state a burst of sends holds. A spend now seals its own inputs immediately after `createAction`, on both the BRC-29 and plain BSV paths, so the next send cannot pick them.

## [1.2.239] - 2026-08-17

### Fixed
- **Tiny companion outputs no longer retry their sweep forever.** Some apps park a small second output next to a 1-sat ordinal they send you. Sweeping one output builds a ~193-byte transaction and ARC charges 100 satoshis per 1000 bytes, so anything under 21 sats cannot pay its own fee — there is no transaction that moves it alone. Because a broadcast rejection is deliberately read as transient (an outage must never blacklist a live deposit), each of these was rebuilt, re-signed and re-rejected on every scan. Seven of them was enough to hold legacy ingest past its deadline every pass, which is what made sends queue behind it. The sweep now names an economic floor and holds anything below it, exactly like unrecognized 1-sat dust. Nothing is lost — the outputs stay on the address.

## [1.2.238] - 2026-08-17

### Fixed
- **Signing is much faster on phones.** Two hot loops opened a fresh IndexedDB storage session *per row* instead of one for the batch, and entering the provider — not the queries — was the cost. The phone log showed 6.5s between tapping Send and `createAction`, on a wallet carrying ~190 unspendable rows.
  - The unconfirmed-change credit behind every balance read took two sessions per output row to check transaction liveness; it now resolves a whole page of transaction ids in one session, and asks once per distinct id.
  - The stale-output restore sweep took a session per output; the whole sweep now runs in one, keeping its yield-to-spend check.
- Send now logs `nosends released` alongside `ready`, so the pre-`createAction` cost is attributable instead of a single opaque number.

## [1.2.237] - 2026-08-17

### Fixed
- **The balance snapshot uploads again after a send.** A send raises spend priority *before* it can acquire the wallet region, so while chain ingest was slow enough that sends queued for tens of seconds, every backup wake-up found another spend waiting and deferred — forever. The post-spend push now gets a bounded courtesy budget (four windows) and then takes its turn; the coordinator's region exclusion, not the deferral hint, keeps the export and the spend apart. Logs name the holder and warn when the budget is spent.
- **WhatsOnChain throttling no longer stalls chain ingest.** Its free tier is ~3 req/s and its 429 carries no CORS header, so in the renderer the throttle arrived as an opaque `TypeError: Failed to fetch` — indistinguishable from an outage. Every per-transaction probe read "unknown", so sweeps re-ran each pass, legacy ingest hit its 35s soft deadline every cycle, and sends sat behind it. WhatsOnChain calls now share a paced request budget and stop outright for 20s after a throttle, leaving Bitails to answer. "We never asked" stays distinct from "absent" — probes still fail closed.

### Changed
- The concurrent tip-ingest test gets a realistic timeout instead of flaking near the 5s default under full-suite load.

## [1.2.236] - 2026-08-17

### Changed
- **Ingest and broadcast paths run cooler.** Chain maintenance steps overlap; tip ingest / outbox flush / stuck-sweep checks use a shared bounded pool; address scans hedge providers instead of hammering them all at once; payment chase prefers tip re-ingest over repeated full refreshes; BRC-29 payee ingest overlaps on-chain confirm with `internalizeAction` and skips a redundant `postBeef` when the tip is already mined.
- **Handle display:** short form stays `$handle`; fully-qualified / email form is BRC-169 `@handle@domain` (no `$`). Input still accepts `$`, `@`, and `@$`.
- **BRC-169 for apps like Free Radio:** any authenticated BRC-100 app can read `getClaimedCloudHandle`; claim stores the registry certificate for `listCertificates`; reverse lookup by identity key on BRC-CLOUD resolve/search.
- **Live send harness** supports Alice↔Bob pingpong (`HANDCASH_LIVE_PINGPONG`) with bottleneck summaries; BRC-29 ingest logs existence-probe / internalize / balance phase timings.

### Fixed
- Stale raw-tx provider list and activity-item view identity tests; legacy-scan fixtures; chain-ingest mocks.

## [1.2.235] - 2026-08-17

### Fixed
- **Pay no longer jumps up after Refresh by resurrecting spent coins.** Restore used to trust indexer `isUtxo`, which still says yes while a spend is catching up — that flipped consumed inputs back to spendable, inflated the hero number, and hung the next send on already-spent coins. Refresh now re-hides inputs of this wallet's live local txs and only restores that tx's change. Checking the Send balance no longer pages the whole spent set.

## [1.2.234] - 2026-08-17

### Changed
- **UTXO hide/reserve overlay uses BRC-38 `spendable` / `spentBy`** instead of Cloud `available` / `selected` / `spent` / `quarantine`. In-flight sends still reserve with `lockOwnerId` (wallet-local). Refresh will not re-offer a coin with `spentBy` set.

## [1.2.233] - 2026-08-17

### Fixed
- **Clearing an "already spent" send keeps its change.** Dropping a signed Activity row whose inputs moved on chain now credits that tx's change instead of leaving it unspendable after an indexer 404.
- **Already-spent broadcasts hide those inputs without deleting them**, and no longer bulk-restore indexer-lagged coins as spendable (the path that recycled dead UTXOs into the next send). Overlay statuses match Cloud: `available` / `selected` / `spent` / `quarantine`.
- **The Pay balance no longer drops by payment plus change while Sending.** Displayed owned cash is spendable outputs plus unconfirmed change of a live local tx.

### Changed
- Failed Activity rows use a short label (`Already spent`, `Timed out`, `No network`) instead of the broadcaster dump.


## [1.2.232] - 2026-08-17

### Fixed
- **Clearing a send from Activity no longer cancels a live transaction.** A signed send stays until every one of its inputs is spent on chain. Dropping the row earlier, then repairing local spend state, is how a later Refresh could lose those coins. Unsigned failed sends (never signed) can still be cleared. Signed rows whose coins already moved can be dropped as history only — that does not undo the spend.
- **Follow-up sends after an already-spent broadcast no longer restore dead inputs** as spendable, and they keep this wallet's unconfirmed change. Outputs whose `spentBy` transaction is still live locally are left alone.
- **Send no longer waits ~15s repairing failed spends before createAction.** Stuck noSends/batches abort on the hot path; the full failed-spend repair and change-script sweep run on crash recovery instead. Refresh yields to a waiting spend instead of holding the lock through ghost-heal / prune / restore.

### Changed
- Bulk "Clear failed" keeps signed sends whose inputs are still unspent (or unknown) and reports what it kept. Confirmation copy matches: this does not cancel a live transaction.

## [1.2.231] - 2026-08-17

### Fixed
- **Desktop installer CI compiles again.** 1.2.230 failed `tsc` on the live send harness and a `globalThis` flag in tests; same wallet as 1.2.230.

## [1.2.230] - 2026-08-17

### Fixed
- **Incoming BSV is credited when it is visible on-chain**, without waiting for Arcade SEEN, merkle proofs, or walking deposit ancestry. Plain P2PKH cash is not an NFT: Refresh loads the deposit, sweeps into BRC change, and only counts it after ARC accepts the sweep (so a local-only sweep cannot look already spent).
- **BRC-29 receive no longer rejects unconfirmed payments** (`internalizeAction beef is invalid`). Same visible-on-chain gate as cash.

### Changed
- **The sending column occupies the side** while a payment is in flight, instead of stacking the spinner above Recent activity. Activity still shows the Sending… row.
- **Cloud key backup (BRC-232 trustholders) is off** unless `VITE_TRUSTHOLDERS_ENABLED=true`. Phrase, BRC-140 slices, and history backup stay.

## [1.2.229] - 2026-08-16

### Changed
- **BRC wallet broadcast is ARC again**, not Arcade. Sends go Taal ARC → GorillaPool ARC → Bitails → WhatsOnChain. Arcade SSE / callback-token wiring is out of the boot path.

## [1.2.228] - 2026-08-14

### Changed
- **Arcade is the BRC wallet broadcaster**, with status wired into the existing dual-layer confirmation path. Mainnet submits to Arcade only (legacy Taal/GP ARC stays on HandCash Cloud for free consolidations). A shared callback token filters Arcade SSE `/events`; those statuses feed `applyDualLayerArc` / SPV finalize, and balance refresh catch-up pulls missed events. No wallet webhook URL — Desktop/Mobile listen over SSE.
- **Minting a collectable asks “Mint item”**, not “Send item”. Issuance has no item tip input; the permission copy names it as mint so Auto-pay / Pay wording is not trained on the wrong verb.
- **Send amount and recipient chrome no longer jump while typing.** Reserved slots hold the USD note and resolved-handle line so the caret and buttons stay put.
- Theme prefs / HandCash mark polish and Settings surface for appearance.

## [1.2.227] - 2026-08-13

### Fixed
- **Pixel Foxes (and other batch-mint) sends no longer omit BRC-150 remittance for being over budget.** The fat part is the shared origin mint — hundreds of sibling inscriptions in one transaction — not the tip→origin path. Remittance slims those bodies to txid-only (BRC-96), keeps the tip raw, and the receiver hydrates the shared origin once (cached for the whole collection). Extending a prior remittance clears a stale AtomicBEEF subject so the next hop still verifies.

## [1.2.226] - 2026-08-13

### Fixed
- **A self-send of an already-proven item arrived unproven and took a minute to verify.** Proving a tip recorded the verdict and threw the lineage away, so the send found no tip-local path, logged `omit provenance — no tip-local path`, and left the receiver to repeat the entire discovery walk. A walk now keeps what it cost: the tip→origin path is stored on the durable verdict, and the assembled BEEF is kept as reusable remittance whenever it fits the wire budget (over it, the verdict still stands — those bytes could never travel). A send over a known path replays it against a warmed BEEF cache instead of rediscovering hop by hop, and the receiver verifies one attached package. Verifying an incoming remittance also records the path it proved, so the next hop passes it on. Verdicts written before any of this get one paced walk (`GENESIS_PATH_BACKFILL_MS`) to recover their path, so existing inventory heals rather than sending bare forever.

## [1.2.225] - 2026-08-13

### Fixed
- **33s freeze while proving an item's lineage** (one `longtask`, a whole heartbeat gap, app killed). The hop loop yielded, but the tail serialized the assembled BEEF, base64'd it, then decoded and re-parsed it purely to call a wire-format verifier — on a batch-mint origin carrying hundreds of inscriptions that is megabytes each way. Verification now runs against the in-memory `Beef` (`verifyLineageInBeef`); serializing is opt-in (`includeBeef`) for the send path that actually puts the lineage on the wire; the tail honours `shouldStop`. Receive-side verify parses a remittance BEEF once instead of up to four times.

### Changed
- **Confirming a send returns you to Activity or the collectables grid** instead of holding you on a status screen. The sidebar mirrors live progress and Activity carries the result, so the in-panel "Preparing payment" and "Sent" screens were hiding the surfaces that outlive them. Success and failure now surface as a toast plus the Activity row. `sendMachine` drops `broadcasting`/`success` for a terminal `handoff`.
- **Clearing a failed send is no longer offered while the recipient can still broadcast it.** A `peerDeliver` transfer is the payee's to settle, and that row is the sender's only record of an item that has already left; retry would race a live transaction. Both are refused for the same window `ghostHealFate` waits on, with a "Free up reserved funds" action instead — repair only fails *unsigned* transactions, so a stuck balance still clears. Bulk "Clear failed" skips protected rows and reports what it kept.

## [1.2.224] - 2026-08-13

### Fixed
- **Items stuck on “unverified” even with a healthy lineage.** GorillaPool 404s the BEEF for ordinal transfer txs and the toolbox `getBeefForTxid` hung past its 8s budget, so every BRC-150 hop failed (`indexer BEEF … timed out after 8000ms`). WhatsOnChain `/beef` returns the subject tx *with* its merkle bump in ~400ms — now used as a proof-carrying fallback on the proof path, not just raw ingest.
- **Purged BRC-156 tips showed no name, app, or traits.** Their identity lived in the removed `BRC156` OP_RETURN and their tip 404s on the indexer, while the origin has been indexed for months. Identity resolve now treats the item's own origin claim as a known origin, recovering name and traits in one request.

## [1.2.223] - 2026-08-13

### Fixed
- **Foxes stuck on Verifying forever.** Chain-provider outages looked identical to unprovable items (walker returned bare `null`), burned the 8-walk session budget, and left Collect spinning. Lineage walks now return named outcomes (`unavailable` / `invalid` / `aborted`); only conclusive misses cool down for 24h; the budget is a rolling 8 per 10 minutes; details show “Cannot be verified” with the reason when the chain says so.
- **Spend priority could leak and starve item verify + cloud backup.** Permission prompts and exclusive spends now hold named, expiring leases instead of a counter that could stick >0.
- **Failed sends (items and BSV) can be retried or cleared from Activity**, including a bulk “Clear N failed” on the full Activity panel. Retry is gated on spendability; unspendable attempts offer clear only.
- **Live “Sending…” row disagreed between Recent Activity and full Activity** — matching is now by outpoint (or coin send) via `liveOutboundRow`, not “any pending spend”.
- Peer-delivered item sends keep a settle-path grace so tips are not healed back into inventory while the payee has not broadcast yet.

## [1.2.222] - 2026-08-13

### Changed
- **BRC-156 soft-latch removed.** Item tips are plain P2PKH; authenticity is BRC-150 tip→origin remittance only. Latch dust, `BRC156` OP_RETURN, and soft-latch send/ingest paths are gone.
- **`collection:` tags on import/send** so `p 1sat collection:<id>` permission scopes match (foxplorer / Pixel Foxes).
- Instant-ingest unknown 1-sat tips from transfer shape (spend a 1-sat input or mint envelope), then verify provenance after paint.
- Settled item Activity rows are no longer pruned when the txid still 404s on-chain (`peerDeliver` is payee-broadcast).

## [1.2.221] - 2026-08-12

### Fixed
- **Every send failed with “A previous failed send is blocking this payment.”** It was never a double-spend, and the wallet state was never corrupt. `StorageIdb.allocateChangeInput` scans change candidates with `noScript: true`, which clears `lockingScript` on every row, then re-hydrates the chosen output only through `validateOutputScript` — and that returns *unchanged* unless `scriptOffset`/`scriptLength` are set. Our change rows store the script inline, so the winning coin reached `createAction` with no script and threw `undefined is not iterable` (`asString(undefined)` → `Array.from(undefined)`). Patched the toolbox to re-read the chosen change output with its script. This is why a fresh BSVA wallet worked and ours could not send at all.
- Iterator crashes now say a coin was missing its locking script instead of blaming a previous send — that wrong message hid this root cause across 1.2.217–1.2.220.

## [1.2.220] - 2026-08-12

### Fixed
- **Metanet / Pixel War / foxplorer connect dead after closing the wallet window.** The BRC-100 bridge closed over the first BrowserWindow; on macOS the app stays alive with a destroyed window, so every `/waitForAuthentication` answered `WALLET_BRIDGE_UNAVAILABLE: window is not available`. The bridge now resolves the live window per request, waits until the renderer registers its listener, and revives the window when a connect arrives.
- **Failed sends vanished from Activity.** Sending… rows were deleted on error. They now stay as failed rows with the reason (also when the 90s stuck watchdog fires).

### Changed
- Patch release (every push must ship a new version).

## [1.2.219] - 2026-08-12

### Fixed
- **“undefined is not iterable” still blocked sends after repair.** 1.2.217 only scanned the first 200 spendable rows, so a change UTXO with no lockingScript further in survived and `allocateChangeInput` handed it back to `createAction`. Every change row now gets an explicit fate: rebuild the script from the raw tx (local storage, then chain on iterator-crash recovery), or fail closed as unspendable.
- Restored change UTXOs are re-enabled after a successful rebuild, so healed coins return to the balance instead of staying written off.
- Stale-output restore no longer logs hundreds of `validateOutputScript` warnings per pass — script-less rows are left to the rebuild path.

## [1.2.218] - 2026-08-12

### Fixed
- **Eternal Verifying… / ghost Sent for 404 txs.** Tip-hint polls re-pinned Activity for inbox tips whose tx never landed (e.g. abandoned soft-latch attempts). Ghost txids are remembered, pruned from Activity, and ACKed so they stop resurfacing. Heal of ghost sent-hides also strips the matching Sent rows.
- Pending BSV Verifying… rows are pruned on confirmed 404; pending collectables stay until BEEF/ingest (peerDeliver may be off-chain).

## [1.2.217] - 2026-08-12

### Fixed
- **BRC-29 / pay stuck on “undefined is not iterable”.** Recovery now fails abandoned unsigned txs, runs toolbox `reviewStatus` to free inputs, quarantines change UTXOs with no lockingScript (offloaded-script allocate poison), and retries `createAction` once after repair — still never `listFailedActions(unfail)`.

## [1.2.216] - 2026-08-12

### Fixed
- **Payments stuck on Sending… forever.** Chain ingest yields to a waiting spend before dual-layer reconcile / UTXO restore; restore loop yields mid-pass. Stuck payment watchdog also expires durable Activity Sending… rows.
- **Activity NFT thumbs skeleton forever.** DeferredImage times out hanging content hosts and shows the collectable fallback icon.
- **Ghost Activity txs that 404 on-chain.** Refresh prunes settled rows whose txid is confirmed missing.
- **Mobile keyboard shrinks Activity.** Capacitor Keyboard resize set to `none` (adjustPan pans; layout height stays).

## [1.2.215] - 2026-08-12

### Added
- **Dual-layer Tx/UTXO confirmation.** Optimistic soft-locks + ARC status mapping sit beside settle-path machines; hard finality is `MINED` only after SPV-verified BUMP. Chain ingest reconciles pending / reject / reorg; Settings → Statecharts shows the new lifecycle chart.

## [1.2.214] - 2026-08-12

### Fixed
- **Desktop soft-latch ingest loop.** Failed AtomicBEEF builds are deduped and backed off (10m / 1h for not-on-chain ghosts); tip polls no longer fan out dozens of parallel 8s hydrates; item inbox retries cut from 15×2s to 2×4s.

## [1.2.213] - 2026-08-12

### Fixed
- **Mobile → Desktop collectable receives failing AtomicBEEF.** Soft-latch ingest preferred a raw tip-only BEEF (0 parents / 0 BUMPS), cached it, and `internalizeAction` rejected it forever. Indexer BEEF is preferred first; parents are hydrated into a valid AtomicBEEF; tip-only raw is no longer cached.
- **Activity NFT rows stuck on Verifying… with blank thumbs.** Failed item ingest clears the pending row; stale Verifying receives expire after 2 minutes; Activity thumbs fall back to the origin content URL when inventory has no `imageUrl`.

## [1.2.212] - 2026-08-12

### Fixed
- **Activity “Sending…” missing while a send is in flight.** Pin the pending row immediately on confirm (before heal / listOutputs); keep Recent Activity visible during Desktop Working; synthesize a live top row from payment progress when durable storage is late; do not collapse a re-send onto a prior settled spend of the same tip (restored after a failed broadcast).

## [Unreleased]

## [1.2.211] - 2026-08-12

### Fixed
- **Mobile keyboard must pan, not shrink.** Stop binding the app shell to visual-viewport height (that crushed Activity). Keyboard tracking only scrolls the focused field; Android uses adjustPan.

## [1.2.210] - 2026-08-12

### Changed
- **Three-part architecture.** Named `@handcash/wallet-ui` package is the shared UI core (`src/`). Desktop Electron and Mobile Capacitor are thin shells. Bump script keeps the core version locked to Desktop.

## [1.2.209] - 2026-08-12

### Fixed
- **Incoming NFTs stuck on Verifying forever.** Await authenticity clears when a lineage walk cannot run (budget / cooldown / conclusive miss) and times out after 90s; failed remittance verify falls through instead of spinning.
- **NFT thumbnails blank while metadata showed.** Broken GorillaPool content URLs no longer leave an eternal skeleton — Collect / details / Activity fall back to the collectable icon.
- **Desktop support logs missing wallet lines.** Uploads now prefer the renderer ring (collectables / BRC) and only append a short Electron main tail.
- **Outbound Activity “Sending…”.** Money, BRC-29, and collectable sends pin a pending Activity row until broadcast settles or fails.

## [1.2.208] - 2026-08-12

### Fixed
- **Keyboard covering UI.** Mobile shell tracks the visual viewport + Capacitor Keyboard so the app height and bottom bars stay above the soft keyboard on every screen (send money, send item, chat, settings).


## [1.2.207] - 2026-08-12

### Fixed
- **Balance never recovered after false UTXO write-off.** Refresh restores `spendable: false` outputs that are still on-chain.
- **Activity stuck on Verifying while Collect already verified.** Pending Activity rows reconcile from inventory; UI defers to proven inventory state.


## [1.2.206] - 2026-08-12

### Fixed
- **Restore money send layout.** Reverted the sticky-footer/keyboard-inset experiment. Item send mirrors money again (same Review/Cancel placement; To is not autofocused, matching money).


## [1.2.205] - 2026-08-12

### Fixed
- **Failed send wrote off live balance (~$0.10).** Iterator-crash recovery called `releaseStaleSpendableOutputs`, which bulk-marked UTXOs unspendable without on-chain proof. Only real already-spent network errors may release.
- **Item-send keyboard covered the bottom bar.** Collectable send autofocused the To field (full keyboard) while money focused amount (decimal pad). Pin Review/Cancel as a sticky footer, lift the tab bar with visualViewport inset, and use `adjustResize` on Android.


## [1.2.204] - 2026-08-12

### Fixed
- **Mobile→Desktop payment never arrived.** Delayed `createAction` could return a txid that later failed as `doubleSpend` (never on chain) while Activity still showed Sent and remittance never helped the payee. Sender now confirms with `postBeef` before Activity / inbox notify. Leftover failed-action unfail in recover paths stays off.

## [1.2.203] - 2026-08-12

### Fixed
- **Sent NFT bouncing back into Collect.** A lagging address scan un-hid tips that were already sent, so the same item could be sent twice and then vanish from Collect while Activity still showed the transfers.
- **Penny send “undefined is not iterable”.** Leftover doubleSpend actions were unfailed on every unlock and poisoned the next payment. Refresh no longer requeues them; that crash maps to a retry hint and local conflicts are cleared.

## [1.2.202] - 2026-08-12

### Fixed
- **Desktop CI typecheck.** Activity pending-status parse widened `status` to `string`, so `tsc` failed and no installers uploaded for 1.2.201.

## [1.2.201] - 2026-08-12

### Fixed
- **Verifying receives show in Activity.** Inbound payments and items write a pending Activity row as soon as the tip card lands, with “Verifying…” until internalize finishes — not only after success. Soft-latch / item / SPV ingest uses raw-tx BEEF so indexer timeouts no longer stall digest.

## [1.2.200] - 2026-08-12

### Fixed
- **Desktop ingest of mobile BRC-29.** Remittance arrived without Atomic BEEF and indexer `getBeefForTxid` timed out at 8s, so payments never internalized. Ingest now wraps Bitails/WoC raw tx as BEEF. Outbox retries reattach local BEEF. Duplicate ingest polls no longer stampede.

## [1.2.199] - 2026-08-12

### Fixed
- **Android remittance `Failed to fetch`.** `sendMessage` was sending `X-BRC103-*` headers that BRC-CLOUD CORS did not allow, so WebView blocked the request before it left the phone. Wire auth is `X-BRC33-*` only; BRC-103 stays signed locally. Pending outbox retries after install.

## [1.2.198] - 2026-08-12

### Fixed
- **BSV send matches toolbox/Babbage.** One `createAction` broadcasts immediately. Remittance still goes on `sendMessage`; if the box misses, retry from a local outbox — no `noSend`, no abort, no second payment (that was the double-spend). Stuck leftover noSend actions are released before the next spend. `sendMessage` failures are logged.

## [1.2.197] - 2026-08-12

### Fixed
- **Inbox-fail fallback is identity-address P2PKH, not a scan QR.** If the payee messagebox is unreachable, abort the noSend BRC-29 and broadcast to their identity address so Desktop can claim via address scan. No physical scanning / claim-receipt QR.

## [1.2.196] - 2026-08-12

### Fixed
- **BRC-29 is a real P2P settle path.** `brc29SendMachine` + `Brc29SettlePath` — no fake “recipient offline”, no `/files` on Android. Remittance (± inline Atomic BEEF) goes on `sendMessage`. After inbox delivery, sender silently `postBeef` so the tx is on-chain even if the payee never broadcasts. If the inbox is unreachable, sender broadcasts and shows a `brc29:` claim receipt (QR / copy) so the payee can still claim. Desktop does not ACK the inbox until ingest succeeds, and same-identity sends still notify our box so the other device can claim.

## [1.2.195] - 2026-08-12

### Fixed
- **Mobile BEEF upload / peer delivery.** Android `fetch(File)` fails (`Failed to fetch`), so item and BRC-29 sends posted a tip card without Atomic BEEF and skipped sender broadcast — Desktop never received them. Uploads now send a `Blob` (not `File`); a box ack without BEEF is not delivery (sender broadcasts). Payee ingest can SPV-fetch BEEF by txid after that broadcast.

## [1.2.194] - 2026-08-12

### Changed
- **Item send is P2P-first.** Soft-latch classify once into `ItemSettlePath`
  (`peerDeliver` / `selfReceive` / `externalBroadcast`). Sender signs `noSend`;
  HandCash peers get Atomic BEEF and broadcast. Sender `postBeef` only after
  `DELIVER_FAILED` or for self/external. Stuck action-batch reservations are
  aborted before the next createAction.

## [1.2.193] - 2026-08-12

### Fixed
- **Stop burning collectables after a failed self-send.** A stuck latch (`no longer spendable`) no longer ghost-relinquishes the tip from the `1sat` basket. Unknown locking scripts stay in inventory; failed sends protect the tip and retry tip-only. Settle Atomic BEEF is remembered locally so the next send can find the owning transaction.

## [1.2.192] - 2026-08-12

### Changed
- **HandCash is the default history host.** Onboarding, unlock, and cloud-health apply HandCash cloud unless you chose no backup or a custom host. Settings no longer require pasting a workers.dev URL.
- **BRC-29 payee broadcasts.** Sender signs (`noSend`) and delivers Atomic BEEF + remittance to the peer; the recipient internalizes and submits. Sender broadcasts only if delivery fails. Self-pay credits locally. Remittance QR is no longer the send-success UX.

## [1.2.191] - 2026-08-11

### Added
- **Offline BRC-29 remittance QR/URI** (`brc29:`) beside messagebox — scan or paste to claim without the box. Send success shows copy + QR.
- **BRC-103 identity headers** on messagebox alongside interim ECDSA (server accepts either). Full Authrite Peer sessions still deferred.

### Changed
- SPV receive copy is **Receiving (SPV)**; extra rawtx + merkle provider failover; GorillaPool remains CDN/display only.

## [1.2.190] - 2026-08-11

### Fixed
- **Typecheck for BRC-29 peer pay.** Tighten remittance / tip-hint types so Desktop CI `tsc` stays green after 1.2.189.

## [1.2.189] - 2026-08-11

### Changed
- **Peer tip/pay is BRC-29.** HandCash↔HandCash DM tip, chat pay, and Send-to-friend lock a BRC-29 derived P2PKH and deliver remittance (prefix/suffix + txid) on the tip/pay-sent card; the payee `internalizeAction`s as a wallet payment (SPV BEEF by txid). Plain identity-address P2PKH remains only for pasted/external addresses; address-index scan is the legacy fallback.

## [1.2.188] - 2026-08-11

### Changed
- **DM tip/pay: SPV-first receive.** Tip cards now drive `ingestPaymentByTxid` (BEEF → sweep outs that pay us) with a Receiving… indicator. Address-index polling is only the fallback / secondary verify — same custody grade as soft-latch items, messagebox is just the wake-up.

## [1.2.187] - 2026-08-11

### Fixed
- **DM tip/pay card before balance.** Messagebox tip/pay notifies now retry address ingest for ~12s until funding lands (Bitails often lags the chat card). Also treats `pay-sent` the same as `tip`.

## [1.2.186] - 2026-08-11

### Fixed
- **Messagebox tip hints now kick ingest immediately.** Tip-hint poll runs every ~1.5s in the foreground and forces a chain refresh as soon as a peer soft-latch notify lands — no waiting for the 5s address-scan tick.

## [1.2.185] - 2026-08-11

### Fixed
- **Slow peer item receives (~30–60s).** Foreground chain poll is 5s (30s only when backgrounded). Soft-latch sends also drop a messagebox tip hint with the txid so the peer’s next tick runs chain ingest immediately.

## [1.2.184] - 2026-08-11

### Fixed
- **Verify checkmark on every Collect visit.** Corner mark only spins for real authenticity work (not indexer identify) and only flashes a check when the tip is actually proven.
- **Restore missing Activity history.** Device backup now stores/merges `activity.json` beside BRC-39 and friends.
- **NFT in Activity but missing from inventory.** Tips whose locking script still pays us are no longer ghost-dropped when the address scan lags; tips still on our address are un-hidden from stale “sent” marks.

## [1.2.183] - 2026-08-11

### Changed
- **BRC-33 messagebox compliance.** Chat send/list/ack use PeerServ response shapes (`status`, `sender`, `messageIds[]`) and interim ECDSA identity headers (sender/recipient bound by proof, not spoofable body fields). BRC-169 §7 encrypted envelopes and BRC-103/104 Authrite remain deferred.
- **Stop advertising withdrawn BRC-156.** Capability / health / manifest list `147`+`150` only (`latchedSend` remains for soft-latch). Desktop BRC-156 doc matches the withdrawn notice; on-chain `BRC156` marker kept for legacy soft-latch discovery.

### Added
- **Federated messagebox addressing (Phase 1).** Handle resolve persists the peer `messagebox` URL on friends; chat send/file upload posts to that box (BRC-CLOUD remains the default fallback). Architecture SSoT: `docs/wallet-p2p-messagebox.md`. Settings statecharts gain Wallet I/O / Coordinator / Sign / Chain ingest / Messagebox maps.

### Fixed
- **Release build TypeScript.** `oneSatImport.test.ts` mock-call typing no longer fails `tsc --noEmit` (blocked v1.2.182 CI).

## [1.2.182] - 2026-08-11

### Fixed
- **Slow Collect after soft-latch P2P receives.** Latch-proven tips no longer hit GorillaPool / ancestry during address classify; tip + latch internalize in one BEEF (parallel across txs) so a burst of inbound NFTs paints without serial indexer waits.

## [1.2.181] - 2026-08-11

### Fixed
- **Broadcast “all services error” on already-spent tips.** Bitails missing-inputs was reported as every broadcaster failing. Send now detects spent tips/latches before broadcast, drops them from inventory, and shows that the item was already spent.

## [1.2.180] - 2026-08-11

### Fixed
- **“Undelayed … results require review” on mobile send.** Soft-latch / BSV sends use delayed broadcast again, but still require `postBeef` (or clean sendWith) before success. Prior ghost doubleSpends are unfailed on Refresh and on this error so the tip is spendable again.

## [1.2.179] - 2026-08-11

### Fixed
- **Ghost send hid collectables.** Delayed-broadcast 404 txids marked tips “sent” and blocked re-import for 24h. Refresh now heals hide + import marks when the spend txid is proven absent on-chain, so missing NFTs that never left the address come back.

## [1.2.178] - 2026-08-11

### Added
- **Add friend by $handle.** Friends → Add accepts `$handle` / `@handle` / bare handle (and peerpay URIs); resolves via BRC-CLOUD to an identity key and defaults the label to `$handle`.

## [1.2.177] - 2026-08-11

### Fixed
- **Mobile soft-latch ghost txids (WoC/Bitails 404).** `signAction` had been set to delayed broadcast for speed; the phone returned a txid without a successful network post. Soft-latch now sync-broadcasts and confirms via `postBeef` before success. PostBeef soft timeouts raised again so large ordinal BEEFs are not raced out.

## [1.2.176] - 2026-08-11

### Fixed
- **Collectable send “unlockingScriptLength must be at least one valid value”.** Soft-latch inputs always need `unlockingScriptLength` for the toolbox; the 1.2.175 omit-for-speed experiment is reverted. Other send speedups (no lineage hydrate, Bitails-first postBeef, deferred Argon2) stay.

## [1.2.175] - 2026-08-11

### Fixed
- **Faster soft-latch sign / broadcast.** Skip tip→origin lineage hydrate on the send hot path (it was burning seconds then omitting). Plain P2PKH tips no longer force the signable→signAction round trip. Bitails-first postBeef with tighter soft timeouts. Defer post-spend BRC-39 Argon2 so encrypt does not freeze the UI right after send.

## [1.2.174] - 2026-08-11

### Fixed
- **Outbound collectable send no longer toasts "Item received" / verified.** Soft-latch files the recipient tip in the sender's `1sat` basket for remittance; after send the live address scan was cleared so ownership fate skipped and that tip painted as a receive. Outbound tips are now marked sent immediately, and basket rows that pay someone else are dropped even before the address scan returns.

## [1.2.173] - 2026-08-11

### Fixed
- **History push fail-closed on thin overwrite** — auto BRC-39 upload refuses when local managed spendable is below the remote header / durable high-water unless `actionCount` proves UTXOs were spent. Cloud stores `X-HandCash-Spendable-Sats` + `X-HandCash-Action-Count`. Manual Settings upload remains an explicit force.

## [1.2.172] - 2026-08-11

### Fixed

- **History recovery:** one-time previous-password field when the cloud blob is still legacy password-encrypted.

## [1.2.171] - 2026-08-11

### Changed

- **History backups (BRC-39):** sealed to the wallet root key, not the unlock
  password. Restore history needs no second password. Legacy password blobs
  still decrypt once, then re-upload as root-key.

## [1.2.170] - 2026-08-11

### Fixed

- **History replace:** recovery / Settings “Replace from cloud” wipes this
  wallet’s toolbox IndexedDB then pulls BRC-39 into a clean localState — fixes
  under-restored UTXOs when soft-latch dust raced a merge pull.

## [1.2.169] - 2026-08-11

### Added

- **Restore → history gate:** after keys are sealed, prompt to restore the
  encrypted history backup (balance, activity, friends, connected apps) before
  opening the wallet. Skip remains available for chain-only.

## [1.2.168] - 2026-08-11

### Fixed

- **Restore:** skip the post-create “recommended setup” panel; apply default
  history URL and recompose so balance + TX history pull from BRC-39.
- **History pull:** empty-local BRC-39 recovery is no longer blocked by the
  backup push watchdog; soft-latch dust alone no longer counts as “has history.”

## [1.2.167] - 2026-08-11

### Added

- **Restore → Cloud:** new-device setup can retrieve HandCash / Haste trustholder
  slices (in-app OTP) plus optional offline slice — any two restore the wallet.

### Changed

- **Use on another device:** points new installs at Restore → Cloud for trustholder
  recovery.

## [1.2.166] - 2026-08-11

### Changed

- **Cloud key backup:** email registration stays in the wallet OTP prompt — no
  portal browser redirect. First deposit auto-enrolls the email with the provider.

## [1.2.165] - 2026-08-11

### Changed

- **Cloud key backup:** each trustholder is independent — deposit HandCash or Haste
  one at a time. Recommend two providers + offline slice; no coupled “both at once”
  button. Shared 2-of-3 share plan persists across enrollments.

## [1.2.164] - 2026-08-11

### Added

- **Cloud key backup:** register gate opens the trustholder portal (`openExternal`,
  email prefilled); OTP continue after portal registration; settings back-stack so
  Keys → Cloud backup → History navigates correctly.

### Changed

- **Settings Security:** Cloud key backup listed first (before Key slices).
- **Key slices / Device handoff:** cloud backup is the primary recovery CTA.

### Fixed

- Trustholder deposit no longer falls through to silent `dev-token` when email-OTP
  fails for a registered path.

## [1.2.163] - 2026-08-11

### Fixed

- **Release CI:** TypeScript errors that blocked Mac/Windows/Linux installer
  builds since 1.2.159 (unused imports, provisional inscription shape,
  service-order nullability).

## [1.2.162] - 2026-08-11

### Changed

- **Collect tokens:** one-row horizontal carousel (icon + ticker + amount) above items.

## [1.2.161] - 2026-08-11

### Fixed

- **Tokens stay loaded:** BSV-21 list uses a durable cache (like NFTs), 20s
  `listOutputs` timeout + in-flight coalesce, and keeps the last paint on
  lock / transient failures instead of wiping Collect.
- **Token re-import loop:** successful `bsv21` internalization marks outpoints
  so chain polls do not re-BEEF the same tips every tick.
- **Post-ingest token paint:** refresh + early import paths call `listFungibles`
  off the critical path (parallel with collectables).
- **Empty-wallet check:** toolbox emptiness includes basket `bsv21`.

### Changed

- **Coordinator:** per-region serial queues (chain / spend / history / recompose)
  so a waiting backup no longer blocks a queued send behind one shared FIFO.
  Machine guards still forbid unsafe overlaps.

## [1.2.160] - 2026-08-11

### Fixed

- **Handle send:** `$handle` recipients resolve through BRC-CLOUD before payment
  (no more “Invalid recipient address…” when the to-field still holds a handle).
- **Stale claim cache:** `getClaimedCloudHandle` re-checks the registry and clears
  local “claimed” state when the handle was wiped, so /claim-handle can remint.

## [1.2.159] - 2026-08-11

### Fixed

- **Collectable receive:** latch-proven tips paint immediately (quick ingest) with
  the corner loading circle while BRC-150 verifies in the background — no more
  hiding the NFT behind “Item arriving” until lineage settles.
- **Sync pill:** network refresh timeouts no longer show “Sync failed”; soft
  “Network slow” while local balance stays usable.
- **Handle claim errors:** clearer `invalid-ticket` copy when market and
  BRC-CLOUD secrets diverge.

### Changed

- **SPV-forward providers:** prefer Bitails / JungleBus / CoinGecko ahead of
  WhatsOnChain for raw tx, merkle proofs, address UTXO scan, tip headers, and FX
  so chain work is less dependent on a single WoC rate budget.

## [1.2.158] - 2026-08-11

### Fixed

- **Side column layout:** restore direct-child flex for Recent activity /
  What is BSV (1.2.157 keep-mounted wrapper broke overflow/hidden text).
- **Sync forever:** 45s syncing watchdog; poll retries soon after yielding to a
  send; stuck payment progress clears after 90s.
- **Visibility:** Settings → Statecharts shows a live layers strip (coordinator,
  sync, payment, activity). Syncing pill tooltip includes coordinator summary.

## [1.2.157] - 2026-08-11

### Fixed

- **Send feel:** Review skips toolbox balance when the painted balance already
  covers the amount; raises spend priority otherwise so sync yields. BSV send
  leaves “Waiting to send” as soon as the spend region is held.
- **Activity after send:** keep the feed mounted during Working, bust feed cache
  on every activity write, and record collectable sends as soon as the txid
  exists. Chain ingest no longer awaits `listCollectables` on the coordinator
  path (background paint instead).

## [1.2.156] - 2026-08-11

### Fixed

- **Send collectable toasts:** outbound soft-latch tips no longer toast
  “Item received” / “Authenticity verified” on the sender. Foreign locks are
  ghost-dropped immediately; self-receive still announces correctly.
- **Identity handle:** show claimed `$handle` on the Identity page (or a claim
  CTA); shorten the identity-key note and QR copy hint.

## [1.2.155] - 2026-08-11

### Fixed

- **Handle claim:** `claimCloudHandle` requires a HandCash `claimTicket` from
  items-market (Auth0 + `$alias` ownership) before minting on BRC-CLOUD.

## [1.2.154] - 2026-08-11

### Fixed

- **Activity token icons:** resolve icons from the icon inscription outpoint (and
  held fungibles), not the token id — mint/send/receive rows show the ticker
  image instead of the generic collectable glyph.
- **Activity token context:** show quantity with distinct Minted / Sent /
  Received titles, a mint badge, and amount-column `±qty`; identity mint and
  transfers record `amt`/`dec`/`icon` on the activity item.

## [1.2.153] - 2026-08-11

### Fixed

- **Mint hang / indexer outage:** bound `getBeefForTxid` and hydrate with
  timeouts; prefer local storage proofs; short-circuit when the caller's deploy
  AtomicBEEF is already broadcast-safe. Identity mint uses
  `acceptDelayedBroadcast` so WoC/Chaintracks downtime cannot surface as
  "merged Beef failed validation" on an otherwise valid BEEF.

## [1.2.152] - 2026-08-11

### Fixed

- **Mint `merged Beef failed validation`:** stop patching missing parents as
  `txidOnly`. Those stubs block toolbox broadcast hydration and fail
  `processAction` verify (no `allowTxidOnly`). Hydrate parents with full proof
  BEEF instead so tip raw bodies remain for `sourceTransaction` and broadcast
  verify passes.

## [1.2.151] - 2026-08-11

### Fixed

- **Mint `sourceTransaction`:** stop omitting tip `inputBEEF` when parents are
  missing. Tip-only / AtomicBEEF wraps are kept (raw tip bodies are required for
  signable inputs) and missing parents are patched as `txidOnly` so
  `trustSelf:'known'` still verifies — fixes "Every signableTransaction input
  must have a sourceTransaction" from the 1.2.150 omit path.
- **Permission vs sync:** while a connect/pay prompt is open, raise spend
  priority so BRC-39 history upload yields the wallet FIFO instead of gating
  Approve behind encrypt.

## [1.2.150] - 2026-08-11

### Fixed

- **Mint `inputBEEF` / trustSelf:** never attach an AtomicBEEF or tip-only wrap
  that fails `verifyValid(true)`. That was surfacing as "The inputBEEF parameter
  must be valid Beef when factoring options.trustSelf". Prefer a verifiable BEEF,
  otherwise omit and rely on `trustSelf:'known'` + `knownTxids` for tips already
  in wallet storage.

## [1.2.149] - 2026-08-11

### Fixed

- **Stale UI on mint (`sourceTransaction` / 400):** reclaim `:5173` and bind
  `::1` so Chromium cannot keep loading an old Vite / `/Applications` HandCash
  while a newer build is running (logs showed renderer v1.2.144 vs main 1.2.148).
- **Unlock freezes permission prompts:** unlock/create no longer encrypt+upload
  the ~26MB BRC-39 on the hot path; push is deferred ~60s and skipped while a
  permission prompt is pending.
- **Auth mint known tips:** identity-mint `createAction` now passes `knownTxids`
  (collectables pattern) with `trustSelf: 'known'`.

## [1.2.148] - 2026-08-11

### Fixed

- **Mint `sourceTransaction` again:** identity-mint enrich no longer swallows
  inputBEEF failures (which left tip spends unproven). Caller deploy BEEF is
  merged with cache/indexer/raw-tx fallbacks, and finished signables always
  cache the new tip for the follow-up mint.

## [1.2.147] - 2026-08-11

### Fixed

- **Auth tip CHECKSIG fail on mint:** finishing identity-mint signables now
  sighashes the full inscription‖P2PKH‖Sigma locking script (not plain P2PKH).
  Matches the on-chain auth tip scriptCode so remints unlock cleanly.

## [1.2.146] - 2026-08-11

### Fixed

- **Mint approved but no txid:** auth tip / Sigma fund inputs use
  `unlockingScriptLength`, so createAction returned a signable without a txid.
  Identity mints now complete with root-key P2PKH `signAction` (same pattern as
  soft-latch collectables) before responding to the app.

## [1.2.145] - 2026-08-11

### Fixed

- **Auth mint `sourceTransaction`:** BSV-21 remints now attach `inputBEEF` for
  auth tip (and Sigma fund) inputs; deploy createAction txs are cached so the
  follow-up mint can prove the tip immediately.
- **Token receives missing from Activity:** newly imported BSV-21 tips write a
  Received row; identity mints log as token activity (not a 1-sat payment spend).

### Changed

- **Fungible remints:** identity issuance enrich covers `deploy+auth` / `mint`;
  Collect aggregates primarily by token id (issuer+ticker merge remains for
  legacy sibling deploy+mints).

## [1.2.144] - 2026-08-11

### Fixed

- **Working / Starting… stuck after mint:** approving View items no longer
  starts the payment progress panel (only createAction / signAction do).
- **Token list:** tips that share the same issuer + ticker are one Collect
  row with a summed balance (separate deploy ids still track underneath).

## [1.2.143] - 2026-08-11

### Fixed

- **Pay hang on "Preparing payment":** BRC-39 auto-backup no longer holds the
  wallet lock through Argon2 encrypt + upload (~26MB). Snapshot export stays
  exclusive; encrypt/upload run unlocked. Post-spend backup defers while a
  send is queued, and historyReplica yields the FIFO when spend priority is
  raised. Identity-mint inputBEEF times out at 8s if the indexer is down.

## [1.2.142] - 2026-08-10

### Changed

- **Spends trust local wallet state:** no chain/address heal before send or
  BRC `createAction`. Refresh stays a Dashboard concern.
- **Identity mint permission:** BSV-21 deploy+mint prompts as **Mint token** /
  Identity mint (Sigma-backed), never Auto-pay or generic payment.

## [1.2.141] - 2026-08-10

### Changed

- **BSV-21 ticker icons are P2P-local:** mint caches inscription bytes; Collect
  resolves icons from durable cache / BEEF (no Gorilla content URL). Hash
  identicon when bytes are missing. Aligns with BRC-163 Icon media.

## [1.2.140] - 2026-08-10

### Fixed

- **Typecheck:** Dashboard processing copy only reads `title` from action prompts.

## [1.2.139] - 2026-08-10

### Fixed

- **Token icons** no longer stick on a blank loader — hash identicon shows
  immediately; on-chain `icon` overlays only after it loads (Panda `display`
  was overriding HTML `hidden` on Avatar.Image).
- **Activity history merge** keeps both send and receive rows for the same
  txid (keyed by txid+kind). Wallet coin rows title as Sent/Received coins;
  Activity filter includes **Wallet coins**.

### Changed

- **Sequential approvals:** skip pre-prompt chain heal for interactive pays
  (auto-pay still heals first); right column shows Working while broadcasting.

## [1.2.138] - 2026-08-10

### Changed

- **Desktop approvals** fill the reserved right column (replace market + recent
  activity) with scroll body and pinned Deny/Approve. Locked-wallet prompts stay
  centered modals.
- **Permission listeners** support multiple UI surfaces so prompts no longer
  vanish after lock/unlock.

### Added

- **Activity events** for non-tx actions: connect/deny/approve/decline,
  disconnect, and add friend. Unlinking an app no longer wipes that app's
  history. Filter chip: Actions.

### Fixed

- **BSV-21 Sigma fund** — any spendable default UTXO can bind issuer Sigma
  (not only ≥1000 sats).

## [1.2.137] - 2026-08-10

### Added

- **BSV-21 issuer binding.** Deploy+mint via BRC-100 is Sigma-signed with the
  wallet identity key (1Sat-compatible). CI/tag `issuer:` mirror the pubkey.
  Collect → Tokens shows issuer + token id (not symbol alone).

## [1.2.136] - 2026-08-10

### Changed

- **BSV-21 tags:** token id is `bsv21:<tokenId>`, not `id:<…>`. Tag prefix `id:`
  is reserved for per-output identity. Readers still accept legacy `id:` tags.

## [1.2.135] - 2026-08-10

### Fixed

- **Collect → Tokens empty after self-mint.** `deploy+mint` tips have no `id` in
  remittance — the tip outpoint *is* the token id. Listing no longer drops them.

## [1.2.134] - 2026-08-10

### Fixed

- **Release build** — `dialog.showSaveDialog` when no BrowserWindow is focused
  (Electron types reject `undefined` parent).

## [1.2.133] - 2026-08-10

### Fixed

- **Release build TypeScript** — narrow `saveImageFile` result before reading
  `canceled` so `tsc --noEmit` passes in CI.

### Added (from 1.2.132)

- Collect → Tokens (BSV-21) + optional cosigner tip kind.

## [1.2.132] - 2026-08-10

### Added

- **Collect → Tokens (BSV-21).** Fungible tips in basket `bsv21` (not Pay / not
  `1sat`). Import from legacy address scan, list/aggregate by token id, details
  panel. Holders verify their tips; issuer mint policy is trusted.
- **Optional cosigner tip kind.** Detect MNEE-shaped cosign locks and remittance
  (`cosign` in customInstructions / tags). Cosigned tips refuse a plain spend
  until a cosigner client is configured (`cosigner_required`).

## [1.2.131] - 2026-08-08

### Added

- **Copy image / Save image** on collectable details. Desktop copies to the
  clipboard or a save dialog; mobile uses the share sheet when the WebView
  cannot download directly.

## [1.2.130] - 2026-08-08

### Fixed

- **BRC-150 trusted spend path instead of FIFO sat mapping.** Verifiers now
  require the parent 1-sat vin to be the input whose sats land on the claimed
  vout. Preceding input sources (funding before the ordinal vin) must be in the
  remittance BEEF — fail closed if missing. AtomicBEEF is no longer preferred
  when it would drop those sources.

## [1.2.129] - 2026-08-08

### Fixed

- **Self-send “Item received” toast before the card is in inventory.** Receive
  toast / chime / OS banner now fire only when the tip paints in the collectables
  list, not when ingest first sees it on the address.

## [1.2.128] - 2026-08-08

### Fixed

- **“Waiting to send the collectable” hung on a full address rescan.** The tip
  is already in the basket; send no longer heals via WhatsOnChain (7s timeout
  when it is down). Background ingest aborts when a send is queued, and WoC is
  skipped for 45s after a failure.

## [1.2.127] - 2026-08-08

### Fixed

- **BRC-150-verified tips still refused as unrecognized.** Missing locking
  script (`listOutputs` / scriptOffset) no longer blocks send when authenticity
  is already BRC-150. Covenant tips still refuse. Send log is `[collectables]`,
  not leftover `[brc-156]`.

## [1.2.126] - 2026-08-07

### Fixed

- **Send still refused as unrecognized on 1.2.125.** `listOutputs` often
  returns no locking script (toolbox skips `scriptOffset === 0`). Soft-latch
  now recovers the tip script from the tip BEEF before classifying.

## [1.2.125] - 2026-08-07

### Fixed

- **“Collectable locking script is unrecognized” on soft ordinals.** Tip
  classification now normalizes hex (`0x` / SDK `toHex()`), and treats any
  spendable P2PKH branch (bare or inscribed) as soft-latch — not unknown /
  covenant.

### Changed

- Nav label **Apps → Connect**; panel heading **Connected apps**.

## [1.2.124] - 2026-08-07

### Fixed

- **Desktop CI release for v1.2.123.** Tag fired before `@zxing/library` was in
  the lockfile (`npm ci` failed). Retag with synced lock.

## [1.2.123] - 2026-08-07

### Changed

- **Removed hardened BRC-156 Commit/Settle** (scrypt covenant, ~14k LOC). Soft-latch
  + BRC-150 remain. Stuck covenant tips show **Remove from wallet** (local abandon;
  sat stays locked on chain — covenant cannot soft-exit or burn via hashOutputs).

## [1.2.122] - 2026-08-07

### Changed

- **BRC-150 remittance is append-first.** Soft sends reuse or extend a prior
  verified package (prepend tip + merge tip tx) before any lineage hydrate;
  post-send tip-named proofs are remembered for the next hop. BRC-150 updated
  for parent remittance inherit + sender extend.

## [1.2.121] - 2026-08-07

### Fixed

- **Activity thumb empty square while scrolling.** DeferredImage was clearing
  `src` on scroll-away while status stayed ready, so a blank `<img>` flashed.
  List thumbs now keep the decoded src once shown; paint never shows an img
  without a src.

## [1.2.120] - 2026-08-07

### Fixed

- **Covenant tips stuck with "BRC-156 not enabled".** Soft tips still soft-latch
  (hardened genesis remains off). Tips already on a hardened covenant can
  Commit/Settle resend again — soft-latch cannot unlock them.

## [1.2.119] - 2026-08-07

### Changed

- **Collectables authenticity is BRC-150 only.** Soft-latch remains the send
  mechanism; remittance verify accepts parent-tip proofs so receivers skip
  lineage walks. UI maps legacy BRC-156 pins to Verified · BRC-150. Background
  walks stamp BRC-150 for all tips; session lineage budget raised to 8.

## [1.2.118] - 2026-08-07

### Changed

- **Wallet sends use soft-latch / BRC-150 only.** Hardened BRC-156 Commit/Settle
  is disabled for live sends (covenant embeds made fees scale with prior settle
  size). Receive still verifies hardened tips from others. Protocol code and
  tests remain; `isHardenedSendEnabled()` is false.

## [1.2.117] - 2026-08-07

### Fixed

- **Hardened send false "insufficient funds".** Aborted Commit/Settle left tip and
  funding change reserved as noSend, so settle saw only a fraction of the balance.
  Release is now an explicit stage (abort refs → wipe nosends → assert clean) on
  preflight and failure. Unlock fee declaration no longer applies a 1.35× / 20k
  double-pad on top of embedded parent txs.
- **Authenticity badge flip-flop (Unverified ↔ BRC-150).** List UI was painting
  raw verify misses over durable proven tiers. Badge now only follows provenCache.

## [1.2.116] - 2026-08-07

### Fixed

- **Hardened tips still landing as BRC-150.** Background lineage walks stamped
  durable BRC-150 after settle before (or instead of) BRC-156, then never
  upgraded. Stamp BRC-156 immediately after Commit/Settle broadcast, refuse to
  walk/stamp hardened tips as BRC-150, and re-run the covenant ladder when a tip
  is stuck on BRC-150 so it can upgrade.

## [1.2.115] - 2026-08-07

### Fixed

- **Self-pay missing from Activity.** A send to your own address shares one txid;
  the receive was skipped because that txid was already logged as the send. Now
  send/receive dedupe by kind so both rows appear.
- **Activity thumbnails pop in while scrolling.** Prefetch ~one viewport ahead
  so the next rows arrive decoded instead of as skeletons.

## [1.2.114] - 2026-08-07

### Fixed

- **Hardened tips stuck on BRC-150.** After a successful Commit/Settle broadcast,
  authenticity verify raced chain indexing for the Commit, failed BRC-156, then
  stamped durable BRC-150 and never upgraded. Remember local BEEF, prefer Commit
  from settle parents, retry brief chain lag, allow 150→156 upgrade on hardened
  tips, and do not demote hardened tips to BRC-150 while covenant proof is pending.

## [1.2.113] - 2026-08-07

### Fixed

- **Settle "input was not reserved by this action batch".** Delayed-proof UTXOs
  already present in settle `inputBEEF` were skipped for batch reservation, then
  rejected at commit. Always extend-reserve explicit inputs not yet in batch
  state. Also removes the item-details loading spinner chrome.

## [1.2.112] - 2026-08-07

### Fixed

- **Settle "wallet storage was busy".** Settle `signAction` no longer sync-broadcasts
  (that path AbortError'd on Android). Signs with delayed broadcast, then
  `postBeef` Commit+Settle. StorageIdb no longer masks the real IDB error as
  `AbortError` when a transaction aborts.

## [1.2.111] - 2026-08-07

### Fixed

- **Missing BRC-150/156 traits.** Remittance/OP_RETURN `mimeType` alone no longer
  counts as a rich resolution — cards stay upgradeable until GorillaPool returns
  collection traits (Pixel Fox eyes/background/etc.).
- **Spurious "Item received · verified" on unlock.** Receive announces are
  durable across sessions; already-proven pending rediscoveries are skipped.
- **Settle AbortError.** Unlock vs `signAction` retried separately with a short
  pause and clearer step logs.

## [1.2.110] - 2026-08-07

### Fixed

- **Settle AbortError.** Pause the toolbox monitor during hardened Commit/Settle
  and retry covenant `signAction` once on IndexedDB `AbortError` (was failing
  mid-settleSign with a bare "AbortError" toast).
- **Auto support logs.** With an upload URL set, logs ship every ~45s, on
  backgrounding, and immediately after a send failure — no Settings tap needed.

## [1.2.109] - 2026-08-07

### Fixed

- **Hardened settle BEEF.** Settle no longer chain-fetches the unbroadcast
  `noSend` commit (orphan local txids like `996bf929…` 404'd and broke retries).
  Merge signed commit AtomicBEEF + tip/proof; refetch delayed proof only.
- **Stuck noSend cleanup.** Abort held settle/commit refs (settle first), then
  `listNoSendActions(abort)` before each hardened send and after failure — frees
  tip/funding locked by a prior abort / mid-flight kill.
- **Send failures log.** `failSend` and hardened catch `console.error` so remote
  support uploads capture the real abort / sourceTransaction message.

## [1.2.108] - 2026-08-07

### Fixed

- **Hardened resend refuse.** Delayed proof now resolves from remittance
  `proofOutpoint`, remittance `commitTxid_1`, and the tip settle OP_RETURN — not
  only customInstructions. Refuse reasons are logged (`send path=refuse reason=`).

### Changed

- **Wallet-wide explicit paths.** Soft-latch and BSV sends use
  `softLatchSendMachine` / `bsvSendMachine`. Cursor rule
  `explicit-wallet-paths.mdc` — no silent fallthrough.

## [1.2.107] - 2026-08-07

### Changed

- **Explicit collectable send paths.** `chooseSendPath` + `collectableSendMachine`
  classify tip kind → hardenedGenesis | hardenedResend | softLatch | refuse.
  Covenant tips can no longer fall through to soft-latch. Delayed proof comes
  only from remittance / covenant link / OP_RETURN (`DelayedProofSource`).
- **Ownership fate classifier.** Address-scan ghosting only `ghostDrop`s soft
  P2PKH tips; covenant / brc156 stay via `keepCovenant`.
- **hardenedSendMachine is phase-driven** (`advanceHardened` asserts each step).

## [1.2.106] - 2026-08-07

### Fixed

- **Hardened resend proof outpoint.** Prefer tip remittance / covenant
  `linkOutpoint` over the latch-basket row (beacons and stale soft-latches were
  fed in as the delayed proof → `sourceTransaction` / missing-txid failures).
- **No soft-latch fallback for covenant tips.** P2PKH unlock cannot spend them;
  falling through emptied inventory while the tip stayed unspent on chain.
- **Covenant tips survive address-scan ghosting.** BRC-156 tips never sit on the
  P2PKH UTXO set; list no longer relinquished them after settle grace.

### Changed

- **Log upload URL auto-provisions** a BRC-CLOUD `hc-*` bucket on first use so
  crash uploads always have a sink. Agents: see `.cursor/rules/remote-support-logs.mdc`.

## [1.2.105] - 2026-08-07

### Fixed

- **Item details loading.** Replaced skeleton blocks with the same circular
  spinner used elsewhere; cache hits paint immediately (no flash).
- **Stuck Verifying · BRC-150.** Progress walks no longer pin tips into the
  receive-awaiting set; aborted walks no longer burn the session budget; opening
  details finishes the preferred tip; proven tips clear stale spinners; empty
  traits re-fetch via origin on details open.

## [1.2.104] - 2026-08-07

### Fixed

- **CI typecheck:** `hasProvenTier` import typo that blocked Mac/Win/Linux builds.

## [1.2.103] - 2026-08-07

### Fixed

- **Hardened settle unlock budget.** `unlockingScriptLength` undersized settle
  embeds (state + tip scripts + framing), so signAction rejected spends with
  `unlockingScript length … exceeds expected length`. Estimate now includes
  extras, pads aggressively, and floors at 48k bytes.
- **BRC-150 badges survive restart.** List cache no longer paints Unverified
  over a durable `proven.v2` hit; proven tiers are monotonic (never downgraded
  to unproven); detail verify no longer short-circuits on sticky unproven misses;
  empty Electron durable keys read as absent.

### Changed

- **Authenticity + hardened send are XState machines** (`authenticityMachine`,
  `hardenedSendMachine`) with Mermaid charts under Settings → Statecharts.

## [1.2.102] - 2026-08-07

### Fixed

- **Hardened BRC-156 sends in the browser bundle.** Vite was stubbing Node
  `events` as `{ default: {} }`, so scrypt-ts `Provider extends EventEmitter`
  threw `Class extends value #<Object>` and every identity-key send fell through
  to soft-latch. Alias the real `events` (+ `buffer`) packages in Vite.
- **Sending stays visible while a transfer runs in the background.** The status
  pill prefers payment progress over Syncing / sync errors, progress starts
  before the spend queue waits, and the in-flight collectable shows a Sending
  badge on inventory and details.
- **Sends waiting on sync get priority.** In-flight chain ingest yields ordinal
  work so a queued send can begin sooner.

## [1.2.101] - 2026-08-07

### Fixed

- **BRC-156 hardened sends survive the WebView.** Full `process` shim
  (`cwd` / `version` / `nextTick`) plus a classic `index.html` bootstrap so
  scrypt-ts no longer throws into soft-latch / BRC-150 on mobile.
- **Verified BRC-150 items get traits.** Remittance-proven and soft-latch
  rebuild paths adopt the origin and fetch indexer metadata instead of leaving
  empty traits.
- **Permission Accept shows a toast.** Connect/action approval surfaces
  Connected / Approved feedback.
- **BRC-100 connect bring-to-front is more reliable** on Android
  (`AppTask.moveToFront` + retries).

### Changed

- **Permission and payment screens are tighter** — less copy, denser layout.
- **Status pill Syncing text is larger.**

## [1.2.100] - 2026-08-06

### Fixed

- **Desktop installer CI builds again.** A duplicate `toUnderscoreOutpoint`
  import broke `tsc` on Mac/Windows/Linux release jobs.
- **Item received toasts when the tip first paints**, not after media resolve —
  inventory arrivals and latch-proven tips announce immediately.
- **Hardened BRC-156 sends in the WebView.** scrypt-ts still needs Node `Buffer`
  at sign time; polyfill it (and `process.env`) so mobile no longer falls through
  to soft-latch / BRC-150.

## [1.2.99] - 2026-08-06

### Fixed

- **Item received toasts immediately**, and the corner spinner stays until
  authenticity settles — no gap between spinner and verified, and receive is
  not delayed behind the verify walk.
- **Status pill typography is consistent** and tap-to-refresh stays a button
  while unlocked (no more swapping to a non-clickable pill).

## [1.2.98] - 2026-08-06

### Fixed

- **Item toasts fire on receive and again on verify.** Latch-proven tips no
  longer wait for authenticity before "Item received"; settling proof then
  shows "Item verified".
- **Hardened collectable sends no longer fall through to soft-latch in the
  WebView.** Covenant code used Node `Buffer` and residual `process.env`, which
  threw and aborted the hardened path.

## [1.2.97] - 2026-08-06

### Fixed

- **Status pill stays short while syncing.** Phased labels like "Syncing payments"
  overflowed the bubble; the pill shows Syncing… again and puts detail in the
  tooltip.
- **Verifying on Items and Activity is a tiny corner mark** — spinner, then check,
  then gone — instead of a "Verifying…" text pill that ate the row.

## [1.2.96] - 2026-08-06

### Fixed

- **A self-sent tip no longer vanishes from inventory.** The ownership filter
  treated a lagging address scan as proof the tip was spent, so a tip that
  landed in the basket and then missed the next scan was relinquished as a
  ghost. Tips stay unjudged for a settle grace window even when the scan is
  newer, so indexer delay cannot wipe a fresh self-send.
- **Hardened collectable sends work in the browser again.** scrypt-ts reads
  `process.env.NETWORK` / `BASEURL` at call time; without a Vite shim that threw
  `process is not defined` and every send fell back to soft-latch.

### Changed

- **On mobile, a BRC-100 permission request occupies Activity** and replaces the
  bottom nav with Decline / Accept, instead of a modal over the wallet.

## [1.2.95] - 2026-08-06

### Fixed

- **A verified collectable no longer shows a truncated origin and empty traits
  while its image already paints.** The content URL is built from the proven
  origin, so the PNG loads even when the tip is still unindexed. Name and traits
  were still asked of the tip itself — which 404s for hours after a transfer —
  so the card kept `4ee07451…_33` as its title. Metadata lookup now asks the
  known origin first, and proven-but-thin cards retry on the pending cadence
  instead of waiting ten minutes.

## [1.2.94] - 2026-08-06

### Fixed

- **A collectable no longer arrives unverified with no traits.** The sender was
  dropping BRC-150 provenance whenever the BEEF it held for a mined tip stopped at
  that transaction — there was no ancestry left to derive a path from, so the item
  went out with nothing to prove it and landed as "Unverified". The send now
  hydrates the tip's lineage from chain data before giving up, and puts the whole
  assembled BEEF on the wire instead of the atomic form, which discarded the very
  ancestry the receiver has to walk.
- **A card that arrives with a proven origin but no traits now asks the indexer
  again.** An empty-traits cache entry counted as an answer and blocked the upgrade
  pass, so a name and image that were merely late never arrived at all.
- **A lineage walk gives up the moment somebody opens the panel.** Yielding between
  fetches was not enough, because merkle verification in between is synchronous
  work; the walk now checks for a waiting basket read at every hop.
- **A transient network miss no longer costs a full day of "Unverified".** The 24h
  lineage retry budget is spent only on a conclusive result.
- **Multi-minute "main thread blocked" warnings are gone.** Android freezes a
  backgrounded WebView's timers, and the first tick after resuming reported the
  whole time away as a stall — burying the real jank in eight-minute phantoms.

## [1.2.93] - 2026-08-06

### Fixed

- **A latch-proven collectable no longer sits in "Item arriving" forever when the
  indexer cannot name it.** Ingest already knew the tip had landed (its soft latch
  is local proof), but without an indexer origin it held the output out of
  Collectables and retried every 8s. It now walks the tip's own ancestry from
  chain BEEF as a last resort, pins BRC-150 with a proven origin, and lets the
  card fill in once an indexer is reachable again.
- **Lineage walks no longer starve the basket read.** A hop yields to the UI, and
  a walk backs off when a newer `listOutputs` is in flight — the path that was
  timing out the Collect panel while proofs ran in the background.
- **The "holding, awaiting origin" log no longer floods every poll.** The same
  waiting tip may repeat that line at most once a minute.

## [1.2.92] - 2026-08-06

### Fixed

- **The sending wallet's record of a transferred collectable stayed broken.** Once
  a tip is sent on it leaves the basket, and its cached identity was too thin to
  repair the row, so the transfer that sent the item away — the only trace of it
  left in this wallet — kept the wrong origin and a 404 thumbnail. Records now heal
  from the lineage verdict, which outlives the output it judged, and tips that
  survive only in the activity feed get their own lineage walk: being spent does
  not make chain data unprovable.

## [1.2.91] - 2026-08-06

### Fixed

- **A received collectable could vanish from the inventory once its lineage was
  proven.** Two listed tips sharing an origin are deduplicated to one card, and the
  survivor was picked by whichever row carried richer metadata. That was harmless
  while every mis-resolved tip claimed itself as its own origin, and wrong the
  moment proofs gave both the same correct origin: a transfer that had just landed
  lost to stale basket residue. The tip seen most recently now wins, since a
  satoshi cannot sit in two outputs. Nothing was ever spent or relinquished — the
  item was only hidden from the list.
- **The top activity row no longer blinks on every visit.** Deferred images reset
  to a skeleton on mount, so a remote ordinal thumbnail flashed while rows painting
  a bundled asset did not. URLs already decoded this session paint straight from
  cache.
- **Adopting a proven origin no longer empties the card.** The indexer is asked
  about the origin just proven, instead of blanking the name and traits until the
  upgrade pass happened to run.

### Added

- **The induction hop can now earn BRC-156.** A first hardened transfer settles
  over its Commit token alone, so the alternating-proof triangle cannot apply and
  it scored 150. It is now verified in its own right — covenant tip, Commit link,
  beacon to the recipient — and bound to a real ordinal by proving the lineage of
  the tip it inducted, since covenant continuity can only carry forward what
  induction established.
- Sends log which rung they took (`hardened send: genesis induction` or
  `soft-latch send:` with the reason).

## [1.2.90] - 2026-08-06

### Added

- **Collectables earn BRC-150 by proving their own lineage.** An ordinal imported
  from an indexer arrives with no remittance, so it could never be verified — and
  because hardened induction refuses an unproven tip, it could never climb to
  BRC-156 either. The wallet now walks such a tip back to its inscription, one
  proven transaction per hop, and verifies the assembled path. Runs behind the
  list, three items per session, never during a spend.

### Fixed

- **A confirmed item could not be proven at all.** AtomicBEEF keeps only the
  subject and its recursive dependencies, and a mined tip carrying its own merkle
  proof depends on nothing — so the BRC-150 rebuild stripped the ancestry it had
  just assembled and then failed to find it. Lineage is now verified from the
  whole BEEF, and the remittance size cap applies only to what actually travels
  in a remittance.
- **Activity rows show the item as it is now, not as it arrived.** Rows froze the
  name, origin and image URL at receive time, so a repaired collectable stayed
  broken in Activity and in transaction details forever.
- **A proven origin outranks a claimed one** wherever an item is painted or sent
  on, so a sender's wrong origin stops propagating.

## [1.2.89] - 2026-08-06

### Fixed

- **Activity no longer flashes the top row on every visit.** Seen tracking keyed
  off the clock-minted row id, so a re-recorded or remounted feed treated yesterday's
  newest entry as an arrival. Rows are now remembered by txid / tip outpoint, and
  the flash only fires for unseen events under ten minutes old.
- **Stuck collectables with a wrong remittance origin heal themselves.** Tips that
  already show a name but have no inscription content are re-walked once per retry
  window; a richer indexer answer replaces the broken image URL.

## [1.2.88] - 2026-08-06

### Fixed

- **Collectable names keep their casing in inventory and on send.** The BSV SDK
  lowercases every output tag, so painting the Collect grid from `name:` tags
  showed "pixel foxes" even when history still had "Pixel Foxes". The list and
  remittance now prefer the resolution cache / tip remittance (which preserve
  case), and imports seed that cache with the proper name.
- **Unindexed 1-sat tips are no longer adopted as their own origin.** GorillaPool
  answers "unknown sat" with a self-referential empty origin; treating that as
  identity left items stuck on a 404 image and handed the same broken claim to
  whoever received them next.

## [1.2.87] - 2026-08-06

### Changed

- **Faster collectable signing.** Tip BEEF, latch discovery, provenance, origin
  script, and settle input BEEF no longer each pay a fresh storage round trip:
  a session BEEF cache dedupes them, fetches run in parallel, settle reuses the
  commit AtomicBEEF, and soft-latch provenance reuses the tip BEEF already in
  hand. Pre-send `listOutputs` is tagged by origin instead of reading the whole
  basket, and confirm-screen warm now compiles the covenant artifact so the
  first unlock does not.

## [1.2.86] - 2026-08-06

### Fixed

- **Activity only flashes a transaction the user has never seen.** The highlight
  was decided from per-mount state, so opening Activity announced whatever was on
  top. Which entries have been shown is now recorded durably; a restored history
  seeds silently.

## [1.2.85] - 2026-08-06

### Fixed

- **Sends no longer stall on the hardened path.** Covenant genesis needs a
  BRC-150-verified tip, and that is now checked before the send fetches the
  origin BEEF or loads the covenant chunk. A hardened attempt that fails before
  anything is broadcast falls back to soft-latch instead of failing the transfer.
- **Sync no longer walks the whole wallet on every pass.** Transaction bodies are
  cached and de-duplicated across ladder steps, hardened induction only runs when
  the settle body is already at hand, indexer misses survive a restart, and one
  pass identifies a bounded number of unknown outputs.
- Bounded the storage provider calls used by sync, so a host that accepts the
  socket and never answers can no longer wedge receiving.

### Changed

- The covenant bridge chunk warms while the confirm screen is open, so a
  hardened send does not pay for loading it.

## [1.2.84] - 2026-08-06

### Added

- **Live hardened BRC-156 send** for identity-key peers: Commit (`noSend`) →
  Settle (`sendWith`) unlocks the clean-room alternating delayed-proof covenant
  against the wallet-built AtomicBEEF txs. Genesis from BRC-150 P2PKH tips and
  covenant re-spends both work. Soft-latch remains the fallback for bare addresses.

### Changed

- Covenant `assertCanonicalTx` allows up to 16 inputs so wallet funding fits.
- Settle hashOutputs includes the 0-sat OP_RETURN latch state.

## [1.2.83] - 2026-08-06

### Fixed

- **Renderer no longer pulls scrypt-ts / node:path.** Hardened receive helpers live
  in browser-safe `oneSatHardenedReceive.ts`; covenant script-exec stays Node-only.
  Unblocks Desktop packaging CI for v1.2.82+.

## [1.2.82] - 2026-08-06

### Added

- **Authenticity ladder** — collectables evaluate BRC-156 hardened → BRC-150 v2 →
  indexer (always `unproven`). Versioned proven cache + UI badge.
- **Complete BRC-150 receive path** — full tip→origin path, AtomicBEEF subject,
  `ord` envelope check; receive can rebuild from wallet BEEF before indexer.
- **Clean-room BRC-156 alternating delayed-proof covenant** (`scrypt-ts`) with
  Tx1→Tx6 script-exec tests and bounded receive verifier. Schema-2 latch state
  uses `proofOutpoint` (not a sliding grandparent window).

### Changed

- Soft-latch remains the **live send** path. Hardened wallet send stays gated
  (`isHardenedSendEnabled() === false`) until the createAction unlock bridge
  lands — no false O(1) hardened-send claim.
- Spec (`docs/bsva/brcs/tokens/0156.md`) documents alternating delayed proofs
  and rejects marker+CHECKSIG / sliding-window forgeries.

## [1.2.81] - 2026-08-06

### Changed

- **Latched 1Sat BRC number is 156** (upstream merge of PR #198), not 154.
  Protocol marker is `BRC156`. Spec: `docs/bsva/brcs/tokens/0156.md`.


## [1.2.80] - 2026-08-06

### Added

- **BRC-156 Phase 1b — on-chain latch state.** Soft-latch Settle now writes tip (1) +
  latch (2-sat P2PKH) + `OP_FALSE OP_RETURN "BRC156" {origin, tip, parentLatch, …}`.
  Receivers name latched items from the settle tx itself — no ordinal indexer and
  no ancestry walk. Spec: `docs/bsva/brcs/tokens/0156.md`.

### Fixed

- **Activity row no longer flashes on tab switch.** The fresh animation only runs
  when a new top entry actually arrives (same moment as payment-received toast).

- **Collectable details open from cache with a skeleton.** Clicking an item no
  longer stalls on a hung `listOutputs`; missing items use a styled empty state.

- **Pending latch tips no longer hammer indexers.** Proven tips retry on a 45s
  window (not every 8s poll), with a bounded input probe. Indexer walk is
  bootstrap-only for unlatched tips.

### Improved

- **Background receive hooks for mobile.** Wallet unlock/lock and receive events
  are dispatched so Android can keep sync alive and post local notifications.


## [1.2.79] - 2026-08-06

### Fixed

- **Sent direction badge fits its circle.** The overlaid send arrow is 75% of
  its previous size; the badge and receive icon remain unchanged.

## [1.2.78] - 2026-08-06

### Improved

- **Faster ordinal receive when an item is already known to have landed.** While
  latch-proven tips wait on the indexer, chain polls run every 8s instead of
  30s. Transient BEEF/import failures retry after 45s (was 5 minutes). Latch
  tips no longer write the 10-minute dust miss backoff.

- **Chat matches Aeon chrome.** Messages use flat tokenized surfaces, compact
  geometry, and Aeon-style tabs/composer instead of the old Nexus gradient skin.

- **New chat messages and activity rows stay in view.** Threads stick to the
  bottom when you are already there; the activity feed pins and briefly flashes
  newest rows when you are at the default top scroll.

- **Clearer status pill.** “Chain failed” is now **Sync failed** (balance may be
  stale; coins/keys are fine). Cloud history errors say **Backup failed**.

## [1.2.77] - 2026-08-06

### Fixed

- **Inbound tip/pay cards are claims, not confirmed receipts.** Messagebox
  tip cards no longer show as “Received”; they mark **Claimed · unverified**
  until chain verification exists. Attachment links must come from the
  messagebox host. Tip binding now stores `boundMessageId`, and delivery
  failures after an on-chain tip surface a hint.

## [1.2.76] - 2026-08-06

### Added

- **Chat file transfer.** Attach a file (up to 8 MB) in a thread; it uploads to
  the messagebox and lands as a downloadable card for the recipient. Shared
  files also appear under the Files tab.

### Improved

- **Chat bubbles and tip cards.** Sent and received bubbles are more distinct;
  tips use their own gold-accented card with sat and fiat amounts instead of a
  generic Pay label. Sub-cent tips no longer display as `$0.00`.

- **Activity icons.** BSV transfers use the same logo as the price panel. Send
  badges are directional blue (not error red); receive stays green.

## [1.2.75] - 2026-08-06

### Fixed

- **Activity icons now show the asset with direction as a subscript.** An NFT's
  image is the main icon and BSV transfers use the BSV logo. A small send or
  receive badge overlays the corner, so the icon identifies both what moved and
  which way without replacing the asset with a generic action glyph.

## [1.2.74] - 2026-08-06

### Fixed

- **Activity rows now lead with the asset, not the verb.** An NFT's image and
  name are the subject; BSV transfers use the BSV logo and `BSV`. `Send` or
  `Receive` is the smaller subtitle, so direction remains clear without
  competing with the thing that moved.

- **Collectables no longer depend on one explorer being reachable.** The toolbox
  registers a single provider for raw transaction lookups — WhatsOnChain — while
  every other lookup has two or three. Importing a tip needs those bytes for the
  transaction and each unproven ancestor, so on a device WhatsOnChain is
  throttling (the throttled reply carries no CORS headers, which the browser
  reports as `TypeError: Failed to fetch`) every collectable bounced with "The
  txid … must be valid transaction on chain main" — for transactions sitting on
  every other explorer. Bitails and JungleBus are now registered behind
  WhatsOnChain, so a busy primary costs a round trip instead of the import. The
  toolbox still hashes each returned body against the txid it asked for.

- **Opening Collect no longer waits on the network.** The ownership check
  introduced in 1.2.73 awaited an address scan before painting, and a throttled
  provider answers in tens of seconds — one open took 17s. The grid now paints
  from the basket immediately and reconciles when the scan lands. The address
  scan itself gives up after 7s and falls through to the toolbox services.

- **A stale scan can no longer hide a tip that just arrived.** Ownership is only
  applied to tips the scan was in a position to see; anything first seen after it
  ran stays on screen until a newer scan judges it.

## [1.2.73] - 2026-08-06

### Fixed

- **Collectables are now the tips this address still holds — nothing else.** The
  panel was painting from basket `1sat` plus a durable cache, and basket rows
  outlive a spend until something releases them. Sending an item (or spending it
  elsewhere) left a ghost card on screen; opening Collect before a refresh could
  show last session's tips even when the UTXOs were gone.

  The list is now basket tips ∩ live 1-sat outpoints on the receive address. Tips
  missing from that set are dropped and relinquished. Chain ingest feeds the
  same scan into the filter so a just-imported tip appears and a spent tip does
  not wait on the Collect panel timer. Details also re-check ownership before
  opening. A failed address scan keeps the prior basket list rather than wiping
  the grid.

### Changed

- **Activity detail prefers "Transaction", and item rows link into Collect.**
  The subcontext breadcrumb said "Payment" for every history row. It now says
  "Transaction" unless the row is an explicit app BSV payment. Collectable
  transfers open the item (thumbnail, media, and name) when the tip is still
  held — or, for a receive, by the recorded outpoint.

## [1.2.72] - 2026-08-06

### Fixed

- **Collectables bounced while payments went through, because internalizing an
  ordinal needs a block header the Chaintracks host has not stored yet.**
  Verifying a merkle root and recording which block a proof belongs to are two
  separate calls, and only the first one had failover. The second,
  `getHeaderForHeight`, reaches straight into `options.chaintracks` past every
  wrapper, so a host sitting below the tip returned nothing and the toolbox
  reported "The hash parameter must be valid height '961050' on mined chain
  main". A P2PKH sweep is a `createAction` and stops after the root check, which
  is why money arrived and every collectable failed.

  Header lookups now fall back to Bitails and WhatsOnChain, and a header from a
  public source is only accepted when it proves itself: its 80 bytes must hash
  to the hash the API reported, and that hash must clear the proof-of-work its
  own `bits` field encodes. Forging one would require mining it.
- **Cloud backup was failing permanently over a diagnostic breadcrumb.** BRC-38
  export refuses a document containing any JSON `null`, and the monitor writes
  them — a proof service that answers without a txid leaves `{"txid":null}` in a
  `provenTxReqs` history note. One note poisoned every subsequent backup, and
  the watchdog's failure counter then locked backups out for twelve hours.
  These notes carry no wallet state, so when the export is refused for a null
  member the wallet now strips the nulls out of the stored history and exports
  again.
- **A backup hold no longer outlives the build that earned it.** The watchdog
  had already pushed the next attempt twelve hours out, so shipping the fix
  above would have changed nothing until tomorrow. The streak now records which
  version failed and clears itself on upgrade.

## [1.2.71] - 2026-08-06

### Fixed

- **A chain tracker that was merely behind was rejecting real payments.**
  `Beef.verify` asks "is this the real merkle root at this height?" and the
  interface only permits `true` or `false` — so a tracker whose header store has
  not reached that height answers `false`, which the caller cannot tell apart
  from "this proof is forged". The Chaintracks host sat at block 961039 while the
  user's deposit was mined at 961052, so every recent payment was declared
  invalid and surfaced as `valid AtomicBEEF` or `valid Beef when factoring
  options.trustSelf` — wording that blames the data for what was really a stale
  index. It also drove the "Chain failed" pill.

  A `false` is now only believed from a source that demonstrably holds the height
  being asked about. An error, a timeout, a height past the source's tip, a 404,
  or a denial the primary cannot corroborate are all "unknown", and the question
  moves to the next source. `true` still requires a source to affirmatively
  confirm the root, so nothing is waved through unverified; when nothing can
  answer the tracker throws instead of denying, because a denial is permanent and
  discards the deposit while a throw is retried on the next sync.
- **Added Bitails as a header source, ahead of WhatsOnChain.** The toolbox's
  service rotation already leans on WhatsOnChain for raw transactions, UTXO scans
  and exchange rates, so by the time a merkle root needs checking the device is
  often rate-limited there — and a throttled response carries no CORS headers, so
  a WebView reports it as `TypeError: Failed to fetch`, indistinguishable from the
  host being down. Verified roots are also cached per height, since they cannot
  change, instead of being re-fetched for every BEEF.

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
