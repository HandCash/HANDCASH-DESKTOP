# Activity account isolation investigation

Local investigation, 2026-11-16. No wallet data was inspected or repaired; the user's specific rows remain unverified.

## Verified causes and fixes

- `src/wallet/deviceSync.ts`, `downloadAndMergeActivityBackup`: the response was checked against the account captured before the request, but `mergeActivityEntries` used the account bound after the request. A late A response could therefore persist A's Activity sidecar into B. The merge now receives an immutable identity/index/network owner captured before awaiting. `uploadActivityBackup` likewise exports that captured owner's rows after its lazy import, rather than uploading B's rows to A's object. `appActivity.ts` passes this owner through its existing scoped read/write path.
- `src/wallet/actionLifecycle.ts`, `listLiveActions`: this registry intentionally spans accounts so signed work keeps running. Activity previously merged the entire registry, synthesizing rows for actions belonging to another account. Actions now capture their starting account and Activity uses `listAccountLiveActions`; the global registry, watchdogs and spend-busy checks remain unchanged. This was display leakage, not a ledger write.
- `src/components/RecentActivity.tsx`, `useActivityFeed`: account rebind notifications shared the ordinary 120ms write debounce, retaining the previous projection meanwhile. The exported feed now subscribes to account identity synchronously and keys its child by the wallet namespace. Old cache callbacks are ignored after switching. `walletCaches.ts` includes account index as well as identity and network in the shared cache key.

## Existing isolation retained

- `accountLocalKeys.ts`, `accountLocalKeyFor`: durable sidecars are keyed by network, index and identity. Scoped writes do not prune against another account's ledger.
- `activityLedger.ts`, `readLedger` / `settledTransactions`: the captured runtime selects one exact identity/user, scopes transaction/basket/output queries by userId, and checks runtime currency after asynchronous reads and before publication. The transaction cache also carries namespace and userId. Saved projections carry the namespace and reject a late restore when their runtime is no longer current (`paintSavedActivityLedger`).
- Activity jobs already filter by identity (`ActivityJobRows.tsx`); phrase import progress checks wallet ownership. Coin deposit hooks reread their scoped stores on account rebind. No signing, holding, chain ingest or recompose logic was changed. Chat #1103's staged recompose work and task b5832c6a remain separate and untouched.

## Verification and limits

Job j85: eight focused files, 143 tests passed; `tsc --noEmit` and `git diff --check` passed. Suites: deviceSync.activityIsolation, actionLifecycle, activityLedger.runtime, appActivity, RecentActivity, brc100Handler.accountChange, spendGuard, aeonAdherence. New tests cover rapid A→B→A→B with a late A backup, unchanged B durable entries, export ownership across a lazy-import switch, late signed A action progress while B is displayed, and cache account-index separation. Component tests are server-rendered, not a mounted WebView switch test. TypeScript diagnostics for touched code are clean.

Mandatory Jev UI review is blocked: the process environment has no JEV_API_KEY, JEV_KEY or TYPESAFE_API_KEY (checked presence only). No credential files were read. No visual verification, commit, push, install or restart occurred. Shared `src/` means the fixes also affect Mobile once released.

Before release: configure the review credential securely and complete the UI gate. On Desktop and Mobile, switch rapidly between two accounts with distinct known transactions while a history download and an action finish; verify Activity and Dashboard never show the previous account, switch back, and relaunch to check persistence. Compare the reported suspect txids against each account's actual ledger and scoped Activity backup before proposing any repair. Existing mixed sidecar rows, if any, are preserved; this patch does not guess ownership or delete history. Full network/device reproduction and historical-data attribution remain open.
