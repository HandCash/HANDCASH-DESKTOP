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

## Refresh pipeline (chainIngest)

1. Reconcile pending sends (`txReconcile`, dual-layer locks).
2. Maintenance: ghost heal, activity prune, live change restore.
3. Legacy P2PKH scan → classify → import funding / 1sat (`legacyScan`, `oneSatImport`).
4. Explorer waterfall: BananaBlocks → Bitails → HandCash Chain (not custody gates).

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
| **UTXO heal checkpoint** | Activity + log txids + durable checkpoint (`utxoHealCheckpoint.ts`) |

Heal checkpoint rules:
- **Overlap window** (6h): fresh + zero pending → skip full pass (Settings shows OK).
- **Always merge** checkpoint txids into candidates so prior heals are never lost.
- **New txids** or pending change → run pass even inside overlap.
- Auto passes: send-cleanup, pending-change background (3min cooldown). Manual Settings heal forces pass.
- Activity row only when manual heal moves sats or still pending (no progress bar).

## Confirmation model

- Soft locks + ARC status (`dualLayerSend`, `utxoLockManager`).
- Hard finality = MINED after SPV BUMP — not HTTP 200 alone.
- Activity keeps signed sends until inputs spent on chain; clearing archives txid hints (`archivedAt`).

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
