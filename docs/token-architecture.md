# HandCash Desktop — fungible tokens (P2P-FT: BRC-162 / BRC-163 / BRC-251 / BRC-252)

SSoT: [`src/wallet/token/`](../src/wallet/token/). **Pay balance excludes tokens** — they live in basket `p2pft`, listed under Collect → Tokens. Outputs filed under the old `bsv21` basket stay readable and move into `p2pft` once (`token/filingStore.ts`). Apps read through `p p2pft all|token|id`; `p bsv21 …` stays valid for grants already issued.

## Protocol

| Layer | Role |
|-------|------|
| **BRC-162** | Binary value lock on 1-sat tips (`<id\|OP_0> <amount> OP_2DROP [<payload> OP_DROP]` + P2PKH) |
| **BRC-163** | Remittance JSON in `customInstructions` + filing tags (`p2pft`, `p2pft:<tokenId>`; `bsv21:<tokenId>` still read) |
| **BRC-176** | Subject Atomic BEEF for peer send and market listing proof |
| **BRC-251** | P2P-FT: hold, send and receive BRC-162 tokens peer to peer over a BRC-33 box; `p p2pft` view scopes ([PR #320](https://github.com/bsv-blockchain/BRCs/pull/320), open) |
| **BRC-252** | Compact lineage evidence: a send ships only the bodies past the recipient's proven frontier; no compressed proof format is registered ([PR #321](https://github.com/bsv-blockchain/BRCs/pull/321), open) |

Legacy JSON BSV-21 (`application/bsv-20`) is read-only. New token transactions use BRC-162.

## Two binary layouts

| Layout | Script | Written |
|--------|--------|---------|
| `brc162` (current, merged BRC-162) | `<id\|OP_0> <amount> OP_2DROP [<payload> OP_DROP] <rest>` — id 32 bytes when the deploy is output 0, else 36 (a 36-byte id naming vout 0 is invalid); payload is strict DAG-CBOR, `icon` is `[mediaType, bytes]` | every new deploy, and every spend of a token born in it |
| `draft-tagged` (pre-#273 drafts) | `<"BSV21"> <36-byte id\|OP_0> OP_2DROP <amount> <payload\|OP_0> OP_2DROP <rest>` — `icon` is a 4- or 36-byte pointer | only spends of tokens already held in it; never a new deploy |

- A token stays in the layout it was born in. `planBsv21Send` groups tips by layout and never mixes them in one spend; `bsv21SpendLayout` derives a burn / listing / settlement layout from the tips it spends.
- `prove()` takes the walk's layout from the tip. A binary output of the other layout is not a token in that walk; JSON (BRC-161) outputs belong to both. A current-layout deploy at a nonzero output is invalid.
- The payload never affects validity. A deploy whose `req` is not an empty array or map is unsupported (BRC-251): no balance, no send, receive refused as `unsupported-token:required-processing` (`token/requiredProcessing.ts`).
- Issuance (`token/issuer.ts` → `planBsv21MintWire`) refuses a binary deploy that is not output 0, re-expresses a JSON or draft-tagged genesis in the current layout, and resolves the icon reference to bytes so it can be embedded.

## Module map

| Module | Responsibility |
|--------|----------------|
| `token/types.ts` | Types, BRC-163 CI builder/parser, aggregation |
| `token/decode162.ts` | BRC-162 encode/decode, both layouts (Mint Studio keeps a copy in `src/lib/bsv21Binary.ts`) |
| `token/mintWire.ts` | Issuance wire decision: keep / upgrade / refuse a genesis |
| `token/requiredProcessing.ts` | Tokens whose deploy names required processing (unsupported) |
| `token/filing.ts` / `token/filingStore.ts` | Filing names (`p2pft`, legacy `bsv21`) and the one-time move into `p2pft` |
| `token/listTips.ts` | Raw tip listing from the filing baskets |
| `token/list.ts` | Collect cache, `listFungibles`, busy deferral |
| `token/sendPlan.ts` | Send planning, value locks, remittance |
| `token/send.ts` | createAction / sign / broadcast / peer notify |
| `token/sendEntry.ts` | UI entry `sendFungible` |
| `token/burn.ts` | 162 destroy burn |
| `token/prove176.ts` | BRC-176 prove / parent fill, BRC-252 frontier (bodies a recipient still needs) |
| `token/settle.ts` | P2P receive → `internalizeAction` |
| `token/issuer.ts` | BRC-100 deploy/mint enrich |
| `token/icons/*` | Local icon cache + BEEF resolve |
| `token/marketView.ts` | Attach market listing overlay to token rows |

## Ingress

1. **P2P settle** — `internalizePeerFungibleSettle` → basket `p2pft`. Every accepted tip is walked to its deploy with `prove()` and its token spends script-checked (token-parent bodies filled from local/network raw tx; the toolbox does SPV on `internalizeAction`). An unprovable tip is refused with `lineage-unproven:<reason>` — a forged output naming a real token id never paints a balance. Display fields (`sym`, `dec`, `icon`) are inherited from the proven deploy, not from the sender's envelope.
2. **BRC-100** — connected apps via `createAction` / `internalizeAction`; issuer enrich in `token/issuer.ts`.
3. **Chain refresh** — does **not** import tokens from address scan (recovery via remittance / settle only). No public index (WhatsOnChain, Bitails, JungleBus, GorillaPool) returns an unspent BRC-162 tip by owner: the value prefix hides the P2PKH. A received token lives only in localState and the BRC-39 history replica.
4. **Recover from transaction** (`recoverFromTx.ts`, Settings → Recover from transaction) — the sender's txid: every 1-sat output locked to this wallet's address and proven unspent goes through `classifyLegacyUtxos` → `importBsv21Tokens` (lineage proven as on receive). This is the way back for a reinstall whose history backup never held the token. Wipe names that loss before it lets the user override an unsynced history gate.

**The list is a projection.** `listFungibles` reads every page of the filing baskets (both encodings, decoded from the script; a row storage lists without its lock takes the script from its transaction — the local body inline, the chain's body in the background, either only when it hashes to the txid — and the script is written back to storage; a row that still has no BRC-162 lock projects only as an outpoint already held, as remittance-only) and shows exactly those tips, plus tips first painted within `FUNGIBLE_SETTLE_GRACE_MS` that the basket has not listed yet. A read that fails, times out or comes back short publishes nothing; a read taken while any wallet region is busy defers and re-runs when the wallet is idle. Every tip the projection drops goes to the holdings reconcile (`holdingsReconcile.ts`), which asks the chain once per backoff step: proven spent closes it, proven unspent restores the row or re-claims the output from its transaction, and no answer keeps it. Nothing is dropped without being filed, and nothing is shown that the wallet does not hold.

## BRC-176 prove (`token/prove176.ts`)

- Decodes **both** encodings (BRC-161 JSON and BRC-162 binary; binary wins per output) so mixed lineages prove. Binary outputs count only in the tip's layout.
- Per-id conservation I ≥ O; `burn` counts toward O and contributes nothing as an input.
- Authority model (`deploy+auth` / `auth` / `mint` / amount 0) fails closed with a named reason.
- A parent this wallet already proved (the `tokenLineage` verdict map, via `provenTokenDeployOf`) is terminal: its body is decoded for conservation, its ancestry is never walked or fetched again. Held-tip heals and receives use it; send and listing fills still ship full ancestry, since the peer proves offline.
- Limits: `MAX_PROVE_DEPTH` (walk depth), `MAX_PACKET_TXS` (bodies per fill / ancestry), `PARENT_FILL_DEADLINE_MS`. Tripping a limit reads *unproven*, never counterfeit.
- `prove()` is token rules only. `verifyTokenSpendScripts` runs each token input on the walk against the spent output's locking script (consensus flags, not relay policy); a recorded verdict is the last spend checked on its branch. A BUMP in a lineage is not verified by the walk, so mined hops are checked too. Receive, import and the held-tip heal use `proveWithScripts`; a forged spend refuses as `lineage-unproven:token input N of <txid> fails its locking script`. Funding inputs are not judged.
- **Balance = bound tips.** A tip is bound when it is the deploy or a walk filed it in the verdict map. `withLineageCheck` (applied on every list publish) puts the rest in `FungibleToken.checkingAmt`; `spendableFungibleAmt` is what Collect, details and Send max show, with `+N checking` beside it. The heal pass walks every unbound tip (`LINEAGE_PROOFS_PER_PASS`), and send prefers bound tips; the pre-sign walk decides either way. Burn still sees every held unit (cleanup never claims value).
- **Names in the UI.** Current-layout tokens show as **P2P-FT** (BRC-251), draft-tagged ones as **P2P-FT (old format)** (`FungibleToken.layout`), BRC-161 JSON as **BSV-21 JSON (legacy)**. The storage basket is `p2pft`; `bsv21` (reserved by BRC-163) is only read and moved, never shown as a format.
- Each receive logs `[fungible-settle] <txid> proof done <N>ms — beef <N>B lineage <N>B walked <N> tx scripts <N>`; triage reads it as `tokenProofs`.
- Market listing (`buildBsv21ListingProof`) emits `v:176` **only** after a successful walk over a token-parent-complete BEEF; no BEEF or a failed walk is `ITEM_ORIGIN_UNPROVEN`.

## Send invariants (BRC-163)

- Every selected input's rest script is classified (`chooseBsv21BatchSendPath`) **before** `createAction`; cosigner / covenant / unknown locks refuse by name.
- A payee that resolves to this wallet (combine, self-send) keeps its output in basket `p2pft`; the card is repainted with every held output.
- Value outputs lock to fresh BRC-29 children (`planTokenOutputs` in `token/tipKeys.ts`, keys in `brc29Keys.ts`), which any BRC-100 wallet reaches through `getPublicKey` / `createSignature`; nothing new locks to an identity address: the payee's child when it has an identity to deliver to, this wallet's own for change. The remittance strings sit in each kept output's `customInstructions`, and the delivery carries the payee's in `meta.asset.remittance`. A derived output cannot be found by an address scan; remittance is custody.
- `dec` travels from the card → remittance → Activity → peer envelope; it is never hard-coded.
- `issuerAttested` means the Sigma signer **is** the claimed issuer (address match); a Sigma block by anyone else does not attest a remittance claim.

## Features (v1)

- List + aggregate by deploy outpoint (`handcash.tokens.list.v1` cache)
- Send / receive / burn / combine
- Icons embedded in the deploy (current layout), or from local BEEF / B-protocol (draft pointers, JSON)
- Market list/buy (`marketListing.ts` token branches)
- BRC-100 issuer mint/deploy enrich

## Out of scope

- Cosigned (MNEE-shaped) send — classified and refused
- Authority mint (amount=0 deploy) — refused unless issuer path requires later
- Address-scan token import

Payments (`sendPayment`, `sendBrc29Payment`) and 1sat collectables (`collectables.ts`) are unchanged.
