# Wallet history: append-only, immutable, durable

Status: proposal (2026-11-11). Nothing here is built yet.

## What history is today

| Store | Shape | Write | Failure seen |
|---|---|---|---|
| Custody journal (`custodyJournal.ts`) | Immutable entries named by sha256, set-union merge, root over sorted ids | Whole set as one JSON blob through `durableSetItem` (synchronous shell call), 2.1 MB on the lab phone | 80–120 ms UI block per write; one torn or refused write loses the whole file's update |
| Activity ledger snapshot (`activityLedgerStore.ts`) | One mutable record per account: up to 10,000 rows + every settled tx's ledger fields | `put` of the whole record; a rows-only write reads the record and writes it all back | An empty read once overwrote 3,726 rows (guard added after); older rows are cut at 10,000 |
| Toolbox IndexedDB | Mutable rows (`transactions`, `outputs`, `provenTxs`) | Row updates in place | History merge (`resolveWalletEngineDatabase`) refused every unlock; restores replace it wholesale |
| BRC-39 backup (`historyBackup.ts`) | Whole-wallet BRC-38 export | Full upload; empty-local guard in `historyEmptyGuard.ts` | A thin replica can overwrite a thick one if a guard misses |
| Item list, utxo overlay, inscription cache | Whole-value JSON blobs | Synchronous shell writes, 600–800 KB each | Repeated UI blocks (logs Nov 7–8) |

The common faults: values are rewritten whole, so a write costs the whole history and can lose it; facts that never change (a settled transaction, a spend recipe) share a record with facts that do (status, labels); and replicas merge by replace or by a full export that one bad row can refuse.

## Rules

1. **Facts are immutable and content-addressed.** A fact is written once under `sha256(canonical JSON)` and never edited or deleted. Status changes are new facts (`seen-in-block`, `spent-by`, `failed`), not edits.
2. **Append, never rewrite.** Each write adds only new facts. No code path serialises the whole history.
3. **Merge is set union.** Two replicas merge by adding the facts either lacks. No merge, restore or backup download can remove a fact, so no replica can be thinner after a merge. This replaces the replace-and-guard logic (`historyEmptyGuard.ts`, the empty-read guard in Activity).
4. **Views are derived.** Activity rows, balances, item lists and holdings are folds over facts, cached as disposable projections. Losing a projection costs a rebuild, never history.
5. **Durable before acknowledged.** A fact counts as written only after its store confirms it: the IndexedDB transaction completes (`tx.oncomplete`), or `durableSetItem` returns true. Messagebox ACKs, inbox deletes and `handover` merges wait for that, as ACKs already wait for ingest.
6. **Tamper-evident.** Each segment carries its root (sha256 over its sorted fact ids, as the journal does today). The backup and the vault link exchange roots first and send only the facts the other side lacks.

## Storage

Custody facts (spend recipes) stay in the durable store (`durableStorage.ts`: the Electron userData file, the Android app file store). It survives an origin change and a factory wipe (`wipePolicy.ts`); IndexedDB does neither, and a lost recipe strands coins. They are kept as immutable segment files, one per append, folded into one file every 32 segments (`custodyJournal.ts`).

Everything that can be rebuilt from chain plus custody facts goes in one IndexedDB database per account, `handcash-brc100-history-<namespace>`:

- `facts` — key `id` (sha256), value `{ id, kind, at, body }`, index on `kind` and on `subject` (txid or outpoint). Written with `add`, never `put`: a duplicate id is a no-op, and an existing fact cannot be replaced.
- `segments` — sealed runs of fact ids with their root. Sealed every N facts (e.g. 512) or hourly; never changes after sealing.
- `projections` — disposable caches (Activity rows, item list), each tagged with the root it was built from.

Writes go in slices of about 100 facts per transaction, yielding between slices (insight `lock-discipline`), and run off the UI thread wherever IndexedDB is available in a worker. Nothing goes through `durableSetItem` except small pointers.

## Migration, in order

1. **Custody journal → append-only segments** (done). Each append writes only its new entries as segment `<key>.s<n>`, never edited; reads take the union of the old whole file and every segment, so the root is unchanged. Every 32 segments are folded into the whole file, base first and segments removed highest first, so a stop at any point loses nothing. Replaces the 2.1 MB synchronous write on every append with one per 32 appends.
2. **Activity ledger → projection.** Settled transaction ledger fields become `tx-settled` facts; rows are a fold. Drops the 10,000-row cap and the rewrite-the-whole-record save.
3. **BRC-39 backup → segment exchange.** Upload sealed segments (immutable, so cache forever by root); download merges by union. A displaced install's `handover` becomes "send the facts after my last uploaded root", which is the same operation.
4. **Toolbox merge.** Replace the BRC-38 export/import merge in `walletEngineMigration.ts` with facts the toolbox can re-internalize (journal recovery already does this for spend recipes), so one unverifiable proof no longer refuses the whole merge.
5. **Overlays** (utxo locks, item list): move to keyed IndexedDB rows written per changed key, not whole blobs.

Each step ships alone, keeps reading the old store until the new one is confirmed complete, and adds a test that a merge of two diverged replicas holds the union of both.

## Not changed

Custody stays grade A: chain plus toolbox decide what is spendable. Facts record what this wallet knows; they never mark data as proven without a complete proof (insight `proven-means-proven`). Refresh stays chain ingest; this is the history replica layer (`layers.ts`).
