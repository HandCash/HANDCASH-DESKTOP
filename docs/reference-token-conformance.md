# Reference token conformance failure

## Verified locally (2026-11-16)

The reference app's REF mint is not compact BNT. In BRC-CLOUD `src/walletDemoApp.js:668–686`, it writes a `bsv-20` `deploy+mint` inscription with `amt:1000`, in basket `bsv21`, with `bsv21` tags. The stopped run's transaction ID and full transcript are unavailable; this traces current source, not the actual chain output.

Desktop intentionally removed BRC-162 support in commit `c589ab712de74514bba92bff8f51964a53260ada`. `docs/bnt-tokens.md` states that BRC-162 is neither read nor listed. `src/wallet/bnt/wallet.ts:listBntAssets` reads only `bntft`, `bntnft`, `iptft`, and `iptnft`; `heldRows` checks scripts, holder keys and validated ancestry. Missing REF in compact BNT inventory is therefore expected for this reference mint, not evidence that its ownership was lost.

`src/wallet/marketListing.ts:loadListedOutput` reads the ordinal holding path, then reports `ITEM_NOT_HELD` when no output is found. `createMarketListingAdvert` previously ignored the caller's runtime `assetType`, despite its TypeScript ordinal-only union. The bridge casts JSON without enforcing that union. An unsupported `bsv21` request could consequently report a misleading ownership error and perform reservation cleanup before refusing.

## Local correction

Explicit non-ordinal listing requests now fail with `UNSUPPORTED_TOKEN_FORMAT` before acquiring the spend region or reading/altering reservations. Token outputs are not routed through the ordinal path, and no ownership, script or ancestry checks are relaxed. Four regression cases exercise untyped bridge input. A separate native REF fixture issues 1,000 units, checks its deploy row and inventory balance, transfers to another simulated install, and verifies the sender row is spent and the recipient holds 1,000. A legacy `bsv21` row is neither credited nor spent.

Verification: job `j89` passed 9 files / 105 tests and `tsc --noEmit`, then job `j95` passed the final changed suites (41 tests, including the new REF fixture), `tsc --noEmit` and `git diff --check`. Lints clean for all three changed TypeScript files. These are offline fixtures, not live conformance or UI/device evidence.

## Preserved work and remaining scope

The stopped chat's changes remain in worktree `cmwj2bpb97` (including `docs/bnt-conformance-audit.md`); none are copied, overwritten or claimed verified here. Activity isolation is present in this worktree's base commit `6a2d08e9`; recompose and other chats' unkept work are untouched.

IPT task `e6a139e8-832a-4e55-a361-ce0e7beefc08` retains ownership of countersign acceptance, beacon/release and claim work. Its recorded evidence explicitly leaves these incomplete. This patch does not implement or certify them. Compact BNT market trading and direct offers are also separate missing functionality; replacing the reference inscription mint alone will not make token trading pass.

BRC-CLOUD task `2d5605b5-cbc2-48c1-beea-e227c4f4a455` separately stages the reference label/listing correction. Its changes are not included here. Before live rerun: keep those corrections, use wallet-native `issueBntAsset` for a compact BNT scenario, capture wallet version and request/response plus transaction/output IDs, then verify inventory and holder attribution. Steps 11–13 of the old run remain unverified. No repair, mainnet transaction, commit, push, deployment or install was performed here.
