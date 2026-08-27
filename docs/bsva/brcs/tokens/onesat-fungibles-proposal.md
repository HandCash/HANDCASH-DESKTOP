# Proposal: 1Sat fungibles (tip→origin tokens)

**Status:** Drafted as [BRC-175](https://github.com/bsv-blockchain/BRCs/pull/237); HandCash list/bind/send/ingest use face-value **`amt`** with payee + change conservation (legacy tips without `amt` count as 1).  
**Product branding:** **1Sat** (same series as collectables)

See normative text in the BRC. This note tracks HandCash intent.

## Pitch

Fungible 1Sat tokens = **1-sat tips that share one origin**. Token id = origin. Each tip carries face value **`amt`**. Balance = **Σ `amt`**. Transfers **spend tips and create new 1-sat tips** (payee + change), funded with ordinary BSV dust — same custody class as collectables, with [BRC-150](https://brc.dev/150) for tip→origin proof.

**Locked supply is optional:** origin MAY set `supply: locked` + `max` (total units). If omitted, the token still works — no local cap check, still tip→origin + `amt` conservation.

Why not BSV-21: less indexer-bound discovery/settlement; same tip-move path as 1Sat NFTs.

## Units and split/change

| Concept | Rule |
|---------|------|
| Carrier | Every tip is still `satoshis === 1`. Face value is **not** sat count. |
| `amt` | Positive integer units on the tip (inscription and/or remittance). |
| Balance | Sum of `amt` on bound tips held for that origin. |
| `supply` / `max` | **Optional.** When `supply: locked`, `max` is total units; genesis Σ `amt` SHOULD equal `max`. |
| Mint | MAY be **one tip** with large `amt`, or several tips. Locked mint: Σ genesis `amt` = `max`. |
| Send | Select tips covering the amount → spend them → emit new 1-sat tips (recipients + change) whose `amt` **conserves** parent total. |
| Multi-payee | One spend, N new tips (N dust sats + fees from BSV). Parent tip(s) consumed. |
| Conservation | Children Σ `amt` = spent parents Σ `amt`. No inflation. |

Example: hold one tip `amt: 1000`. Send 400 to Alice, 300 to Bob → three new tips `400` / `300` / `300` change; all bind via BRC-150 to the spent parent → origin.

## Autodetect (not “any 1-sat”)

1. List basket **`1sat-ft`**
2. Require `satoshis === 1`
3. Tags / origin claim (`1sat-ft`, `origin:…`)
4. **Bind** — genesis / mint-batch / BRC-150 / parent hop; reject unbound
5. Balance = Σ `amt` (missing `amt` ⇒ `1`)

Chain scan may surface 1-sat outs; **import into `1sat-ft` only after bind**. Peer remittance remains a first-class ingest path.

## Gap fill (non-objectionable)

| Gap | Approach |
|-----|----------|
| Supply policy | **Optional** origin `supply: locked` + `max`; omit = no cap |
| Face value | Per-tip `amt` |
| Split / change | Spend → new tips; conserve `amt`; fund dust from BSV |
| Mint siblings | Optional same-tx batch; then prefer BRC-150 |
| Open mint / extend | Not binding without future `auth` |
| Basket | `1sat-ft` only |
| Markets | Identity = origin; inventory = tip UTXOs; settlement = tip spends; overlays convenience only |

## Wallet

- List / bind / send / peer settle under `1sat-ft`
- Echo `supply`/`max` on remittance **only when origin defined them** (do not invent locked)
- Cap check only when locked + `max` present
- Balance = Σ `amt`; missing `amt` ⇒ 1
- Send: greedy cover → one `createAction` with payee (+ change) 1-sat tips + conservation
- **Combine tips** (details, when ≥2 tips): self-send all tips → 1 tip; confirm Prompt; no peer notify
- Mint Studio mints; wallet holds and transfers

## Scaling (honest)

Works for tickets, points, memberships, game currency, modest FT series. Large balances stay flat because **one UTXO can hold large `amt`**; transfer cost tracks **number of tips spent/created**, not unit count. Still not “billions as pure ordinal sat tracking without metadata” — units live in `amt` + provenance.
