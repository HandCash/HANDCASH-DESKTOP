# HandCash Desktop — fungible tokens (BRC-162 / BRC-163)

SSoT: [`src/wallet/token/`](../src/wallet/token/). **Pay balance excludes tokens** — they live in basket `bsv21`, listed under Collect → Tokens.

## Protocol

| Layer | Role |
|-------|------|
| **BRC-162** | Binary value lock on 1-sat tips (`<BSV21> id amount payload` + P2PKH) |
| **BRC-163** | Remittance JSON in `customInstructions` + basket `bsv21` tags |
| **BRC-176** | Subject Atomic BEEF for peer send and market listing proof |

Legacy JSON BSV-21 (`application/bsv-20`) is read-only. New token transactions use BRC-162.

## Module map

| Module | Responsibility |
|--------|----------------|
| `token/types.ts` | Types, BRC-163 CI builder/parser, aggregation |
| `token/decode162.ts` | BRC-162 encode/decode |
| `token/listTips.ts` | Raw tip listing from basket `bsv21` |
| `token/list.ts` | Collect cache, `listFungibles`, busy deferral |
| `token/sendPlan.ts` | Send planning, value locks, remittance |
| `token/send.ts` | createAction / sign / broadcast / peer notify |
| `token/sendEntry.ts` | UI entry `sendFungible` |
| `token/burn.ts` | 162 destroy burn |
| `token/prove176.ts` | BRC-176 prove / parent fill |
| `token/settle.ts` | P2P receive → `internalizeAction` |
| `token/issuer.ts` | BRC-100 deploy/mint enrich |
| `token/icons/*` | Local icon cache + BEEF resolve |
| `token/marketView.ts` | Attach market listing overlay to token rows |

## Ingress

1. **P2P settle** — `internalizePeerFungibleSettle` → basket `bsv21`. Every accepted tip is walked to its deploy with `prove()` (token-parent bodies filled from local/network raw tx; the toolbox does SPV on `internalizeAction`). An unprovable tip is refused with `lineage-unproven:<reason>` — a forged output naming a real token id never paints a balance. Display fields (`sym`, `dec`, `icon`) are inherited from the proven deploy, not from the sender's envelope.
2. **BRC-100** — connected apps via `createAction` / `internalizeAction`; issuer enrich in `token/issuer.ts`.
3. **Chain refresh** — does **not** import tokens from address scan (recovery via remittance / settle only). No public index (WhatsOnChain, Bitails, JungleBus, GorillaPool) returns an unspent BRC-162 tip by owner: the value prefix hides the P2PKH. A received token lives only in localState and the BRC-39 history replica.
4. **Recover from transaction** (`recoverFromTx.ts`, Settings → Recover from transaction) — the sender's txid: every 1-sat output locked to this wallet's address and proven unspent goes through `classifyLegacyUtxos` → `importBsv21Tokens` (lineage proven as on receive). This is the way back for a reinstall whose history backup never held the token. Wipe names that loss before it lets the user override an unsynced history gate.

**The list is a projection.** `listFungibles` reads every page of basket `bsv21` (both encodings, decoded from the script; a row storage lists without its lock takes the script from its transaction — the local body inline, the chain's body in the background, either only when it hashes to the txid — and the script is written back to storage; a row that still has no BRC-162 lock projects only as an outpoint already held, as remittance-only) and shows exactly those tips, plus tips first painted within `FUNGIBLE_SETTLE_GRACE_MS` that the basket has not listed yet. A read that fails, times out or comes back short publishes nothing; a read taken while any wallet region is busy defers and re-runs when the wallet is idle. Every tip the projection drops goes to the holdings reconcile (`holdingsReconcile.ts`), which asks the chain once per backoff step: proven spent closes it, proven unspent restores the row or re-claims the output from its transaction, and no answer keeps it. Nothing is dropped without being filed, and nothing is shown that the wallet does not hold.

## BRC-176 prove (`token/prove176.ts`)

- Decodes **both** encodings (BRC-161 JSON and BRC-162 binary; binary wins per output) so mixed lineages prove.
- Per-id conservation I ≥ O; `burn` counts toward O and contributes nothing as an input.
- Authority model (`deploy+auth` / `auth` / `mint` / amount 0) fails closed with a named reason.
- A parent this wallet already proved (the `tokenLineage` verdict map, via `provenTokenDeployOf`) is terminal: its body is decoded for conservation, its ancestry is never walked or fetched again. Held-tip heals and receives use it; send and listing fills still ship full ancestry, since the peer proves offline.
- Limits: `MAX_PROVE_DEPTH` (walk depth), `MAX_PACKET_TXS` (bodies per fill / ancestry), `PARENT_FILL_DEADLINE_MS`. Tripping a limit reads *unproven*, never counterfeit.
- Market listing (`buildBsv21ListingProof`) emits `v:176` **only** after a successful walk over a token-parent-complete BEEF; no BEEF or a failed walk is `ITEM_ORIGIN_UNPROVEN`.

## Send invariants (BRC-163)

- Every selected input's rest script is classified (`chooseBsv21BatchSendPath`) **before** `createAction`; cosigner / covenant / unknown locks refuse by name.
- A payee that resolves to this wallet (combine, self-send) keeps its output in basket `bsv21`; the card is repainted with every held output.
- `dec` travels from the card → remittance → Activity → peer envelope; it is never hard-coded.
- `issuerAttested` means the Sigma signer **is** the claimed issuer (address match); a Sigma block by anyone else does not attest a remittance claim.

## Features (v1)

- List + aggregate by deploy outpoint (`handcash.tokens.list.v1` cache)
- Send / receive / burn / combine
- Icons from local BEEF / B-protocol
- Market list/buy (`marketListing.ts` token branches)
- BRC-100 issuer mint/deploy enrich

## Out of scope

- Cosigned (MNEE-shaped) send — classified and refused
- Authority mint (amount=0 deploy) — refused unless issuer path requires later
- Address-scan token import

Payments (`sendPayment`, `sendBrc29Payment`) and 1sat collectables (`collectables.ts`) are unchanged.
