# Stranded derived change (open — hc-ad7afbfaae0d01fffcb3)

Handoff note. At least **1,930,715 sats** of unspent, on-chain, wallet-owned
coins are invisible to the wallet. This is not a stale flag; no existing
recovery path can reach them. Everything below is verified against chain, not
inferred.

## Status (2026-09-17)

Code now:

- Echoes BRC-29 change remittance into durable prefs when a sweep lands and
  whenever `keepChangeOfSignedTx` still has the toolbox row
  (`derivedChangeEcho.ts`).
- Re-imports a missing row with `internalizeAction` wallet-payment remittance
  (`reimportDerivedChange.ts`) — not a second `importLegacyUtxos` sweep.
- Reclaim looks up rows by `transactionId` when `txid` is blank, ranks by
  value, always includes echo keys, and rotates past `RECLAIM_MAX`.

**These twelve coins still cannot be spent on this install.** The sweep was
2026-08-18 22:58. Cloud BRC-39 `lastUploadedAt` is 2026-08-17 21:18. Local
archive and IndexedDB contain neither txid. Without `derivationPrefix` /
`derivationSuffix` the locking scripts cannot be unlocked. The new path will
recover the next wallet that still has the row long enough to echo it, or any
device whose history replica still has those outputs.

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

## Why reclaim could not recover them

Reclaim only `updateOutput`s. There is no toolbox row (txid lookup *or*
`transactionId` link). Un-sealing the overlay does not recreate BRC-29
derivation. Chain ingest scans only the identity address; it never enumerates
derived change.

The sweep txids are also absent from local IDB and from BRC-39 (last cloud
upload predates the sweep), so remittance cannot be reconstructed.

## What the code does now

Re-import, not reclaim: `internalizeAction` as a self wallet-payment when a
durable remittance echo exists. Echo is written at sweep success and from
`keepChangeOfSignedTx`. Reclaim ranks by value, prefers echo keys, rotates
past `RECLAIM_MAX`, and looks up rows by `transactionId`.

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
