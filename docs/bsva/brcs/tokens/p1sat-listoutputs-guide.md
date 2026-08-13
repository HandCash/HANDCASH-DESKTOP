# Requesting collectables from a HandCash wallet (`p 1sat` guide)

For app developers (foxplorer, Pixel War, any BRC-100 client). This is the
**actual `listOutputs` contract** the HandCash wallet honors today — copy the
snippets verbatim.

Companion to [`PR-200-RESPONSE.md`](./PR-200-RESPONSE.md). Storage and
permissions are **different layers**: storage basket is always `1sat`;
permission scope travels as `p 1sat <scope>`.

---

## TL;DR

- **Do not invent a basket name.** `basket: "pixel foxes"` is an unknown storage
  basket and returns **zero** outputs. There is no per-collection basket.
- **Ask by scope with the `p 1sat …` form.** The wallet shows one permission
  prompt scoped to what you asked for, then returns only matching items.
- **Filter by issuer is the reliable primary.** Every collectable the wallet
  stores is tagged `app:<issuer>`; the wallet maps a `creator:` request onto
  that tag. Use it.

---

## 1. Filter by issuer (recommended)

`<issuerId>` is the issuer / app identifier that minted the item (the value that
ends up as the `app:` tag on the tip, ≤ 40 chars).

```ts
const { outputs } = await wallet.listOutputs({
  basket: 'p 1sat creator:<issuerId>', // aliases also accepted: app:… / author:…
  include: 'locking scripts',          // or 'entire transactions' for full BEEF
  limit: 100,
})
```

The wallet:
1. Normalizes `p 1sat …` onto the storage basket `1sat`.
2. Prompts the user once: "Let <app> view items from <issuerId>".
3. Returns only outputs whose `app:` tag (or remittance `customInstructions.app`
   / `.creator`) equals `<issuerId>`.

## 2. Filter by collection

```ts
const { outputs } = await wallet.listOutputs({
  basket: 'p 1sat collection:<collectionId>', // alias: collectionId:<id>
  include: 'locking scripts',
  limit: 100,
})
```

The wallet stamps a `collection:<id>` tag on every tip it imports or sends when
the collection id is known, and also matches remittance
`customInstructions.collectionId`.

Caveat for **older** tips: items internalized before collection tagging shipped
have neither the tag nor the remittance field, so they will not match a
collection scope until they are re-imported or transferred. Issuer scope (§1)
covers those, which is why it stays the recommended primary.

## 3. One specific item (origin)

```ts
await wallet.listOutputs({
  basket: 'p 1sat origin:<txid>.<vout>',
  include: 'locking scripts',
})
```

## 4. Everything the user owns

```ts
await wallet.listOutputs({
  basket: 'p 1sat *',
  include: 'locking scripts',
  limit: 100,
})
```

---

## Scope tokens the wallet parses

| Scope | Meaning | Matches against |
|-------|---------|-----------------|
| `*` (or empty) | all collectables | — |
| `collection:<id>` / `collectionId:<id>` | one collection | `collection:` tag or remittance `collectionId` |
| `creator:<id>` / `app:<id>` / `author:<id>` | one issuer | `app:` tag or remittance `app` / `creator` |
| `origin:<txid>.<vout>` | one item | `origin:` tag or remittance `origin` |

Unknown scope tokens fall back to "all" so the user still gets a clear prompt.

## Alternative: plain basket + tags

If your client can't send the `p 1sat` form, you may query the storage basket
directly and narrow with tags:

```ts
await wallet.listOutputs({
  basket: '1sat',
  tags: ['app:<issuerId>'],   // or ['origin:<txid>.<vout>']
  tagQueryMode: 'all',
})
```

## What comes back on each output

Tags stored per collectable tip (use these to render / re-filter client-side):

- `ordinal`
- `origin:<txid>.<vout>`
- `name:<name>` (≤ 80 chars)
- `app:<issuer>` (≤ 40 chars, when known)
- `content:<origin>` (for derivatives, when known)

## Worked example — Pixel Foxes

Issuer (`MAP.app`) is `RareDropper`; collection id is the collection root origin.
The collection is MAP-declared, so anyone can claim membership — keep the known
impostor origin filtered client-side.

```ts
const COLLECTION_ID =
  '1611d956f397caa80b56bc148b4bce87b54f39b234aeca4668b4d5a7785eb9fa_0'
const ISSUER = 'RareDropper'
const BLOCKED_ORIGINS = new Set([
  'f427feefc17b0d946425b598dc5c34bc72aa25fd33601620756413b05330c42c_0',
])

// Issuer scope is the reliable primary; it also matches pre-tagging tips.
const { outputs } = await wallet.listOutputs({
  basket: `p 1sat creator:${ISSUER}`,
  include: 'locking scripts',
  includeTags: true,
  limit: 100,
})

const toUnderscore = (op: string) => op.replace(/\.(\d+)$/, '_$1')
const tagValue = (tags: string[] | undefined, prefix: string) =>
  tags?.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? ''

const foxes = outputs.filter((o) => {
  const origin = toUnderscore(tagValue(o.tags, 'origin:'))
  if (BLOCKED_ORIGINS.has(origin)) return false
  const collection = toUnderscore(tagValue(o.tags, 'collection:'))
  // Tips imported before collection tagging carry no collection tag — issuer
  // scope already constrained them, so do not drop them for a missing tag.
  return collection === '' || collection === COLLECTION_ID
})
```

Swap the first call for `basket: \`p 1sat collection:${COLLECTION_ID}\`` when you
want the wallet to scope the permission prompt to the collection instead of the
issuer.

## Errors

- Unsupported permission scheme (e.g. `p bsv21 …` where not allowed) → HTTP 400
  `UNSUPPORTED_P_BASKET`.
- Unknown storage basket (`pixel foxes`, `my-collection`, …) → `200` with an
  empty `outputs` array. Not an error — just nothing matched.
