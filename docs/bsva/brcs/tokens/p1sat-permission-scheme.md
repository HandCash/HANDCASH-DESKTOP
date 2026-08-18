# P1Sat permission scheme (HandCash)

**Status:** Implements the BRC-165 direction proposed in
[bsv-blockchain/BRCs#229](https://github.com/bsv-blockchain/BRCs/pull/229).
That draft incorporates HandCash item-access prior art from
[BRCs#221](https://github.com/bsv-blockchain/BRCs/pull/221).

## Contract

| Layer | Wire |
|---|---|
| Storage | basket `1sat` (BRC-147) |
| View | `listOutputs` basket `p 1sat <scope>`; values in tags |
| Spend | `createAction` label `p 1sat input id <key>` |
| Provenance | BRC-150 on storage basket `1sat` |

View scopes are exactly `all`, `collection`, `app`, `creator`, and `id`.
Non-`all` requests require matching `collection:`, `app:`, `creator:`, or
`id:` tags. Bare `p 1sat`, unknown scopes, extra basket tokens, and values
embedded in basket names fail closed.

`app:` and `creator:` are separate axes. A future BRC may define how `app:`
binds to Sigma application identity.

An `id` request is a narrow BRC-164 held-row lookup, not full-inventory access.
Item spend approval is per action. Pay and auto-pay never grant item view or
item spend.

## HandCash implementation

The shared Desktop/Mobile wallet core:

1. Parses and validates the P-basket before dispatch.
2. Captures the permission request, then rewrites the storage basket to `1sat`.
3. Forces tags into the wallet response and post-filters by the exact request
   axis so `tagQueryMode: "any"` cannot widen access.
4. Stores collection/app/creator/id-scoped view grants independently.
5. Auto-allows only the narrow `id:<key>` lookup and records that id-scoped
   ceiling for response filtering.
6. Stamps a BRC-164 `id:` key when a tip enters custody.
7. Resolves every `p 1sat input id <key>` label to exactly one held row and
   requires that row to be an explicit action input before per-action approval.
8. Advertises BRC-164/165 scopes and spend labels in bridge capabilities.

See [`p1sat-listoutputs-guide.md`](./p1sat-listoutputs-guide.md) for app-facing
examples.
