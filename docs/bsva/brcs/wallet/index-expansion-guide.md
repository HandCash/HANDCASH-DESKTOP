# Index expansion packs — developer guide (BRC-230)

HandCash Desktop and Mobile implement [BRC-230](./0230.md): wallet-local mirrors of
public overlay indexes (large NFT catalogs, feeds, curated discovery). Pack rows are
**grade C** (display/oracle). Custody, send, and market settlement still use held
basket `1sat` and existing BRC-100 market methods.

**Spec PR:** [bsv-blockchain/BRCs#240](https://github.com/bsv-blockchain/BRCs/pull/240)

## Bridge discovery

`GET https://127.0.0.1:2121/manifest.json` (or `:3321` HTTP) advertises:

```json
{
  "capabilities": {
    "brcs": ["147", "150", "164", "165", "230"],
    "baskets": ["1sat", "index"],
    "permissions": {
      "protocol": "p 1sat",
      "indexProtocol": "p index",
      "indexScopes": ["install", "read", "sync"]
    },
    "indexExpansion": {
      "methods": [
        "installIndexExpansion",
        "listIndexExpansions",
        "removeIndexExpansion",
        "syncIndexExpansion",
        "listIndexExpansionEntries",
        "overlayLookup"
      ]
    }
  }
}
```

## Permissions (`p index`)

| Wire | Meaning |
|------|---------|
| `p index install <packId>` | Download/sync manifest scope (prompted once; durable grant) |
| `p index read <packId>` | List cached entries |
| `p index sync <packId>` | Refresh from overlay (reuses install grant) |

Declare in your app manifest (`metanet.groupPermissions`):

```json
{
  "protocol": "index",
  "description": "Install public catalog indexes for offline browsing",
  "scopes": ["install", "read", "sync"]
}
```

Install/read grants **do not** imply `p 1sat all`.

## Manifest

Host a JSON manifest (see [schema](./schemas/index-expansion-manifest.schema.json)).
HandCash Market reference profile:

```json
{
  "v": 1,
  "packId": "handcash.market.catalog",
  "name": "HandCash Market",
  "description": "Browse active 1Sat listings",
  "iconUrl": "https://market.handcash.io/favicon.ico",
  "overlayBaseUrl": "https://market.handcash.io",
  "topic": "tm_1sat_market",
  "lookupService": "ls_1sat_market",
  "discovery": { "mode": "auto" },
  "scope": { "kind": "overlay-query", "query": { "mode": "active", "limit": 500 } },
  "budget": {
    "maxEntries": 5000,
    "maxBytes": 52428800,
    "maxBeefBytes": 1048576
  },
  "updatePolicy": { "mode": "onOpen" }
}
```

## Install

```ts
await wallet.waitForAuthentication()

const { packId, activityId, status } = await wallet.installIndexExpansion({
  manifestUrl: 'https://market.handcash.io/v1/index-pack.json',
})
// Wallet prompts: name, curator, topic, budgets → user Allow
// Activity: "Installing HandCash Market…" → "Installed …" / sync note
```

Inline manifest (tests / bundled packs):

```ts
await wallet.installIndexExpansion({
  manifest: {
    v: 1,
    packId: 'myapp.feed',
    name: 'My App Feed',
    overlayBaseUrl: 'https://overlay.example',
    topic: 'tm_myapp_feed',
    lookupService: 'ls_myapp_feed',
    scope: { kind: 'feed', query: { since: 0 } },
    budget: { maxEntries: 2000, maxBytes: 20_000_000, maxBeefBytes: 512_000 },
  },
})
```

Response:

```json
{ "packId": "handcash.market.catalog", "status": "installing", "activityId": "<uuid>" }
```

Initial sync runs in the background. Poll `listIndexExpansions` for `status: ready | partial | failed`.

## Read cached entries

```ts
const page = await wallet.listIndexExpansionEntries({
  packId: 'handcash.market.catalog',
  limit: 48,
  offset: 0,
})
// { outputs: [...], totalOutputs: N } — same shape as listOutputs on basket `index`
```

Each output:

```json
{
  "outpoint": "txid.vout",
  "basket": "index",
  "satoshis": 0,
  "tags": ["pack:handcash.market.catalog", "entry:listing:txid_vout"],
  "customInstructions": "{\"packId\":\"…\",\"name\":\"…\",\"origin\":\"…\",\"overlayOutpoint\":\"…\"}"
}
```

P-basket wire (equivalent):

```ts
await wallet.listOutputs({
  basket: 'p index read handcash.market.catalog',
  limit: 48,
  includeTags: true,
})
```

Optional tag filter:

```ts
await wallet.listIndexExpansionEntries({
  packId: 'handcash.market.catalog',
  tags: ['collection:fetch'],
  limit: 50,
})
```

### Live overlay read (no cache)

Prefer overlay-native reads when you need authoritative catalog state:

```ts
// Ad-hoc BRC-24 lookup (SLAP discovery + host failover)
const live = await wallet.overlayLookup({
  lookupService: 'ls_1sat_market',
  query: { mode: 'active', limit: 50 },
  overlayBaseUrl: 'https://market.handcash.io',
  discovery: 'auto',
})
// { type: 'output-list', outputs, totalOutputs, live: true, host, hostsTried }

// Or reuse an installed pack's manifest discovery hints
await wallet.overlayLookup({
  packId: 'handcash.market.catalog',
  query: { mode: 'seller', seller: '<identity-key>' },
})

// Pass-through on listIndexExpansionEntries
await wallet.listIndexExpansionEntries({
  packId: 'handcash.market.catalog',
  live: true,
  limit: 48,
})
```

Manifest `discovery`:

| `mode` | Behavior |
|--------|----------|
| `auto` | Curator `overlayBaseUrl` + `discovery.hosts`, then SLAP trackers |
| `slap` | SLAP only — omit `overlayBaseUrl` when hosts are fully discoverable |
| `url` | Fixed `overlayBaseUrl` only (no SLAP) |

## Sync, list packs, remove

```ts
const { packs } = await wallet.listIndexExpansions()
// [{ packId, name, status, entryCount, bytesUsed, lastSyncedAt, partial }]

await wallet.syncIndexExpansion({ packId: 'handcash.market.catalog', force: true })

await wallet.removeIndexExpansion({ packId: 'handcash.market.catalog' })
// Deletes basket `index` rows for the pack only — never relinquishes held `1sat` tips
```

## Activity events

| method | meaning |
|--------|---------|
| `index-install` | Install + initial sync progress |
| `index-sync` | Manual/background refresh |

Fields: `kind: event`, `status: pending | complete | failed`, `note`, optional `item.name` / `item.imageUrl` from manifest.

## Sync algorithm (wallet)

1. Resolve hosts: curator hints → SLAP (`ls_slap`) → verify `/listLookupServiceProviders`
2. `POST /lookup` with failover across verified hosts (BRC-24)
3. Map each `output-list` row → `entryKey` + `customInstructions`
4. Enforce `budget.maxEntries`, `maxBytes`, `maxBeefBytes`
5. Stop cleanly with `partial: true` when capped

## Trust boundaries

1. Pack rows are **not** custody — never call `createAction` / `purchaseMarketListing` using pack cache alone.
2. Buying still uses live overlay/market settlement + held inventory + BRC-150.
3. Cached `beefB64` is preview/SPV hint only.
4. Users manage installed packs under **Settings → Catalog packs**.

## TypeScript helper (optional)

```ts
type IndexEntry = {
  name?: string
  imageUrl?: string
  origin?: string
  overlayOutpoint?: string
}

function parseIndexEntry(output: { customInstructions?: string }): IndexEntry | null {
  try {
    return JSON.parse(output.customInstructions ?? '') as IndexEntry
  } catch {
    return null
  }
}
```

## Errors

| code | when |
|------|------|
| `INVALID_INDEX_MANIFEST` | Bad manifest JSON or schema |
| `INDEX_INSTALL_DENIED` | User denied install prompt |
| `INDEX_READ_DENIED` | User denied read prompt |
| `INDEX_SYNC_DENIED` | User denied sync prompt |
| `OVERLAY_LOOKUP_DENIED` | User denied live overlay lookup |
| `INVALID_INDEX_BASKET` | Wrong `p index` use on listOutputs |

## Related docs

- [BRC-230 spec](./0230.md)
- [Manifest JSON Schema](./schemas/index-expansion-manifest.schema.json)
- HandCash market overlay: `marketOverlayProtocol.ts` (`tm_1sat_market`)
