# Shared wallet release gate — 2026-11-07

## Decision and scope

Both devices must remain signed into the same vault. Every account must be viewable read-only on both; choosing an account must not transfer it. Ownership moves automatically only before an explicitly requested signing action. Viewing does not authorize signing, backup uploads, chain ingest into spendable storage, background transfers or a second spendable replica.

This replaces the prior selection-triggered move requirement, not the single-holder custody invariant. No real keys or accounts were moved in this review. No publication was requested or performed.

## Current evidence

Shared checkout inspected at `60b297ba`; pending pairing-chart/coin-palette edits and untracked verification/layout files belong to other work and were not edited. Other worktrees were listed, not cleaned or reset. Read-only coordination with the Settings and pairing workers found no active release owner; their answers are historical and are not stronger evidence than the files and Git history.

Desktop package, UI package and src/version agree on 1.3.666. Tag v1.3.666 points to `8cce7b5d008589c0ddc4221fc75de09d91e664cf`. Mobile is clean at `81a031a`, version 0.1.779, pinning that exact Desktop tag. GitHub release queries confirmed published prerelease assets for v1.3.666 (Linux, Mac and Windows) and an APK for v0.1.779. This proves publication, not installed versions or native behavior.

Current Desktop HEAD has newer Settings/preferences/layout/copy changes and the currency-flag/Balance-heading removal. Android's pin does not include those changes despite the matching version labels. The release checker now rejects a matching version with a different source commit; an already-pinned version cannot silently skip a different source. Do not retag 1.3.666 or overwrite existing artifacts.

## Exact one-wallet blocker

- `WalletAccountMenu.tsx` routes selection of a remotely held account to `runMove`, not read-only selection.
- `walletAccountMenuMachine.ts` models MOVE → moving → switching; DISPLACED switches away or creates an account when none is held locally. Its regressions explicitly enforce this older behavior.
- `session.ts: switchVaultAccount` refuses a remotely held account before building its signing Toolbox runtime. Removing this guard would give the non-holder a signing runtime and is not a read-only implementation.
- `spendAutoMove.ts` already coalesces foreground spend moves and merges arrival history before spending; `spendGuard.ts` retains holding/freshness checks. These are necessary but do not provide read-only viewing or establish coverage of every signing API.

A shipping implementation still needs an identity-scoped **display-only account projection**, separate from ActiveWallet/Toolbox spendable state. It must work for a newly paired device with no cached data and expose freshness/unavailable states, not invent a zero balance. Read-only history must not import into the non-holder's spendable storage or upload over the holder's backup. Dashboard Refresh remains chain ingest, not history synchronization.

Required chart path: choose account → load display projection → viewing (local or remote). A signing intent captures account identity and runtime generation → move through accountMoveMachine if needed → merge arrived history under recompose → recheck holding/current intent → enter serialized signing region. Reject/abandon stale intents after switch/lock; do not replay a signing callback captured against an old wallet. Background actions never move an account. Displacement revokes signing/monitor services and retains the display view instead of creating another account.

Audit all signing actions, not just payments: BRC-100 signing/certificates/authentication, native sends, items, markets, swaps, identity publishing and background acknowledgements. Existing release/forced-take policy remains unchanged; these checks do not prove strict concurrent-signing exclusion during a disconnected/offline forced take.

This is an implementation gate, not a phone-test-only gate. No unsafe guard removal or partial menu-only change was made.

## Checks and physical acceptance

At shared baseline: 11 focused files / 150 tests passed (scan-login, pairing chart, menu chart, spend auto-move/guard, move/release/handover, holding/freshness and Mobile release contract). Both renderer and Electron type checks passed. These tests validate existing behavior, including the conflicting selection behavior; they do not satisfy the new requirement. After the release-check change, all 5 release-contract tests and both type checks passed in the isolated worktree. Running the real read-only `--check` failed as intended: Mobile pins `8cce7b5d` while Desktop HEAD is `60b297ba`. No Mobile files were changed.

After the shared display/signing boundary is implemented, the phone operator must provide installed Desktop/Mobile versions and embedded core commit, and use a disposable test vault only:

1. Pair in both directions on LAN and separate networks. Success follows persisted receiver setup and a verified signed receipt; cancellation, failed persistence and wrong/expired codes cannot succeed.
2. With only one account, keep both sessions connected; view balance/history/items on either device without holder changes or extra accounts. Mark stale/unavailable read-only data clearly.
3. Request signing in each direction: observe move progress, arrival merge, then signing on the new holder only. View-only selection, cancelled review and background work must not move it. Test lock/switch during movement and two simultaneous signing requests.
4. Exercise live/idle/offline holder release and displaced history without duplicate broadcast or non-holder backup overwrite. Do not use production funds or move production keys for acceptance.
5. Verify Android install-over preserves the vault; provide header/Settings screenshots in both themes. No adb was available in this environment.

## Publishing approval

No new version/tag has been made. Proposed next numbers, subject to checking current tags again: Desktop 1.3.667 and Mobile 0.1.780. Do not publish them until the one-wallet implementation, focused tests/typechecks and physical acceptance pass. Before pushing, present exact final source SHA, included changes and targets for approval: Desktop Linux/Mac/Windows and Android APK. The Desktop tag triggers Mobile repinning, patch bump, commit/tag/push and APK workflow; approval must cover that cascade. Preserve all unrelated unkept work.
