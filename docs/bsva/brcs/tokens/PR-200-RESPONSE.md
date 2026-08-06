# Response to [BRCs PR #200](https://github.com/bsv-blockchain/BRCs/pull/200)

Brandon Cryderman / HandCash (brandongcryderman@gmail.com)

**Status:** Proposed wallet-contract for the 1Sat series — keep 300–307’s documentation value; define 302/303/150 with a clean layered BRC-100 model.

This is not a rejection of the series. Documenting live 1Sat behavior is overdue and welcome. The ask is a **clear ideal filing contract**: storage and permissions are different layers.

---

## 1. Ground covered (same map as 300–307)

| Concern | Ideal home | Note |
|---------|------------|------|
| Origin, sat ordering, transfer / burn | Core 1Sat BRC (300) | Keep |
| Inscription envelopes + MAP basics | Inscriptions BRC (301) | Keep; do not mix with basket naming |
| BRC-100 scheme / permissions | P1Sat scheme BRC (302) | Scheme + scoped grants via `p 1sat …` |
| Collectable basket profile | Collectables BRC (303 / successor to 147) | Storage basket = `1sat` |
| Collections + issuer binding | Collections BRC (304) | Keep |
| BSV-21 JSON / binary | Fungible BRCs (305 / 306) | Keep; underscore token ids stay |
| Sigma | Sigma BRC (307) | Keep; verify test vector independently |
| Offline tip→origin proof | BRC-150 | Scope to storage class `1sat`; proof format unchanged |
| Optional O(1) latch companion | BRC-156 (not 153) | Tip 1 + latch **exactly 2**; authenticity remains 150 until induction lands |

**Numbering note.** Official `wallet/0153` is already *Action References*. Soft-latch MUST NOT use 153. Use **BRC-156** (or next free token slot). Placeholder 300–307 → lowest free allocations at merge time.

---

## 2. Ideal wallet contract

### 2.1 Storage vs permissions

BRC-98 / BRC-99 `p ` forms are for **permission prompts and scoped grants**, not storage basket names.

| Layer | Law |
|-------|-----|
| **Storage basket** | `1sat` |
| **Permissions** | `p 1sat <scope>` (`*`, `collection:…`, `creator:…`, `origin:…`) |
| **Scheme id** | `1sat` under `p 1sat` |

**Normative behavior**

1. Conforming wallets **file** collectables in storage basket `1sat`.
2. Apps **request** access with plain `1sat` or `p 1sat <scope>`.
3. Wallets **normalize** inbound `p 1sat …` onto storage `1sat` and apply scope in the grant/prompt.
4. Do **not** define `p 1sat ordinals` (or any other `p …` string) as the collectable storage basket. `p` is permissions-only.

Scoped app access is solved entirely by (2)–(3). Storage does not need a `p` spelling.

### 2.2 Tags are claims; proof is remittance

- Tag / display fields are **non-authoritative**.
- Offline authenticity is **BRC-150 v2** (`provenance` in `customInstructions`).
- Indexer metadata keyed by a **verified** origin is display only.
- Structural latch remittance (v3) is not authenticity until induction is specified (BRC-156).

### 2.3 `customInstructions` = display + spend + proof

Spend fields (`protocolID`, `keyID`, `counterparty`) MUST NOT displace provenance:

```json
{
  "origin": "<txid_vout or txid.vout>",
  "name": "<optional>",
  "app": "<optional>",
  "provenance": { "v": 2, "origin": "…", "path": [], "beefB64": "…" },
  "protocolID": [0, "p 1sat"],
  "keyID": "<optional>",
  "counterparty": "self"
}
```

Readers ignore unknown keys. Writers SHOULD preserve foreign keys on re-file.

### 2.4 Outpoints: both forms, one identity

Accept `txid.vout` and `txid_vout` after normalize. Prefer dot on BRC-100 wire; keep underscore where chain history already fixed it (e.g. BSV-21 token ids).

### 2.5 Classify operations from transaction shape

Agree with 302/303: derive mint / transfer / burn / list / cancel / purchase from locking scripts and spent templates, not a caller verb. Unrecognized templates are described to the user; refusal is wallet policy.

### 2.6 Optional tracking ids — not a gate

`id:<actionId>_<outputIndex>` is useful inside a permission module. It MUST NOT be required to recognize, prove, internalize, or list tips.

### 2.7 Live chain is the ownership oracle

Show tips that are **both** in storage basket `1sat` **and** live 1-sat UTXOs on the ownership set.

### 2.8 Soft-latch is optional acceleration

BRC-156: tip = 1 sat, latch = exactly 2 sats; companion basket `1sat-latch`; never list latch as a collectable. Latch may signal “arriving”; authenticity remains BRC-150 until induction lands.

---

## 3. Concrete change requests on this PR

1. **302 / 303:** Storage basket = `1sat`. Permissions = `p 1sat <scope>` only. Do not set collectable storage to `p 1sat ordinals`.
2. **BRC-150:** Keep proof format; target storage class `1sat`.
3. **CI field map:** display + spend + `provenance` in one object.
4. **`id:` tags:** optional for interop.
5. **BRC-156** (not 153) for optional latch; cite or mark out of scope in 303.
6. **Co-authorship on 303:** confirm with Brandon before listing; credit 147 authorship either way.
7. **Sigma test vector:** independent verify before merge.

---

## 4. Shipping reference (informative)

HandCash Desktop implements this split: storage `1sat`, permissions via `p 1sat <scope>` normalized onto storage, BRC-150 in CI, optional soft-latch companion.

---

## 5. Suggested merge shape

Keep 300–301 and 304–307.

Set **302 / 303 / 150** to:

1. Permissions speak `p 1sat <scope>`.
2. Storage files **`1sat`**.
3. Provenance lives in CI when available.
4. Collections / BSV-21 / Sigma do not dictate storage spelling or required `id:` tags.

Same goals (BRC-100 fit, scoped grants, clear collectables profile, documented chain theory) with a single clean storage law.
