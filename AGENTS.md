# HandCash Desktop — agent instructions

**Audience:** Cursor, Claude Code, Copilot, and other coding agents.  
**Product:** Official HandCash Desktop wallet (BETA) — self-custodial BRC-100 bridge + Aeon UI.

## North stars

1. **UI = Aeon** — single source of truth. Machines first, then projection. See `.cursor/rules/aeon-ui.mdc`.
2. **Protocol = BRC-100 / BSVA** — local HTTP bridge, origin permissions, mirrored migrate contract. See `.cursor/rules/brc100-bsva.mdc`.
3. **Wallet layers** — do not conflate chain ingest with BRC-39 history. See `src/wallet/layers.ts`.

## Wallet layers (mandatory)

| Layer | Meaning | Entry |
|-------|---------|-------|
| custody | Vault keys | `vault.ts` |
| localState | Toolbox IndexedDB (managed change, baskets, remittance) | `session.ts` |
| chainIngest | Network → localState (Refresh) | `chainIngest.ts` → `refreshFromChain` |
| historyReplica | BRC-39 backup / multi-device | `deviceSync.ts`, `historyBackup.ts` |
| balanceView | Spendable from localState | `fetchBalanceSats` / `getBalanceView` |

- **Refresh** = chainIngest only. It will not restore P2P/managed-change history.
- **History backup** = historyReplica. That is how remittance / managed change leaves the device.
- **Recompose** = `recomposeWallet` (history then chain). Unlock / History restore / Pair Sync only — never Dashboard Refresh.
- Explicit **Refresh** may soft-pull newer BRC-39 when parity is configured (`softPullHistoryIfRemoteNewer`).
- Empty-local × remote overwrite is isolated in `historyEmptyGuard.ts` (auto paths refuse; manual Upload may force).
- Prefer `refreshFromChain` from `chainIngest.ts` — single entry for network → localState.
- Wallet-layer overlaps (chain ingest × spend × history × recompose) go through `walletCoordinator.ts` + `walletCoordinatorMachine.ts`.
- Items (including recursive inscription content) stay basket `1sat` — same remittance + BRC-39 path.
- BRC-150: `oneSatProvenance.ts` (build/verify v2; omit oversized remittance).
- BRC-153: `oneSatLatch.ts` + `docs/bsva/brcs/tokens/0153.md` — soft-latch sends live (tip 1 sat + latch **exactly 2** sats P2PKH, v3 remittance with OUTPUT:N refs). Receivers treat satoshis===2 as latch dust.
## Read first

| Topic | Path |
|-------|------|
| Aeon consumer rules | `.cursor/rules/aeon-ui.mdc` |
| BRC / migrate rules | `.cursor/rules/brc100-bsva.mdc` |
| Wallet layer SSoT | `src/wallet/layers.ts` |
| Aeon engine (upstream) | `~/AeonUI/AGENTS.md` |
| App overview | `README.md` |
| Versioning / releases | `VERSIONING.md` |

## Do not

- Add a second UI framework (Tailwind, shadcn, MUI, …).
- Invent a non–BRC-100 connect path for web apps.
- Change migrate APIs without updating `items-market` `src/lib/brc100/*` and docs.
- Treat missing cloud BRC-39 as “out of sync” with the chain, or treat Refresh as device history sync.

## Commands

```bash
npm run dev          # Vite + Electron
npm run launch:mac   # packaged Mac local run
npm run launch       # packaged Linux local run (Linux host)
npm run package:mac
# Linux AppImage: push tag vX.Y.Z → GitHub Actions Release Linux
```
