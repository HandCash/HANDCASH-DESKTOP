# Wallet switch investigation — 2026-11-06

## Evidence

Fetched the latest uploads directly from the BRC-CLOUD log sink documented in
`src/wallet/logUploadPrefs.ts` and `scripts/triage/core.mjs`. No environment
files or wallet storage were read. Mobile ships the renderer ring through
`src/wallet/logShip.ts`, not an Electron log file.

Android upload (bucket alias `android`), 2026-11-06:
- 13:28:53.146: recompose-chain completed in 42,658 ms. This is not a
  measurement of switching or of the separate history restore.
- 13:35:54.848: cold account switch completed in 828 ms; ingest drain 15 ms.
  This session timing stops before the menu's awaited balance read.
- 13:35:34.313: a 10-item 1sat page at offset -431 held storage for 2,847 ms.
- 13:35:38.502: activity-ledger storage read held storage for 2,083 ms.
- 13:35:46.137: balanceView(change) held storage for 1,638 ms.
- Earlier queue waits exceed 3 seconds; contention persists after switching.

The other known bucket (alias `phone`) has no switch-done measurement in its
latest upload. These are bounded ring tails, not a complete switch trace.
No measured UTXO count or per-stage unlock timing proves a large UTXO set is
the cause. Repeated inventory/history scans and shared reader-lock contention
are directly observed.

## Review of a579e27d

The cached-paint boundary and managed eligibility-before-pagination are sound.
They were not a complete bounded-read fix: each page still gathered all matching
transaction IDs, exact protocol totals still counted the whole result, and the
display aggregate still materialised every eligible coin. The pending-change
reader still rescanned growing offsets. Tests covered one seven-row page, not
large physical pages, interrupted reads, or cache freshness.

An additional existing correctness race mattered once reads yielded: a late
old-wallet read could change session-wide balance values and combine its cash
with the newly selected wallet's pending change. Dropping a coalesced flight
also did not stop its old result from repopulating caches.

## Follow-up changes

- The app chart records cached versus locally read balance. Selection paints
  the identity/chain-scoped cache without waiting for storage; an explicit
  background local read publishes only to the still-current runtime. This
  local reconciliation does not wait for the network settle/recompose.
- The durable display snapshot also stores managed spendable output count,
  local output-row count and spendable subtotal. Its read timestamp changes
  only after a successful read, never on selection. Legacy snapshots remain
  readable; non-summary writes discard old counts. No cached amount/count
  authorizes a payment.
- Display totals on the native IDB provider use primary-key pages of at most
  100 physical output rows. No whole-wallet count, script hydration or complete
  transaction-ID set runs in this projection. The manager lock is released
  before every UI yield. A waiting foreground send defers the projection
  instead of triggering an unbounded fallback.
- Provider identity and local write revision fence every summary page, the
  completed total, and the later pending-change read. A concurrent local write
  discards the projection. These revisions are per provider instance, not a
  cross-tab snapshot protocol; cached summaries remain display-only.
- Native pending-change reads also use 100-physical-row keyset pages, avoiding
  offset-prefix rescans. They can reach change beyond 2,000 physical rows;
  legacy providers retain their previous 2,000-matching-row ceiling.
  Background display reads wait for foreground sends outside the lock.
- Runtime and invalidation-generation checks reject late reads before changing
  global totals or durable snapshots. Confirmed-only spend checks still use
  authoritative Toolbox operations, not the display summary.
- Transaction eligibility uses status-index key seeks for the encountered
  parent IDs, not getAllKeys for the whole wallet. Exact BRC-100 totals and
  returned output ordering are unchanged.
- Both Vitest and TypeScript resolve the engine from this checkout. The shared
  node_modules workspace link otherwise tests/types the other checkout.

Regression coverage includes real IndexedDB pages (250 physical rows),
incomplete/spent rows, transaction-status changes, writes between pages,
a pending row beyond 2,000 physical rows, yield/lock boundaries, waiting sends,
runtime changes, pre-credit late reads, and real app/menu chart transitions.

## Verification

The final engine build and TypeScript check passed against this worktree's
engine source. The full Vitest run passed: 564 test files, 4,516 tests;
one performance file / three tests remain skipped by the existing configuration.
These are local regression results, not Mobile latency measurements.

## Remaining / not verified

No post-change phone timing, rendering/frame trace, real-device send contention
benchmark, or visual UI verification has been performed. The recorded 828 ms
switch is an old build's runtime-selection duration, not the new UI latency.
A large UTXO set is plausible but not proven by these uploads.

The new background load streams coins into a complete display projection, not
an in-memory full coin list. Confirmed Wallet.balance aggregates and exact
BRC-100 listOutputs totals still scan the matching set; removing those requires
a separately verified transactional aggregate/index contract, not reuse of a
stale display cache. Generic offset/reverse inventory pages and activity ledger
also retain remaining scan costs. No claim that every storage operation is now
bounded is made. The new display/keyset paths never hold the manager lock
across a whole-wallet scan or a network call.

Refresh remains chain ingest; history/recompose remains a separate layer.
No network, custody, signing, or release behavior was changed.
