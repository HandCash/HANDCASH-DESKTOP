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

## Changes

The existing menu chart's SWITCHED boundary now follows runtime selection and
the identity-scoped cached balance projection, without waiting for a fresh
balance read. Dashboard's normal reconciliation remains responsible for fresh
display state. Cached balances remain display-only and are no longer rewritten
with a new timestamp just because an account was selected.

IDB managed-coin pages previously loaded all eligible candidates then sliced.
Eligibility now runs inside the cursor before offset/limit, so only the requested
page is materialised. Counts use the same predicate. Regression coverage uses
real IndexedDB with incomplete derivations and spent rows preceding valid coins.

Unconfirmed-change reads now use 100-row lock scopes and explicitly yield after
releasing each scope. The existing 2,000-row scan ceiling is unchanged.

Vitest resolves the engine from this checkout: a shared node_modules workspace
symlink otherwise caused the new regression to execute the other worktree's
engine instead of these edits.

## Remaining / not verified

This is a partial remediation, not a claim that switching is now instant on a
phone. No post-change device measurement or UI verification has been performed.
A balance cache already existed; a durable balance-and-count summary and
background paged full-coin loading are not implemented here. Wallet.balance's
aggregate path and exact listOutputs totals still scan all matching rows.
Activity ledger and reverse inventory pagination remain expensive in this log;
they need separate bounded/keyset work, not just a smaller result array.
No blanket claim that all storage locks exclude whole-table reads is made.
No Refresh/history boundary, network call, custody or spend authorization was
changed.
