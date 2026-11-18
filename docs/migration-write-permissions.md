# Migration app-write permissions (Packet F)

Task: ecea5551-5d50-4660-90bb-ef40329afd0e. Design written before implementation, 2026-11-18.

## Current boundary

- `src/wallet/brc100Handler.ts:1167–1209`: Connect and migration host allowlist precede dispatch. Connect is not consent to import keys.
- `src/wallet/brc100Handler.ts:588–591`: begin/complete dispatch to encryptedImport.
- `src/wallet/import/encryptedImport.ts:43–67,75–129`: five-minute, origin/identity/network-bound receiver; decrypt, parse and immediately save a source, then open Import. No distinct write approval exists.
- `src/wallet/import/store.ts:172–199`: sealed, account-owned source persistence; sources are not spendable wallet outputs. The panel can scan a newly saved source.
- `src/wallet/migration.ts:133–172`: legacy Refresh can ingest outputs directly after Connect; it has no pending-review store.
- `src/wallet/permissions.ts:1437–1505`: existing BRC-100 action prompts; Connected Apps disconnect/expiry revoke origin access. Reuse this queue, not another connect protocol.

## Decision and statechart

An encrypted delivery remains **pending review in memory**, outside the source list and Toolbox. Decrypt/validate first; request an explicit BRC-100 action approval before persistence. The approval shows the authenticated host, receiving account, one HandCash key source, zero coin outputs, zero item outputs and no baskets. Inventory counts are unknown until the later user-initiated scan; do not present sender hints as verified counts. Accepting this review permits saving that exact source only, never scanning, signing, sweeping or internalizing outputs on the app's behalf.

Chart: `pendingReview → committing → accepted`; denial, timeout, disconnect, lock, account/network change or invalid scope → `refused`. Chart actors own review and persistence; no JSX state. The scope is the receiver ID plus immutable encrypted-delivery fingerprint, exact normalized host, receiving identity/account/network, connection generation and five-minute deadline. One successful approval authorizes one persistence attempt. No receipt is a reusable capability. Identical HTTP retries may return the existing result, but never start another prompt/write. Different ciphertext on the same receiver is refused.

The permissions layer issues session-only grants through its existing action queue. Connected Apps exposes their state; disconnect and grant lapse invalidate them. A synchronous authorization guard runs again immediately before the sealed source write, after all crypto/queue awaits, preventing revocation or expiry during encryption from landing data. Grant state and chart contain metadata only, not decrypted keys. Plaintext buffers are cleared; errors stay secret-free. Grants die on lock/account rebind/restart. Approval surfaces retain their existing non-autofocus behavior; no new dialog or keyboard approval shortcut.

The legacy `refreshLegacyAddress` app-write route fails closed with an explicit pending-review-unavailable error: its chain ingest cannot quarantine outputs, so a prompt alone would not supply revocable pending-review semantics. Users may refresh in the wallet; encrypted keys-only migration remains the supported website path. Read-only migration methods remain available. Broader existing BRC-100 signing/receive policies are not changed by this packet.

## Coordination and release gates

`src/` is shared with Mobile. Both platforms use the same grant and review chart; Mobile device checks remain separate from mocked tests.

Legacy items-market contract follow-up (do not edit that repository here): mirror the new refusal of `refreshLegacyAddress` and the complete-import approval wait in `src/lib/brc100/types.ts`, `handcashBrcClient.ts` and `docs/migrate-brc100.md`. Payloads/method names remain unchanged. `saved: true` means the user accepted storing keys, not funds/items migrated. Keep a pending/awaiting-wallet-approval display, allow identical lost-response retries, never automatically repeat with another receiver, and retain nonce/export protections. Packet A's keys-only flow should not call legacy Refresh. Coordinate this before publishing Desktop/Mobile; do not deploy incompatible website behavior silently.

Verification: real chart with fake promise actors and waitFor; no/denied/expired/reused grant, wrong account/network, forged host, disconnect/reconnect and revoke during crypto; store guard must prevent any write/notification; real encrypted delivery and identical retry; focused bridge/import tests, typecheck, touched-source lint, Aeon UI gate for any component changes. No real wallet operations or migration funds without separate approval. Local results, published SHAs/CI and live migration evidence must be recorded separately. No commit/push/install is implied by this design.

## Implementation (local, uncommitted)

- `src/machines/importWriteGrantMachine.ts` (`importWriteGrant`, in `machineManifest`): `pendingReview → authorizing → committing → accepted`, otherwise `refused` with `denied | timeout | revoked | unauthorized | failed`. A REVOKE while waiting for review wins over an approval that arrives later. The `authorizing` guard fails closed if the scope check throws.
- `src/wallet/import/encryptedImport.ts`: decrypt and parse, zero the plaintext, check scope, then review through `requestActionApproval(host, 'completeHandCashImport', { identityKey, chain })`. The wallet writes those args itself, not the app. The review races the receiver deadline. Timeout, disconnect (`revokeEncryptedImports(host)` from `revokeOrigin`/`revokeAllOrigins`), lock or account rebind (`clearEncryptedImports`) and TTL expiry each refuse the delivery and withdraw the queued or open prompt (`withdrawActionPrompts`). `pendingImportReviews()` lists metadata for Connected Apps. Refusals reach the app as status 400 with `IMPORT_REVIEW_DENIED`, `IMPORT_REVIEW_EXPIRED`, `IMPORT_REVIEW_REVOKED` or `IMPORT_SAVE_FAILED`, and their messages never contain secrets.
- `src/wallet/import/store.ts`: `addImportedSource(…, authorize)` runs the guard synchronously right before `durableSetItem`, and before it reports an existing match.
- `src/wallet/permissions.ts`: the prompt summary reads "Save HandCash keys". `completeHandCashImport` is never auto-allowed.
- `src/wallet/brc100Handler.ts`: `refreshLegacyAddress` answers 400 `MIGRATION_PENDING_REVIEW_UNAVAILABLE` and runs no ingest. The origin check (403 `MIGRATION_ORIGIN_DENIED`) still runs first. `getLegacyAddress`, `listMigrationTxids` and `openKeyRecovery` are unchanged.
- Prompt contents: origin, target identity key and network. Item/coin counts and baskets are not shown: this write stores keys only, and counts are unknown until the later scan, which runs in HandCash under the user's own Refresh. The prompt reuses the existing `ActionPermissionDialog` (Aeon `Prompt`); this change adds no UI, and whether that dialog takes keyboard focus has not been checked here.
- Known fail-closed edge: if the HTTP bridge times out its request while the review is open, the bridge's own `cancelPendingPermissions` denies the prompt. The app sees a denial and nothing is saved. The app can start again with a new receiver.

Local tests: `src/machines/importWriteGrantMachine.test.ts`, `src/wallet/import/encryptedImport.test.ts` (real ECDH/HKDF/AES-GCM delivery), `src/wallet/import/store.test.ts` and `src/wallet/brc100Handler.migrationWrite.test.ts`.

### items-market follow-up (write-up only; that repository is not edited here)

Callers of `refreshLegacyAddress`: `src/app/wallet/swap/SwapClient.tsx`, `src/lib/brc100/handcashBrcClient.ts` and `src/lib/brc100/types.ts`.

1. Handle `MIGRATION_PENDING_REVIEW_UNAVAILABLE` by telling the user to press Refresh in HandCash. Do not retry, and do not treat it as an empty result. Remove the automatic call from the swap flow.
2. `completeHandCashImport` now waits for the wallet owner's approval, for up to the receiver's five minutes. Show "Waiting for approval in HandCash", and make sure the client's request timeout covers that wait.
3. Map `IMPORT_REVIEW_DENIED`, `IMPORT_REVIEW_EXPIRED`, `IMPORT_REVIEW_REVOKED` and `IMPORT_SAVE_FAILED` to distinct messages. Only an identical lost-response retry is safe. For any other retry, call `beginHandCashImport` again.
4. Update `docs/migrate-brc100.md`: `saved: true` means the keys were stored with the user's approval, not that funds or items moved.
