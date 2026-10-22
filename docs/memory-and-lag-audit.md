# Memory-leak and UI-lag audit (22 Oct 2026)

A static audit of Desktop's renderer and Electron code at `d3d80a1e`. No live profile was taken: the app's own `[memory]` heap lines and `[stall]` main-thread lines (`src/wallet/appLog.ts`) live in the wallet's storage, so the next step for lag is reading them from a support log of a slow session.

## Method

- Every module-level `Map` and `Set` (302 of them) was checked for a delete, clear or size cap. 19 had none; each was read by hand for what keys it and how far that can grow.
- Every `setInterval` was checked for a matching clear and for what each tick costs.
- Each leak was reproduced in a test or shown from the code before it was changed.

## Fixed

| Where | What grew | Fix |
| --- | --- | --- |
| `src/wallet/brc100Handler.ts` | A bridge action whose account changed mid-request answered 409 but was never reported, so its phase clock stayed in `actionPhaseClocks` and its activity row stayed on "approving" until the 90-second stuck watchdog. | The 409 path reports the action as failed. Test: `brc100Handler.accountChange.test.ts`. |
| `src/wallet/bnt/wallet.ts` | `needAskedAt` and `needServedAt` gained one entry per peer and txid and never lost one, and `need` messages come from other wallets. | Each box pass drops entries past the 10-minute resend window, where they no longer do anything. |
| `src/wallet/appActivity.ts` | `projectedStaleIds` kept the id of every stale approval placeholder it had announced, after the row was gone. | Each expiry pass keeps only ids that are still stale placeholders. |
| `src/wallet/sendBrc29Payment.ts` | `hintPathSeen` kept one entry per incoming payment hint for the whole session. | Capped at 2,000 entries; past that it starts over, which at worst logs a hint's path again. |

## Checked and fine

- Component intervals (`Dashboard`, `InventoryPanel`, `WalletStatusPill`, `WhatIsBsvPanel`, `AnimatedQr`, `useChatThread`) all clear on unmount.
- `StatechartsPanel` re-renders every second on purpose: it shows the sync age in seconds, and it only runs while that panel is open.
- Wallet-side intervals (`deviceMesh`, `coinWallet`, `vaultAccountHolding`, `accountMove`, spend-priority heartbeats) are cleared by their stop functions or `finally` blocks.
- The propagation retry interval in `session.ts` is started once per app run behind `propagationRecoveryStarted`.
- The other grow-only maps are bounded by things a wallet holds few of: apps (`lastActionAnsweredAt`), accounts and identities (`watchdogReconciled`, `syncHealthByIdentity`, `lastReopenAt`, `bapIds`), BNT assets and their history (`named`, `deployCache`, `backedThrough`), sales (`unreceiptedProceedsFiled`), sign-in requests (`alerted`), and two constant coin lists (`ALL_COINS`).
- Caches keyed by outpoint or script (`parsedCustom`, `scriptFactsByOutpoint`, `DeferredImage`'s decoded set) have size caps.

## Open

- UI lag: no new lag source was found in code. Measuring it needs a support log from a session that felt slow, read for `[stall]` lines and the breadcrumb before each.
- Heap growth over a long session: compare `[memory]` lines from the same log across a few hours.
