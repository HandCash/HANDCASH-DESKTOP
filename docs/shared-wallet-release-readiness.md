# Shared wallet release gate — 2026-11-07

## Decision and scope

Both devices must remain signed into the same vault. Every account must be viewable read-only on both; choosing an account must not transfer it. Ownership moves automatically only before an explicitly requested signing action. Viewing does not authorize signing, backup uploads, chain ingest into spendable storage, background transfers or a second spendable replica.

This replaces the prior selection-triggered move requirement, not the single-holder custody invariant. No real keys or accounts were moved. The user has authorized Desktop and Mobile shipping after the required checks pass, with exact versions and targets presented at the tool approval gates. No new version, tag, push, publication or deployment has been made; the implementation gate below has not passed.

## Current evidence

Shared checkout inspected at `60b297ba`; pending pairing-chart/coin-palette edits and untracked verification/layout files belong to other work and were not edited. Other worktrees were listed, not cleaned or reset. Read-only coordination with the Settings and pairing workers found no active release owner; their answers are historical and are not stronger evidence than the files and Git history.

Desktop package, UI package and src/version agree on 1.3.666. Tag v1.3.666 points to `8cce7b5d008589c0ddc4221fc75de09d91e664cf`. Mobile is clean at `81a031a`, version 0.1.779, pinning that exact Desktop tag. GitHub release queries confirmed published prerelease assets for v1.3.666 (Linux, Mac and Windows) and an APK for v0.1.779. This proves publication, not installed versions or native behavior.

Current Desktop HEAD has newer Settings/preferences/layout/copy changes and the currency-flag/Balance-heading removal. Android's pin does not include those changes despite the matching version labels. The release checker now rejects a matching version with a different source commit; an already-pinned version cannot silently skip a different source. Do not retag 1.3.666 or overwrite existing artifacts.

## Implementation in this worktree (not shipped)

- Remote account selection now enters a chart-owned `viewing` state. It displays only that identity/chain's cached balance, original read timestamp and public identity; an absent cache is unavailable, never a fabricated zero. It does not call `moveAccountHere`, open a Toolbox, switch the foreground runtime, publish or create an account. It is a menu preview, **not the complete read-only wallet screen**. Foreground displacement is deferred and rechecked on close, not silently discarded.
- `spendGuard.ts` rejects a captured signing callback if the runtime changed while a move was pending. `spendAutoMove.ts` validates the requested identity/index before movement, fences arrival merging before/after awaited work and scopes coalescing to the identity, account index and runtime generation. Reopening the same identity cannot inherit a disposed signer's move; an invalid index cannot bypass validation by joining a valid move. Regressions use fake custody operations; no real accounts moved.
- Shared `signingIntent.ts` captures one account/runtime before an action waits. Native BTC/BCH/LTC/DOGE sends and swap funding now use that captured account for movement, reject replacement while queued, and recheck current runtime/holding immediately before synchronous signing after network input/fee reads. Tests drive the real runtime lifecycle and fake coin sources, including signer spies proving no signature after replacement or release. This does not yet fence Arc USDC, all other signing methods, or signed native-coin persistence/notification across a later account switch. Signed propagation is not newly aborted by these guards.
- `session.ts: switchVaultAccount` still refuses a remotely held account before building its signing Toolbox runtime. This guard is intact; removing it would create a second signing/spendable runtime rather than read-only access.

## Remaining one-wallet implementation gate

`prepareAddedDevice`/`resolveBootAccount` still allocate an extra account when none is held locally. DISPLACED still switches away or creates another account outside the preview. Full read-only balance/history/items for a newly paired device and signing intents originating from that read-only screen are not implemented. Non-payment signing methods and coin-specific asynchronous send paths still need the common account/runtime fence; existing payment tests alone do not prove their coverage.

A shipping implementation still needs an identity-scoped **display-only account projection**, separate from ActiveWallet/Toolbox spendable state. It must work for a newly paired device with no cached data and expose freshness/unavailable states, not invent a zero balance. Read-only history must not import into the non-holder's spendable storage or upload over the holder's backup. Dashboard Refresh remains chain ingest, not history synchronization.

Required chart path: choose account → load display projection → viewing (local or remote). A signing intent captures account identity and runtime generation → move through accountMoveMachine if needed → merge arrived history under recompose → recheck holding/current intent → enter serialized signing region. Reject/abandon stale intents after switch/lock; do not replay a signing callback captured against an old wallet. Background actions never move an account. Displacement revokes signing/monitor services and retains the display view instead of creating another account.

Audit all signing actions, not just payments: BRC-100 signing/certificates/authentication, native sends, items, markets, swaps, identity publishing and background acknowledgements. Existing release/forced-take policy remains unchanged; these checks do not prove strict concurrent-signing exclusion during a disconnected/offline forced take.

This is an implementation gate, not a phone-test-only gate. The staged menu preview and runtime guards are safe partial work, not fulfillment of the full requirement. Mobile has not been repinned to incomplete or uncommitted shared code.

### Ownership policy decision still needed

The existing protocol allows spending from local holding when the host is unreachable, and forces takeover after a holder does not answer. A disconnected old holder can therefore still believe it owns the account when the new device takes it. These rules cannot prove strict concurrent-signing exclusion. The user has been asked whether uncertain ownership should instead fail closed. No response has been received, and existing offline/forced-take behavior has not been changed. A policy answer alone is not a completed safety implementation: the common signing boundary and an enforceable handoff/fencing protocol must still be implemented and verified before release.

## Checks and physical acceptance

At shared baseline: 11 focused files / 150 tests passed (scan-login, pairing chart, menu chart, spend auto-move/guard, move/release/handover, holding/freshness and Mobile release contract). Both renderer and Electron type checks passed. These tests validate existing behavior, including the conflicting selection behavior; they do not satisfy the new requirement. After the release-check change, all 5 release-contract tests and both type checks passed in the isolated worktree. Running the real read-only `--check` failed as intended: Mobile pins `8cce7b5d` while Desktop HEAD is `60b297ba`. No Mobile files were changed.

After the shared display/signing boundary is implemented, the phone operator must provide installed Desktop/Mobile versions and embedded core commit, and use a disposable test vault only:

1. Pair in both directions on LAN and separate networks. Success follows persisted receiver setup and a verified signed receipt; cancellation, failed persistence and wrong/expired codes cannot succeed.
2. With only one account, keep both sessions connected; view balance/history/items on either device without holder changes or extra accounts. Mark stale/unavailable read-only data clearly.
3. Request signing in each direction: observe move progress, arrival merge, then signing on the new holder only. View-only selection, cancelled review and background work must not move it. Test lock/switch during movement and two simultaneous signing requests.
4. Exercise live/idle/offline holder release and displaced history without duplicate broadcast or non-holder backup overwrite. Do not use production funds or move production keys for acceptance.
5. Verify Android install-over preserves the vault; provide header/Settings screenshots in both themes. No adb was available in this environment.

## Recovery verification — 2026-11-07

Recovered source is `bddd222e`, not the fixes-only release candidate `0f95dd42`. The later commit contains incomplete read-only menu and signing-guard changes; do not tag HEAD as the approved fixes-only release. Preserve those changes separately and release from the reviewed fixes-only source.

Fresh isolated verification: 10 focused files / 119 tests passed, including signed pairing receipts, menu viewing, spend movement/guards, signing intents, Settings preferences, phone tilt, Mobile release contract and Aeon adherence. Renderer and Electron type checks passed. Settings row browser fixtures passed at 320, 360 and 430px with no sideways overflow. This is not a running native-app or physical-device acceptance check. Shared unkept tests and untracked verification files were not copied or changed.

GitHub queries still find no `v1.3.667` or `v0.1.780` tag/release. Published Desktop `v1.3.666` includes Linux, Mac and Windows assets; Mobile `v0.1.779` includes its APK, checksum and core-pin artifact. Latest listed CI run `42387231127` failed on the machine catalog count (57 versus expected 56); the current candidate already contains the catalog fix from `bc32ebfe`; its three focused tests passed in this recovery pass. Linux run `42379661998` and Windows run `42379661569` succeeded for the prior release, not the unpublished candidate.

Publication remains gated by the missing 1.3.667 changelog entry, mandatory Jev UI review and clean fixes-only source. No Jev credential is available in the command process; the review script falls back to reading environment files, so it was not run. Alignity read_file/edit_file reported CHANGELOG.md missing despite the terminal confirming it exists; the attempted passage edit changed nothing. Do not bypass the edit tool or secret-file restriction. No commits, tags, pushes, artifacts or real-account changes were made in this recovery pass.

The offline ownership policy question remains open: local offline signing plus forced takeover cannot guarantee exclusive signing. Full read-only projection and a common signing fence are still implementation work, not merely device testing.

## Latest verification and release handoff

Job `jb2` completed: 18 focused files / 198 tests passed, followed by renderer and Electron type checks and `git diff --check`. The final Mobile release check failed: Mobile pins `8cce7b5d008589c0ddc4221fc75de09d91e664cf`, while this worktree's Desktop HEAD is `348f4710f9972b00baa8838cd63097d9f7c3b12c`. This is a source-alignment failure, not a test failure. No job remains running from this verification. All feature edits remain unkept; no Mobile source or real account was changed.

Release worker `cmw6mx41jk` reports the user's later instruction: “Publish HandCash Desktop and Mobile with the current verified fixes, deferring unfinished two-device read-only behavior.” The committed release-scope insight at `0f95dd42` agrees: current UI/CI fixes and 20× subtler phone tilt only; exclude this worktree's incomplete preview/signing guards. This supersedes the feature-completion condition for that separate fixes-only release, not the unfinished feature's safety requirements above.

Fresh read-only inspection found shared master and the release worktree at `0f95dd42`, with Desktop/package UI/src version 1.3.667. Its changes since this worktree's baseline are version bumps, phone-tilt regression/fix, machine-manifest test maintenance and release-scope memory. Its CHANGELOG still starts at 1.3.666. Mobile remains clean at `81a031a`, version 0.1.779, with the old source pin. Remote tag queries found neither `v1.3.667` nor `v0.1.780`. This verifies preparation, not publication. The release worker reports 118 focused tests and both type checks passing; those are cross-chat evidence, not checks rerun here against its release source.

The release worker's last reported gates are its pending changelog-edit approval and a Jev key in Settings for required UI review. Do not read environment files or bypass that credential/review gate. Finish the fixes-only changelog and review in the release worktree, verify its final source and tests, then present exact versions, source SHA, included changes and affected Desktop Linux/Mac/Windows plus Android targets at the required publishing approvals. The Desktop tag triggers Mobile repinning, patch bump, commit/tag/push and APK workflow; approval must cover that cascade. No push, tag, publication or deployment was performed by this chat. Physical-device acceptance remains unperformed; do not claim either release proves the deferred two-device behavior.
