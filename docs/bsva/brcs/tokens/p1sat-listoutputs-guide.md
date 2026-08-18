# Requesting collectables from HandCash (BRC-165)

HandCash implements the BRC-165 wire proposed in
[bsv-blockchain/BRCs#229](https://github.com/bsv-blockchain/BRCs/pull/229).

Storage and permissions are separate:

- Held collectables stay in basket `1sat` (BRC-147).
- Apps request a permission axis with `p 1sat <scope>`.
- The requested value is an ordinary tag, never part of the basket name.

## View requests

Full inventory:

```ts
await wallet.listOutputs({
  basket: 'p 1sat all',
  include: 'locking scripts',
})
```

One collection:

```ts
await wallet.listOutputs({
  basket: 'p 1sat collection',
  tags: ['collection:<collection-id>'],
  include: 'locking scripts',
})
```

One app:

```ts
await wallet.listOutputs({
  basket: 'p 1sat app',
  tags: ['app:<app-id>'],
  include: 'locking scripts',
})
```

One creator:

```ts
await wallet.listOutputs({
  basket: 'p 1sat creator',
  tags: ['creator:<creator-id>'],
  include: 'locking scripts',
})
```

One held row:

```ts
await wallet.listOutputs({
  basket: 'p 1sat id',
  tags: ['id:<brc-164-key>'],
  include: 'locking scripts',
})
```

`app:` and `creator:` are distinct. Bare `p 1sat`, unknown scopes, values
embedded in the basket name, and non-`all` requests without a matching axis
tag are rejected.

Additional tags may narrow a request, but cannot widen it past the selected
axis values. HandCash post-filters results to preserve that ceiling even when
the caller uses `tagQueryMode: "any"`.

## Spend requests

A module-mediated spend names each held row with a BRC-164 key:

```ts
await wallet.createAction({
  labels: ['p 1sat input id <brc-164-key>'],
  inputs: [{ outpoint: '<the row carrying id:<brc-164-key>>', /* unlock data */ }],
  // transaction outputs...
})
```

The label must resolve to exactly one held row, and that row must be an explicit
input in the action. Every collectable spend requires approval for that action.
Pay and auto-pay permissions never authorize item view or item spend.

## Migration from the earlier HandCash draft

Replace:

- `p 1sat *` → `p 1sat all`
- `p 1sat collection:<id>` → `p 1sat collection` + `collection:<id>` tag
- `p 1sat app:<id>` → `p 1sat app` + `app:<id>` tag
- `p 1sat creator:<id>` → `p 1sat creator` + `creator:<id>` tag
- `p 1sat origin:<outpoint>` → `p 1sat id` + `id:<key>` tag

No third-party application shipped against the earlier HandCash wire.
