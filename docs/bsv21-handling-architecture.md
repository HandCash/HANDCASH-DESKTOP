# HandCash Desktop — BSV-21 / fungible token handling

SSoT: `src/wallet/layers.ts` (lines 87–99). **Pay balance excludes tokens** — they live in basket `bsv21`, listed under Collect.

## Two generations (intentional split)

| Generation | On-chain | Basket | Send | Burn |
|------------|----------|--------|------|------|
| **Native (current)** | BRC-162 binary lock + BRC-176 subject BEEF | `bsv21` | Yes | Yes |
| **Legacy** | BRC-161 JSON (`application/bsv-20`) | `bsv21` if already internalized | **Retired** | Yes (JSON inscribe) |
| **1sat-ft leftovers** | `application/1sat-ft+json` | was `1sat-ft` | No | No |

**Why it looks broken:** Desktop deliberately **does not** re-import BSV-21 from address scan. Custody ingress is P2P settle / BRC-100 internalize only. Legacy rows are **burn-only** by product decision, not accident.

## Ingress (how tokens enter localState)

### Primary — P2P / messagebox settle
1. Peer sends Atomic BEEF + remittance on `sendMessage`.
2. **`ingestFungibleSettle.ts`** — legacy JSON asset `{ kind: 'fungible', tokenId, amount, sym, dec }`.
3. **`ingestColourSettle.ts`** — BRC-162 / `1sat-ft` wire with 162 decode.
4. Both → `internalizeAction` into basket **`bsv21`** (toolbox IndexedDB).

### Chain Refresh — explicitly skips BSV-21 import
- `ingestLegacyAddress.ts` classifies BSV-21 via `oneSatImport.classifyLegacyUtxos` + `tokenAddressScan`.
- Logs **"skipped N BSV-21 tip(s) — use remittance / settle"** and drops them.
- **`importBsv21Tokens()` in `fungibles.ts` exists but has zero production callers** — dead path.

### BRC-100 bridge
- Apps call `createAction` / `internalizeAction` with basket `bsv21`.
- **`bsv21Issuer.ts`** enriches deploy/mint/auth ops; Sigma binds deploy to vin 0.
- Mint UI is **app-driven only** (no first-party mint panel in Desktop).

## Listing & balance

```
listFungibles() → listBsv21BinaryTips() → decodeBsv21Binary (amt per tip)
  → aggregateFungibles() → durable cache (handcash.fungibles.list.v1)
```

- **`colourListing.ts`** — lists only tips with decodable BRC-162; sets `colourSupply` flag.
- **`SendFungiblePanel`** blocks send unless `colourSupply` + plain lock kind.
- Legacy JSON in basket: visible, **Send hidden** (no 162 lock to spend).
- When wallet busy (`chainIngest` or `spend` active): returns **cached** list; logs `[bsv21] deferring listOutputs`.

## Send path (native BRC-162 only)

```
SendFungiblePanel → sendFungible() → sendColourCoins()
  → createAction (bsv21 basket) → signColourTipTransfer
  → buildBsv21SubjectBeef (BRC-176 prove) → notifyPeer / broadcastAtomicBeef
  → paintFungibleAfterSpend
```

Machines: **`bsv21SendMachine.ts`**, **`bsv21TipKind.ts`** (`chooseBsv21SendPath`).

**Refuses:** legacy JSON tips, cosigned (MNEE-shaped) tips, mixed batches, unknown locks.

## Burn path

- **`colourSupply` set** → `burnColourCoins.ts` (162 destroy + optional change).
- **Legacy JSON** → `burn.ts` + `bsv21Inscribe.ts` (BRC-161 inscribe burn).
- Router: `burnBsv21()` in `burn.ts`; chart: **`burnMachine.ts`**.

## Market (BRC-48)

- **`marketListing.ts`** — 162-only listing proof via `buildBsv21ListingProof`.
- **`marketInventory.ts`** — cached `bsv21` basket for items-market reads; defers when busy.

## Known gaps (for Satoshi review)

### Not implemented (explicit refuse)
1. **Cosigned send/burn** — `bsv21TipKind` classifies cosigned tips; **`bsv21SendMachine` always refuses** `path: 'cosigned'`. No cosigner HTTP client wired despite endpoint parsing.
2. **Authority mint** — `bsv21Prove.ts` fails with *"authority mint paths are not implemented"* (162 outputs with amount 0).

### Unwired (looks broken, is incomplete)
3. **Address-scan recovery disabled** — on-chain legacy BSV-21 never imported unless already in basket or received via P2P. Recovery = peer resend or BRC-100 app internalize.

### Design choices (not bugs)
5. **Legacy send retired** — JSON inscription send removed; burn-only for old rows.
6. **1sat-ft basket deprecated** — tokens are BRC-162 / `bsv21` only; inbound `1sat-ft` settle accepted only if 162-decodable.
7. **No global supply-cap proofs** — issuers trusted for mint policy (`bsv21.ts` header).
8. **Sigma verify is address-match only** — full vin binding marked `verified: false` in issuer path.

### Edge cases
9. **Incomplete inputBEEF during mint** — `bsv21Issuer.ts` warns; identity mint can fail if genesis unmined.
10. **Batch cosign path unused** — `chooseBsv21BatchSendPath()` exists; imperative send relies on tip filtering only.

## Module index

| Concern | Module |
|---------|--------|
| Types / aggregate | `bsv21.ts`, `bsv21Binary.ts` |
| List | `fungibles.ts`, `colourListing.ts` |
| Send | `sendFungible.ts`, `sendColourCoins.ts`, `bsv21Send.ts` |
| Mint (bridge) | `bsv21Issuer.ts`, `brc100Handler.ts` |
| Burn | `burn.ts`, `burnColourCoins.ts`, `burnPlan.ts` |
| Ingest | `ingestFungibleSettle.ts`, `ingestColourSettle.ts` |
| Misfile heal | `healMisfiledBsv21.ts` (runs after Refresh) |
| Prove | `bsv21Prove.ts` |

## Recommended fixes (priority)

1. ~~Wire **`healMisfiledBsv21()`** into `chainIngest.ts`~~ — done (post-Refresh beside collectables heal).
2. Either implement cosigned client + machine edge, or hide cosigned tips from UI entirely.
3. Document recovery path for scan-only legacy tips (manual internalize vs intentional P2P-only).
