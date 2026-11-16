# Migration remediation plan — 2026-11-16

Tracking: 50520c4a-fa9c-45df-8705-8aa7860f8132. This is a review and routing plan, not implementation or release evidence.

## Evidence and critical review

- Reviewed task a054fc40-f1ab-4de0-908d-7b2e89d1d08a revision 2 and task 1eb4ef96-2514-4b1e-9ad3-c21a43c3debc revision 8, including revision history. Task decision queries returned no records for the reviewed migration tasks (nor current Desktop project decisions).
- Read-only answer from items-market chat cmwe7g6ac1 reports user chose keys-only encrypted import and removed handle claiming. It reports nonce omission for export calls in 0430a08 and keys-only changes in d1e7824, pushed to pre-prod. These are retained reports, not freshly verified remote or deployment results.
- That chat reports historical 7 installer / 6 migration UI tests on an EARLIER tree. They cannot certify d1e7824. Its final typecheck excluded stale generated .next errors; that is not a clean production build.
- Current Desktop checkout HEAD 91bd5807: migration.ts still exposes legacy Refresh, recovery hints and a 200-entry txid log. That cap bounds a diagnostic log, not established evidence of lost funds or a truncated migration. Do not enlarge it as a speculative fix.
- Current import/encryptedImport.ts binds pending requests to normalized origin, identity, chain and expiry; AES-GCM authenticates the descriptor, duplicate delivery is fingerprinted, plaintext buffer is cleared, and the source is saved before opening Import. This is source inspection, not adversarial-test evidence. A saved source receipt is NOT a sweep or successful migration.
- The old review's throttling/cache observations are not measured bottlenecks. Do not bypass coordinator locks, equate Refresh with BRC-39 recovery, or change cache budgets without profiling. The keys-only website supersedes the earlier hint-transfer direction; legacy compatibility methods in Desktop are not themselves evidence the website still sends hints.
- 077a7d4f-2a0c-4f93-b20a-63784305348e reports shipped bounded concurrency and 58 tests (Desktop 1.3.673, Mobile 0.1.786); do not redo that optimization. Its done state conflicts with explicit remaining restart durability and live benchmark criteria. Ask its owner to reconcile status, not silently declare durability complete.
- 61711a0f-058a-4c6f-8ad9-bc60d93e872e reports shipped automatic BRC-150 verification and 15 tests; device proof completion is still unverified. Import eligibility and complete ancestry verification are different gates.
- Original a054fc40 linked chat cmw8g3evu20 is absent from current list_chats; its task evidence is available, but no additional retained conversation was recovered.
- Applied wallet-layer, lock-discipline, proven-means-proven, chart-tests and Mobile release-evidence rules. No code changes, tests, live requests, wallet writes or funds movement performed in this review. Existing dirty/untracked application files were not touched.

## Self-contained work assignments (NOT delivered)

Every packet: read its task and current decisions first; inspect current Git/history before editing; preserve other workers' unkept edits; implement only verified gaps with focused regression tests. Use edit_file, focused project tests, typecheck, lint and diff checks on the exact resulting tree. Record command results and SHAs. Pushes, deployments, installations, wallet-data changes and fund movement require separate approval. Never log exported shares, private keys, ciphertext payloads or identity relationships.

### P0 A — website export/import integration
Owner: items-market. Reuse 1eb4ef96-2514-4b1e-9ad3-c21a43c3debc; destination existing closely related chat cmwe7g6ac1.
Prerequisite: none for local fixtures; approved bridge session and deployment access for live gates.
Request: validate 0430a08/d1e7824 against current branch rather than reimplementing them. Add focused tests proving export requests omit nonce consistently from both headers and signed payload while other API calls retain nonce; encrypted keys-only delivery, lost-response retry and receiver-change failure expose no secrets. Cover export failure with safe actionable text. Check current installer redirect restrictions; do not remove authentication checks or add cloud work unless the client regression reproduces.
Acceptance: focused tests, touched-source lint, clean typecheck INCLUDING regenerated Next types, production build; exact deployed commit and bundle checked at /migrate; authorized test export returns 200 and Desktop saves the expected source. HTTP 200 for the page alone fails this gate. Live gate depends on B.

### P0 B — Desktop receiver boundary
Owner: HANDCASH-DESKTOP. New narrowly scoped child task under this plan; do not take the original read-only review task.
Prerequisite: coordinate with bcef9603-166d-44d2-aef8-75716f4d499f and 7cbc2729-1f89-4560-a68b-ce651cc35297 owners before touching account/storage code.
Request: add or locate adversarial encrypted-import fixtures for wrong origin, expired request, changed identity/chain, bad authentication tag, different-payload replay, identical retry, lock/account switch during persistence, and failed persistence. Fix only failures proven by those fixtures. Confirm begin/complete routes enforce authenticated migration origin, not merely nonempty strings. Require source ownership isolation and no signing/broadcast from delivery.
Acceptance: real-handler fixtures show rejected requests cannot contaminate another account or expose secrets; successful retry saves once; persisted receipt and later preview/confirm remain distinct. Focused import/bridge/storage tests and project typecheck pass. Coordinate overlapping active work, do not replace its edits. Device validation waits for explicit approval.

### P1 C — restart-safe sweep and scale
Owner: HANDCASH-DESKTOP. Reuse 077a7d4f-2a0c-4f93-b20a-63784305348e for its explicitly unfinished durability/benchmark scope; owner must reconcile its done state before implementation.
Prerequisite: owner confirms current queue implementation and existing b5832c6a-e97f-4568-b5e2-eb91fd5f2b9b performance ownership; B's isolation contract.
Request: retain shipped four-lane optimization. Implement only missing restart recovery using durable account-bound checkpoints. Test crash before/after checkpoint, duplicate resumption, offline retry and signed/broadcast recovery without aborting signed transactions. Benchmark a large synthetic UTXO fixture; record baseline, fixture size, network model, lock wait and memory, not an arithmetic speed claim alone.
Acceptance: no skipped/duplicate work, correct account namespace, bounded memory/concurrency, send can acquire storage between slices; focused queue/scan/store tests and typecheck. Real fund benchmark is separately approved and not required to run synthetic tests.

### P1 D — inventory proof/device verification
Owner: HANDCASH-DESKTOP shared src; reuse 61711a0f-058a-4c6f-8ad9-bc60d93e872e.
Prerequisite: B and C exact tested tree; coordinate current owner.
Request: validate existing automatic verification instead of rebuilding it. Cover later batches, restart, offline/incomplete ancestry and invalid hints; fix reproduced gaps only. Complete BRC-150 alone may display proven; indexer hints remain unproven.
Acceptance: focused import/collectables/provenance tests plus typecheck; authorized device inventory counts and proof outcomes recorded separately from release CI.

### P2 E — Mobile shell compatibility and final migration matrix
Owner: HANDCASH-MOBILE (Capacitor shell), not legacy Flutter repos. New verification child task under this plan; coordinate ef915996-1108-4d5d-a393-fed1a31f3e43 upgrade scope.
Prerequisite: A/B/C/D local gates and an explicitly approved release candidate; separately approved installation/test wallet.
Request: verify installed version and shared UI pin, secure upgrade persistence and import restart on Android; add shell regression fixtures for reproduced failures, never fork src panels.
Acceptance: record artifact SHA/version, installed device build, fresh/upgrade, cancel/retry/offline, cold restart and account-switch results. Use disposable fixtures first. Test actual migration/sweep only with separate wallet-data/fund approval; record miner verdict and inventory, not delivery success alone. Desktop counterpart records native persistence on supported platforms; absent platforms remain unverified.

## Conditional work and exclusions

HANDCASH-CLOUD/trustholder work is conditional on packet A reproducing an export failure after the reported client nonce fix. Preserve replay/authentication protections; schema widening or dropping nonce globally is not preauthorized. BRC-CLOUD demo deployment is unrelated. Do not add UTXO/history endpoints, restore handle claiming, redo completed concurrency work, or treat shared-key same-account spend parity as a goal. Installer artifact authentication remains a release gate: confirm checksums/signatures and fail-closed behavior with the Desktop release owner before downloading/installing; absence must be reported rather than assumed repaired.

## Delivery and completion

No actionable packet has been delivered. Available tools include read-only ask_chat, current-chat queue_task and read-only spawn_agent, but no cross-project chat creation/relay or work-message delivery API. ask_chat was used only to recover evidence from cmwe7g6ac1; it does not assign work. In-thread collaboration agents cannot satisfy owning-project chat delivery. Required external action: enable an approved cross-project chat/relay tool (or have the observer deliver A–E into distinct owning-project chats and return their IDs). Do not mark implementation tasks complete when packets are sent. Track acknowledgments, blockers, local tests, remote commits, deployments and device evidence separately.
