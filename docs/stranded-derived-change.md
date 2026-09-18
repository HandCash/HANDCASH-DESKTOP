# Stranded derived change (open — hc-ad7afbfaae0d01fffcb3)

Handoff note. At least **1,930,715 sats** of unspent, on-chain, wallet-owned
coins are invisible to the wallet. This is not a stale flag; no existing
recovery path can reach them. Everything below is verified against chain, not
inferred.

## The coins

Two legacy sweeps this wallet performed on 2026-08-17 split into eight derived
outputs each. Twelve of those are still unspent on chain and are marked
`spendable: false`, `spentBy: ""`, `diagnostic: "already-spent"` in
`handcash.wallet.utxoLocks.v1`.

| outpoint | sats | address |
|---|---|---|
| `d84527cb0f64…f5.4` | 575,245 | `1fsbQyAvAyz5ajRwAVLToidD1DrA1EATY` |
| `26164cd94e48…06.2` | 530,259 | `1EGEaHShfY8Dv9tyhVnMmtcvXrjsxidTxH` |
| `26164cd94e48…06.5` | 376,322 | `1EZtjndjaoLNYuJxp5oad2hUuC97MosDPU` |
| `d84527cb0f64…f5.2` | 145,373 | `12KVDbmXLMuzPHAdnRU1jCsw18vQ84vEZH` |
| `26164cd94e48…06.6` | 137,225 | `1Pqy3SHvUV59eJGbgjUjPD898Vaj3uCrBL` |
| `26164cd94e48…06.4` | 74,119 | `1FndbKxvm11Yb3nNcDpREY9znny3JtVUi` |
| `26164cd94e48…06.3` | 72,681 | `114zWpQBu9jfyWsqfa2MFc6rcmEfbvLMzQ` |
| `d84527cb0f64…f5.3` | 14,067 | `18umFvmAt4d7hzKHLF2WukyZo5x21scd3m` |
| `d84527cb0f64…f5.1` | 4,256 | `1G6dPKhHcezLCGgJptHVV2zXEdAPg1MQuE` |
| `26164cd94e48…06.0` | 1,051 | `17aBJh3w1g6sbq6sRxckTxmFhQHok1hUSJ` |
| `d84527cb0f64…f5.6` | 70 | `1DDtF9fDoDcj2tML6XuUEuQD8CHM9jc4pU` |
| `d84527cb0f64…f5.5` | 47 | `18vryAMWr19TLDUavkEzYo8xtnUdVhPPnA` |

Full txids:

- `d84527cb0f642d4fc01355fe64cb14990e07193a0e63fc22a6da859996f3a0f5`
- `26164cd94e48872272560082488db2c83bf5156cb25418dcb88e3b5d5ee8bb06`

**Treat 1,930,715 as a floor.** Bitails is in pruned mode and answered
`status: "unknown"` for 791 of the 882 sealed outputs, so only 91 could be
positively classified. Re-audit against a non-pruned source before assuming
this is the whole amount.

## Why they are ours

`d84527cb0f64…` spends exactly `498d7f9ce5a858f2e5031d87373b2b42be50cec2c54c1172d80a1617370a37b9:2`,
which `handcash.brc100.importedLegacyOutpoints.v2` records as a sweep this
wallet performed. The wallet built the transaction and paid its own derived
addresses, then sealed six of the resulting outputs as already-spent.

## Why nothing recovers them

The blank-sealer path in `reclaimSealedInputsNeverSpent` does examine these —
they sit at indices 63–108 of 520 blank records, inside the `RECLAIM_MAX = 200`
window — and `isUtxo` confirms them alive. It then gives up here:

```ts
const rows = await findOutputsForTxid(sp, parsed.txid);
const match = rows.find((row) => Number(row.vout ?? row.outputIndex) === parsed.vout);
const outputId = positiveId(match?.outputId);
if (outputId == null) continue;
```

There is no toolbox row to update, so the reclaim silently no-ops while the
lock record stays. Un-sealing cannot help when the row does not exist.

Nothing else finds them either. Chain ingest scans only the identity address
(782 UTXOs / 786 sats — all one-sat items). No path enumerates derived change
addresses. Once a derived output's toolbox row is missing, the coin is
unreachable by every scan we have.

## Suggested direction

Reclaim is the wrong verb; these need **re-import**. Follow the
`importLegacyUtxos` shape — create the output rows with the correct derived
locking script and mark them spendable — rather than trying to un-seal a row
that was never written.

Two things to settle first:

1. **Derivation.** We need the key path for each address to rebuild the
   locking script and spend later. `d84527cb0f64` and `26164cd94e48` are both
   recorded sweeps, so the derivation should be recoverable from the sweep
   bookkeeping; confirm before writing anything.
2. **Scope.** Decide whether to repair only verified outpoints or to add a
   standing reconciliation that catches derived outputs whose toolbox row went
   missing. The second is the actual structural fix.

Also worth fixing while in here: `RECLAIM_MAX = 200` slices an unsorted list,
so 320 of the 520 blank records are never examined on any pass. It did not
cause this case, but it permanently hides anything past position 200.

## Reproducing the audit

`durable-prefs.json` lives at
`~/Library/Application Support/handcash-brc100/`. Read
`handcash.wallet.utxoLocks.v1`, filter `spendable === false` with no valid
`spentBy`, then check each outpoint with
`https://api.bitails.io/tx/<txid>/output/<n>/status` (`spent` is a boolean;
`status: "unknown"` means pruned, not unspent) and confirm balances with
`https://api.whatsonchain.com/v1/bsv/main/address/<addr>/unspent`.

## Context: what shipped alongside this

On branch `recover/from-226`, unrelated to the stranded coins:

- `bd5bac3` — main process re-read and re-parsed the whole 6.7 MB
  `durable-prefs.json` per key while the renderer was parked on `sendSync`,
  freezing the window. Store is now held in memory with debounced writes.
- `9a62946`, `1c8ea43` — inbound hints and abandoned local spends had no
  terminal state and were chased forever.
- `329a85a` — chains of never-broadcast spends now collapse, freeing the
  one-sat items sealed behind phantom funding.

Still open: chain ingest blocks the main thread in 4–6.5 s bursts and never
finishes inside its 35 s soft deadline.
