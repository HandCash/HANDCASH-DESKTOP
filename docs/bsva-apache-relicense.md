# BSVA Apache-2.0 relicense — 12 November 2026

Status: technical record of a public upstream change, not legal clearance.

## What BSVA changed

- [bsv-blockchain/ts-stack 4760b26d](https://github.com/bsv-blockchain/ts-stack/commit/4760b26d) (2026-11-11, PR #1560): first-party TS Stack code moves from Open BSV License v6 to Apache-2.0; every package ships `LICENSE` and `NOTICE` (`ts-stack / Copyright 2020-2026 BSV Association`).
- [5226d0c7](https://github.com/bsv-blockchain/ts-stack/commit/5226d0c7) (PR #1564) adds `PATENTS`: BSV Association holds no patent rights and will not assert, nor have its IP licensors assert, any patent against use of the software or derivatives. No chain or field-of-use limit.
- `packages/sdk` and `packages/wallet/wallet-toolbox` on `main` declare `"license": "Apache-2.0"`.

## What it does not change

- **Published bytes.** No npm release carries Apache yet: `@bsv/sdk` 4.0.1 (2026-10-28), `@bsv/wallet-toolbox(-client)` 2.15.3 (2026-11-05) and `@bsv/message-box-client` 2.7.0 predate the relicense and ship `SEE LICENSE IN LICENSE.txt` (Open BSV v6). We install `@bsv/sdk` 2.8.11, `@bsv/verifast` 0.3.6 and `@bsv/webrtpay` 0.2.1 — all Open BSV v6.
- **Historical grants.** Upstream's own `THIRD_PARTY_NOTICES.md` after the relicense: "It does not replace, narrow, or relicense historical or third-party material… every prior grant remains scoped to its snapshot code, so no blanket retroactive relicensing authority is relied upon." The Wallet Toolbox pre-2026 source (snapshot `d215223a`, paths `packages/wallet/wallet-toolbox`, `wallet-toolbox-examples`) stays under Open BSV v4, which keeps the BSV-only condition.
- **Our engine.** `packages/wallet-engine` is a vendored Toolbox snapshot declaring `Open BSV License`. It holds that pre-2026 v4 material.
- **SDK test material.** `bitcoin-sv` node test material in the SDK stays `Open BSV License 5 AND MIT`.

## What this unblocks

| Component | Before | Now |
|---|---|---|
| `@bsv/sdk` | BSV-only (v6) | Apache-2.0 once we install a release published after 4760b26d |
| Message box client, Verifast, Webrtpay | BSV-only (v6) | Same, per their first Apache publish |
| Wallet Toolbox / `packages/wallet-engine` pre-2026 code | BSV-only (v4) | Unchanged: still needs a BSVA grant or replacement |
| Other-coin modules (`coins`, `ltc`, `btc`, `bch`, `doge`, `arcUsdc`, `swap`, `primitives`) | noble (MIT), SDK fenced off | Unchanged; the SDK fence lifts by itself when the installed SDK is Apache (`src/wallet/primitives/bsvBoundary.test.ts`) |

## Next steps

1. Move `@bsv/sdk` (and Verifast, Webrtpay, message box client) to their first Apache-published versions. 2.8.11 → 4.x is a major upgrade: plan it, test custody paths, then ship.
2. Narrow the unsent BSVA request (`docs/multicurrency-permission-request.md`) to the pre-2026 Wallet Toolbox v4 snapshot only, or rebase `packages/wallet-engine` onto post-relicense Toolbox code with the v4 portions removed.
3. Restore the missing v4 texts in `packages/wallet-engine/LICENSES/` byte-identical from snapshot `d215223a` (gate L2).
4. Counsel confirms before any public "multicurrency is licence-clear" claim; ownership (L5) is unchanged.
