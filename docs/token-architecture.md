# HandCash Desktop — fungible tokens (BRC-162 / BRC-163)

SSoT: [`src/wallet/token/`](../src/wallet/token/). **Pay balance excludes tokens** — they live in basket `bsv21`, listed under Collect → Tokens.

## Protocol

| Layer | Role |
|-------|------|
| **BRC-162** | Binary value lock on 1-sat tips (`<BSV21> id amount payload` + P2PKH) |
| **BRC-163** | Remittance JSON in `customInstructions` + basket `bsv21` tags |
| **BRC-176** | Subject Atomic BEEF for peer send and market listing proof |

Legacy JSON BSV-21 (`application/bsv-20`) and basket `1sat-ft` are **not** product paths for new sends. Inbound 1sat-ft-shaped tips are detected only so they never appear as collectables or tokens.

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
| `token/guards.ts` | Deprecated 1sat-ft detection (NFT grid safety only) |

Deprecated shim files at `src/wallet/bsv21*.ts`, `fungibles.ts`, `colour*.ts`, etc. re-export from `token/` for backward compatibility.

## Ingress

1. **P2P settle** — `internalizePeerFungibleSettle` / `internalizePeerColourSettle` → basket `bsv21`.
2. **BRC-100** — connected apps via `createAction` / `internalizeAction`; issuer enrich in `token/issuer.ts`.
3. **Chain refresh** — does **not** import tokens from address scan (recovery via remittance / settle only).

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
