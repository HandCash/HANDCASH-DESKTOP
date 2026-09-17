# HandCash Desktop — Bitcoin interaction order

SSoT: `src/wallet/layers.ts`. UI balance = **balanceView** (spendable managed change + unconfirmed local change), not raw address UTXOs.

## Layers

| Layer | Role | Entry |
|-------|------|-------|
| custody | Vault keys | `vault.ts` |
| localState | Toolbox IDB: baskets, managed change, BRC-150 remittance | `session.ts` |
| chainIngest | Network → localState | `chainIngest.ts` → `refreshFromChain` |
| historyReplica | BRC-39 backup / multi-device | `deviceSync.ts`, `historyBackup.ts` |
| coordinator | Mutex: ingest × spend × history × recompose | `walletCoordinatorMachine.ts` |

**Refresh** = chainIngest only. **History restore / Pair sync** = historyReplica. **Recompose** = history then chain (`recomposeWallet`).

## Refresh pipeline (chainIngest) vs header digest

**Ingest** finds coins that are not yet in localState. **Digest** classifies coins we already hold.

| Job | What it does | Must not do |
|-----|----------------|-------------|
| Ingest `refreshFromChain` | Reconcile pending sends; maintenance; legacy P2PKH scan → import funding / 1sat | Treat indexer 404 / `isUtxo false` on *our* unconfirmed change as a spend |
| Header digest | Local headers (`blockHeaders`, Arcade go-chaintracks, `chainTrackerFallback`) | Call Arcade 202 / explorer HTTP 200 “mined” |

`chainProofKind`: `headerProven` (merkle root matches a stored header) vs `unconfirmed` (no header yet — chain only with ancestor **bodies** in the BEEF) vs `unknown` (refuse to spend onward).

1. Reconcile pending sends (`txReconcile`, dual-layer locks).
2. Maintenance: ghost heal, activity prune, live change restore.
3. Legacy P2PKH scan → classify → import funding / 1sat (`legacyScan`, `oneSatImport`).
4. Explorer waterfall is a **finder** (BananaBlocks → Bitails → HandCash Chain), not a custody judge.

Never use Refresh to recover P2P remittance or managed-change history — that is BRC-39.

## Send paths (explicit machines — no silent fallthrough)

| Flow | Machine | Broadcast |
|------|---------|-----------|
| External BSV | `bsvSendMachine` | Sender `createAction` |
| BRC-29 peer pay | `brc29SendMachine` | Sender broadcasts, then messagebox remittance |
| Collectable / item | `collectableSendMachine` → `itemSendMachine` | `noSend`; peerDeliver (payee) or sender broadcast after inbox |
| Legacy sweep | `legacySweepPath` | Tagged import/sweep |
| Market listing | `marketListing` + settlement | Atomic item+offer; no abort after sign |

**BRC-150 remittance** lives in `customInstructions` (local basket metadata). It does not travel on P2PKH. Item tips are plain P2PKH; authenticity = offline BRC-150 proof (`oneSatProvenance.ts`).

**Messagebox** (BRC-33) is store-and-forward for chat/notify — optional, never gates custody.

## Balance stuck / heal

Symptom: **displayed** balance > **spendable** (pending local change).

| Mechanism | When |
|-----------|------|
| `promotePendingLocalChangeOutputs` | Background when pending change detected |
| `runChangeHeal` | After send cleanup (spend gate → chaining script) |
| **Manual UTXO evidence heal** | Settings: audit toolbox outputs + history txids (`utxoHealFromHistory.ts`) |

Heal rules:
- **Tri-state evidence only:** `spent` removes a spendable UTXO; `unspent`
  restores a dropped UTXO; `unknown` makes no mutation.
- UTXO writes are transaction-shaped (Cloud lesson): revert or restore a local
  tx, adopt a named spender, or quarantine when spent but the spender body is
  unknown. Draft reservations expire; quarantine is not thawed on a timer.
  Failed local rows that explorers prove on-chain restore as that transaction.
- `isUtxo === false`, explorer 404, Arcade status, and transaction absence are
  not proof of a spend. Unconfirmed local cheques remain sealed.
- Restoring requires affirmative UTXO evidence (or a known source transaction
  plus affirmative unspent status) and no live local spender/item transfer.
- Manual Heal owns the ingest turn and completes; it does not cancel the user's
  current send attempt and cannot report success after checking zero outputs.
- After mutation, balance is invalidated, Collectables is authoritatively
  re-listed, and pending item Activity is reconciled from the same evidence.
- The checkpoint is a batching optimization for history txids, never evidence.

Reads must also refuse to publish a **torn** total. A self-consolidation seals
the inputs it spent, then internalizes their single replacement seconds later;
in between, local state honestly holds almost nothing. `selfFundsRewrite.ts`
marks that window and `fetchBalanceRead` answers `unavailable`
(`fundsMidRewrite`) inside it — the same answer busy storage gives, so the hero
keeps the last owned figure and spend gates fall back to proven confirmed sats.
The pass republishes the settled balance when the window closes, on the reject
path as well as on success. A read failure is never a zero; a mid-rewrite read
is never a balance.

Change of an **app-held** tx is the other way to strand money. `noSend: true`
(every `peerDeliver` item settle) leaves the row `nosend`, and `nosend` change
must not fund the next spend while the app can still abort. Arcade acceptance
ends app-held: `pinBroadcastLocalTx` moves the row off `nosend`, seals its
inputs, and promotes its change. `isAppHeldTxStatus` in `kernel/txLiveness.ts`
is the only definition of that state. The bulk item run awaits the pin of the
leg that funds the next leg, because a run otherwise starves on its own change
while the balance reads near zero. `nosend` change belongs to neither
`spendable` nor `pendingChange`, so heal gates on the Arcade pin registry
(`hasArcadeSubmitContacts`), never on projected pending change.

Collectable sends admit at most 25 selected items per run. Each run preserves
the measured-safe five-item atomic leg ceiling; larger selections fail before
Activity rows, reservations, signing, or network work begin.

## Proof fetch cost (receive-side verify)

A receiver's BRC-150 verify is package work plus whatever path bodies the lean
remittance shipped as txid-only. **Send is supposed to deliver that package**
(`meta.provenance` on the item inbox card plus Atomic BEEF of this hop). Indexer
hydrate is only for a body the box could not carry. Latency must not change the
verdict — verify still fails closed on a body that never arrives.

- `beefCache.ts` prefers the indexer but hedges: WhatsOnChain joins after
  `BEEF_HEDGE_AFTER_MS` and the first proof-carrying answer wins. Do not restore
  a strict indexer-then-fallback chain; that charged one full
  `BEEF_FETCH_TIMEOUT_MS` per cold body.
- `hydrateMissingPathTxs` knows its whole missing set up front, so the fetches
  overlap. **Merging stays sequential with `yieldToUi`** — parallel `mergeBeef`
  of a fat mint origin is what freezes input, not the fetching.
- One origin fetch is shared by every tip in a collection through
  `getBeefForTxidCached` (session cache + in-flight dedupe + raw-miss memo).

### Inline envelopes are AtomicBEEF or nothing

`internalizeAction` accepts **AtomicBEEF only**. `Beef.toBinary()` ignores
`atomicTxid`, so assigning that field and serializing plainly yields a package
that self-verifies and is still refused — *"The tx parameter must be valid
AtomicBEEF"*. That downgrade in `mergeLocalUnconfirmedAncestry` made every inline
peer delivery permanently un-internalizable: no item in the basket, no change
back, an Activity row stuck on Receiving, and a balance short by the whole spend.

- Serialize a subject package with `toBinaryAtomic(txid)`. Never set `atomicTxid`
  and call `toBinary()`.
- Ingest re-frames whatever arrives through `atomicBeefForSubject` before
  internalize (`sendBrc29Payment.ts`, `ingestItemSettle.ts`). A binary that
  cannot be framed falls through to the next source instead of failing the
  settle — the sender may be an older build or another wallet.

## Confirmation model

- Soft locks + ARC status (`dualLayerSend`, `utxoLockManager`) are rumours.
- **Unconfirmed** cheques (`chainProofKind`) are spendable and chainable when ancestor bodies are present. SPV of the package is the accept check — that is how P2P scales without waiting on miners.
- **Hard finality** = `headerProven`: MINED after SPV BUMP vs local headers (`spvFinality`). Not HTTP 200, not Arcade 202.
- Activity keeps signed sends until a competing spend is proven; clearing archives txid hints (`archivedAt`).

## BRC-100 bridge

Local HTTP `127.0.0.1:2121` (HTTPS) / `:3321` (HTTP). `brc100Handler.ts` gates methods by origin permissions. HandCash migrate methods mirrored with items-market.

## Recovery order (device empty)

1. Unlock → optional History restore (BRC-39).
2. Pair sync / device peer.
3. Recompose (history then Refresh).
4. Settings → Heal balance from history if pending change persists.

## Invariants

- Custody paths stay grade A; never gate BSV/item success on messagebox.
- No BRC-156 / soft-latch (withdrawn).
- No catch covenant → P2PKH on item send.
- BRC-29: one payment tx; inbox miss → remittance outbox retry only.
- Items: sender must not broadcast before peer delivery on `peerDeliver`.
