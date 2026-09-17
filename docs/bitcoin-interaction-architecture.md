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
- `isUtxo === false`, explorer 404, Arcade status, and transaction absence are
  not proof of a spend. Unconfirmed local cheques remain sealed.
- Restoring requires affirmative UTXO evidence (or a known source transaction
  plus affirmative unspent status) and no live local spender/item transfer.
- Manual Heal owns the ingest turn and completes; it does not cancel the user's
  current send attempt and cannot report success after checking zero outputs.
- After mutation, balance is invalidated, Collectables is authoritatively
  re-listed, and pending item Activity is reconciled from the same evidence.
- The checkpoint is a batching optimization for history txids, never evidence.

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
