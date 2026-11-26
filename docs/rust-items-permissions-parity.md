# Rust items and permission parity

## Boundary

These phases port the permission charts and the read-only Collect projection.
They do **not** enable native signing, broadcast, item transfer, burn, account
takeover, or a new BRC-100 authorization path. The TS wallet remains intact.
An item card, cached image, or issuer label never grants spend authority.

## Executable reference

| TS reference | Rust implementation | Replay |
| --- | --- | --- |
| permissionDecisionMachine | handcash-machines/permission_decision | permissions/traces.json: all 243 five-event sequences |
| grantExpiryMachine | handcash-machines/grant_expiry | expiry boundaries, extension, revocation, final-state immunity |
| importWriteGrantMachine | handcash-machines/import_write_grant | allow, deny, timeout, review failure, revocation, lapsed authorization and persist failure |
| collectableGroups | handcash-engine/collectables | issuer shelves, nested collections, loose items, compact assets, stable sort, deduplicated faces, counts |
| collectableSearch | handcash-engine/collectables | comma-AND matching, metadata/traits/extras, suggestions and ranking |
| collectableSelection | handcash-engine/collectables | held-item reconciliation, busy-item exclusion, mixed/all/none and toggles |
| issuerViewFor | handcash-engine/collectables | signed/unsigned, verified, listed, unconfirmed and mismatched BAP attribution |

Fixture paths above are relative to native-desktop/fixtures.
The recorders invoke the actual TS functions/charts rather than hand-written
expected outcomes. Rust integration tests replay the checked-in JSON.

Grouping uses ICU root collation at primary strength for TS
localeCompare sensitivity "base", and tertiary strength for suggestions.
The reference fixtures cover the recorder's English/root locale, including
accented labels; they are not evidence for every device locale.

## Native wiring

InventoryPanel adapts WalletSnapshot display rows and metadata into the pure
model. Shelf identity, nested collections, face selection, search, suggestions,
selection reconciliation and group toggles use that model.
Custody rows and proof bytes are not part of the projection.

Compact BRC-255 assets are covered by the pure grouping replay. This change
does not create a native BNT balance/indexing service; InventoryPanel still
receives the existing one-sat snapshot. Live BNT ingestion is outside these phases.

PermissionRequestPanel uses the existing Aeon decision chart, checks its live
state synchronously before dispatch, and claims the transition before calling
the owner. Callbacks return whether the owner accepted the decision; missing
or stale decisions reset the chart. Changing the prompt id/origin resets the
decision and form data. Signing-dependent approval stays gated by default.

Unsigned issuer claims cannot borrow a known profile's name, image or listing.
A copied BAP stamp without a verified link remains unconfirmed. The read model
consumes verified resolver outcomes; this is not a new identity-proof verifier
or a complete port of historical BAP signer-height validation.

## Verification

Run the two TS recorder tests together with their grouping/search/selection
and permission-chart reference tests, then the Rust collectables_parity and
permission_parity integration tests. Native state display regression tests
and the existing honest-gating SSR test cover the affected app surfaces.
TypeScript type checking and cargo check of handcash-app are also required.

This evidence is state/output and SSR evidence, not visual comparison or a
live two-device wallet test. Later send and full-screen parity phases remain
separate and must retain the signing review gate.

## Phase 3: pure item-send flow

The existing collectableSend, itemSend and collectableSendRun Aeon charts
now have executable TS trace replay in item-send/traces.json. The recorder
covers parent refusal/success/failure, the three settlement routes,
createAction returning a transaction versus requiring signing, failures in
each active phase, retrying broadcast without rebuilding, split-leg counts,
wallet-wide halt, reset and ignored duplicate/late events. Broadcast/delivery
policy is checked at every recorded stable state. RESET during active work
is ignored by the reference charts; this is not a new cancellation edge.

The missing compose path chooser is ported in handcash-machines:
covenant refusal precedes advisory readiness; unknown scripts need the
reference authenticity verdict; missing compose scripts remain a hint that
the spend owner must recover the exact lock. This is not custody authority.

handcash-engine/collectable_send_run ports selection normalization and
deduplication, uncapped single-atomic-leg planning, ordered failure
classification, half-splitting and intermediate Activity suppression.
Wallet, network, ancestry and unknown faults stop; only named item conflicts
are eligible for splitting. Replay includes overlapping fault messages to
protect that precedence.

Verification: rustItemSendParity.test.ts generates the fixture; Rust
item_send_parity (four tests) and item_send_run_parity (one test) replay it.
The focused TS reference tests and TypeScript check must also pass.

This slice does not port collectables.ts transaction construction, exact
custody-row reads, key derivation, durable signed-send lifecycle, the async
bulk executor, miner change pinning or PeerPay delivery. In particular,
post-sign failures must never cause a leg to be re-signed. No live transfer
or burn is enabled or claimed. The independent crypto review and native
send-engine task remain prerequisites to executing these charts; UI
integration/full-screen parity is the next separate phase.
