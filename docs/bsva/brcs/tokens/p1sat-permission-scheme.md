# P1Sat permission scheme (HandCash) — derived from BRCs PR #200

Brandon Cryderman / HandCash (brandongcryderman@gmail.com)

**Status:** Draft BRC — [bsv-blockchain/BRCs#221](https://github.com/bsv-blockchain/BRCs/pull/221) (`tokens/0165.md`, scheme registry in BRC-123).  
**Implements today:** HandCash Desktop / Mobile (`itemAccess.ts`, `listOutputs` under `p 1sat …`).  
**App-facing contract:** [`p1sat-listoutputs-guide.md`](./p1sat-listoutputs-guide.md).

---

## Source material

This document is **derived from** the 1Sat series filed in:

- **[bsv-blockchain/BRCs#200](https://github.com/bsv-blockchain/BRCs/pull/200)** — *Add BRC-300–307: the 1Sat Ordinals series* (author: David Case / b-open-io; closed without merge)
  - Especially draft **BRC-302** (*1Sat Assets in BRC-100 Wallets — P1Sat Scheme*) and draft **BRC-303** (*1Sat Collectables in BRC-100 Wallets*)
  - Related drafts in that PR: 300 (core), 301 (inscriptions), 304 (collections), 305/306 (BSV-21), 307 (Sigma)

HandCash’s earlier review comment and merge-shape ask:

- [`PR-200-RESPONSE.md`](./PR-200-RESPONSE.md)

Published companions this scheme must not break:

- [BRC-147](./0147.md) — storage basket profile `1sat`
- [BRC-150](./0150.md) — provenance remittance scoped to basket `1sat`
- [BRC-164](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0164.md) — `id:` held-output list key (ordinary tag; optional for interop)

Framework this scheme sits under:

- [BRC-98](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0098.md) / [BRC-99](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0099.md) — `p ` protocols / baskets  
- [BRC-123](https://github.com/bsv-blockchain/BRCs/blob/master/wallet/0123.md) — scheme registry / governance

**Credit.** P1Sat as a named BRC-100 scheme id `1sat`, the motivation for scheme-mediated item access, action classification from transaction shape, and much of the surrounding 1Sat documentation map come from PR #200. HandCash keeps that map and changes the **wallet filing / permission layering** as below.

---

## What we keep from PR #200

| From the series | HandCash position |
|-----------------|-------------------|
| Scheme id **`1sat`** | Keep |
| BRC-98 protocol name **`p 1sat`** | Keep |
| Need for richer than plain-basket grant/deny | Keep |
| Classify mint / transfer / burn / list / … from **tx shape**, not a caller verb | Keep (wallet policy) |
| Display tags are **claims**; authenticity is separate (BRC-150) | Keep |
| Core / envelopes / collections / BSV-21 / Sigma docs (300–301, 304–307) | Keep as documentation direction; numbering is placeholder |
| Optional `id:` tracking for rows / prompts | Keep as **optional** interop (see BRC-164); not a gate for prove / internalize / list |

---

## Our changes (delta from draft 302 / 303)

### 1. Storage and permissions are different layers

**PR #200 (302/303):** baskets look like `p 1sat <class>` and that string is both the permission gate **and** the on-disk inventory name (e.g. collectables → `p 1sat ordinals`). BRC-147 is marked superseded; BRC-150 is retargeted to `p 1sat ordinals`.

**HandCash:**

| Layer | Law |
|-------|-----|
| **Storage basket** | `1sat` (BRC-147) |
| **Permissions** | `p 1sat <scope>` |
| **Scheme id** | `1sat` under `p 1sat` |

Normative behavior:

1. Conforming wallets **file** collectables in storage basket **`1sat`**.
2. Apps **request** access with plain `1sat` or `p 1sat <scope>`.
3. Wallets **normalize** inbound `p 1sat …` onto storage `1sat` and apply `<scope>` in the grant / prompt / `listOutputs` filter.
4. Do **not** define `p 1sat ordinals` (or any other `p …` string) as the collectable **storage** basket. `p` is permissions-only.

### 2. What follows `p 1sat ` is a **filter scope**, not an asset-class basket suffix

**PR #200:** `p 1sat ordinals`, `p 1sat bsv21`, `p 1sat opns`, … = separate storage baskets per class.

**HandCash scopes** (permission + list filter only):

| Scope | Meaning |
|-------|---------|
| `*` (or empty / bare `p 1sat`) | All collectables in storage `1sat` |
| `collection:<id>` / `collectionId:<id>` | One collection |
| `creator:<id>` / `app:<id>` / `author:<id>` | One issuer |
| `origin:<txid>.<vout>` | One item |

Unknown scope tokens fall back to “all” so the user still gets a clear prompt (see app guide).

Fungibles use storage basket **`bsv21`** (separate profile), not `p 1sat bsv21` as inventory.

### 3. Do not supersede BRC-147 or retarget BRC-150 off `1sat`

**PR #200:** 303 replaces 147; 150’s companion basket becomes `p 1sat ordinals`.

**HandCash:** 147 remains the storage profile; 150 remains scoped to **`1sat`**. A permissions scheme BRC cites 147/150 — it does not rename their baskets.

### 4. `id:` is optional, not required

**PR #200 (302):** every P1Sat-filed output MUST carry `id:<actionId>_<outputIndex>`; spends MUST refer by that id; action labels `p 1sat input …` / `p 1sat action-id …` are mandatory on create/spend.

**HandCash:** `id:` MAY be used as a held-row list key (BRC-164). It MUST NOT be required to recognize, prove, internalize, or list tips. Spend targeting by outpoint / origin remains valid.

### 5. Co-authorship and soft-latch nits (from the PR review)

- Confirm before listing HandCash on 303 if that draft is revived.
- Soft-latch, if cited: **BRC-156** (official `wallet/0153` is Action References) — and BRC-156 was later withdrawn on our side; item authenticity remains BRC-150 only.

---

## Why the change

1. **One inventory spelling.** Apps and wallets already file and remittance against `1sat`. Putting storage behind `p 1sat ordinals` forces a dual-storage or mass migration for no permission benefit.
2. **BRC-99 intent.** `p ` is for scheme-mediated **grants**. Using it as the only storage name collapses two layers and makes “list my items” look like a special basket product.
3. **Scoped apps without per-collection baskets.** `p 1sat creator:…` / `collection:…` solves foxplorer-style access without inventing storage baskets per collection (`basket: "pixel foxes"` → empty).
4. **Interop with published 147/150.** Shipping wallets can adopt the scheme without rewriting provenance or basket constants.

---

## Relationship to a future formal BRC

Suggested split when filing:

| Document | Owns |
|----------|------|
| **This scheme BRC** (number TBD) | Scheme id `1sat`, protocol `p 1sat`, scope grammar, normalize-to-`1sat`, prompt/list rules, explicit non-storage of `p …` |
| **BRC-147** | Storage basket `1sat`, eligibility, display tags / CI shape for collectables |
| **BRC-150** | Offline tip→origin proof in CI |
| **BRC-164** | Optional `id:` list key |
| **BRC-123** | Register scheme id `1sat` |

PR #200’s 300/301/304–307 remain valuable **chain / encoding** docs and can proceed on their own numbering without adopting 302/303’s storage spelling.

---

## References

1. [bsv-blockchain/BRCs#200](https://github.com/bsv-blockchain/BRCs/pull/200) — source series (esp. draft 302 / 303)  
2. [`PR-200-RESPONSE.md`](./PR-200-RESPONSE.md) — HandCash review on that PR  
3. [`p1sat-listoutputs-guide.md`](./p1sat-listoutputs-guide.md) — live `listOutputs` contract  
4. [`itemAccess.ts`](../../../src/wallet/itemAccess.ts) — implementation  
5. BRC-98 / 99 / 100 / 123 / 147 / 150 / 164
