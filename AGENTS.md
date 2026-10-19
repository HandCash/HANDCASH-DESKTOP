# HandCash Desktop — agent instructions

**Audience:** Cursor, Claude Code, Copilot, and other coding agents.  
**Product:** Official HandCash Desktop wallet (BETA) — self-custodial BRC-100 bridge + Aeon UI.

## Three parts

`src/` is **`@handcash/wallet-ui`** (shared with Mobile). Electron is the Desktop shell only — never fork wallet panels into `HANDCASH-MOBILE`. See workspace `docs/handcash-three-parts.md`.

## North stars

1. **UI = Aeon** — chart before JSX. Layers: domain → tagged path → machine → `stateToAttr` → `@aeon-ui/react` → `handcash.css`. Screen steps are XState events, not `useState` flags. Gate: `.cursor/rules/aeon-ui.mdc`. Catalog: `src/machines/machineManifest.ts`. Ratchet: `src/machines/aeonAdherence.test.ts` (do not grow the allowlist).
2. **Protocol = BRC-100 / BSVA** — local HTTP bridge, origin permissions, mirrored migrate contract. See `.cursor/rules/brc100-bsva.mdc`.
3. **Wallet layers** — do not conflate chain ingest with BRC-39 history. See `src/wallet/layers.ts`.

## Wallet layers (mandatory)

| Layer | Meaning | Entry |
|-------|---------|-------|
| custody | Vault keys | `vault.ts` |
| localState | Toolbox IndexedDB (managed change, baskets, remittance) | `session.ts` |
| chainIngest | Network → localState (Refresh) | `chainIngest.ts` → `refreshFromChain` |
| historyReplica | BRC-39 backup / multi-device | `deviceSync.ts`, `historyBackup.ts` |
| balanceView | Spendable from localState | `fetchBalanceSats` / `inspectLocalToolboxState` |

- **Refresh** = chainIngest only. It will not restore P2P/managed-change history.
- **History backup** = historyReplica. That is how remittance / managed change leaves the device.
- **Recompose** = `recomposeWallet` (history then chain). Unlock / History restore / Pair Sync only — never Dashboard Refresh.
- No same-key device parity: one install per identity. There is no cross-device spend lease and Refresh never pulls BRC-39; the History backup URL is backup + empty-local recovery only.
- Devices share a vault by **holding different accounts** (BRC-208 / BRC-249 draft, `docs/bsva/brcs/wallet/0249.md`): `accountHolding.ts` / `vaultAccountHolding.ts`. An account held elsewhere is never signed with or given spendable state; the spend guard reads holding locally. A signed `holder.json` beside each account's BRC-39 blob changes only on reserve (create-only), take and release.
- **Moving is automatic, not a UX flow.** Choosing an account "On another device" runs `moveAccountHere` (`accountMove.ts`, chart `accountMoveMachine`); the menu only shows progress. Never add a prompt, a Take over confirm or a manual Move button back. **Moves go device to device**: every unlocked install keeps a vault link (`vaultLink.ts`, BRC-246 v2 data channel on the vault identity, signals in box `vault-link`) to the installs its holder records name. The mover sends the signed `release-request` (`accountRelease.ts`) over the link to the holding device and the accept comes back on it; box `account-holding` carries them only when no link opens in 8 s or a frame is not acked (chart states `dialing` → `requestingDirect` → `requestingBox`). A live holder accepts without asking, then releases: the open account flushes history (`releaseActiveVaultAccount`), an account held but not open writes `released` and hands over (`releaseIdleVaultAccount`). No accept within 10 s (or no release within 2 min of an accept) = holder offline → forced take, no prompt. A request that cannot be sent fails the move; it never forces. The holder service (`startHoldingService`) serves the vault link and every held account's box every 5 s; a link request must name the device the link authenticated. Accounts held elsewhere are never opened, signed with or ACKed for.
- **Check after every gap.** Local holding is trusted only while the install has stayed running and connected since its last check (`holdingFreshness.ts`). Start, lock, switch, `online`, or a serve pause over 15 s (suspension) is a gap; `spendGuard` calls `ensureHoldingFresh`, one record read per gap — the only network read allowed on the spend path. Host unreachable → keep local holding and spend.
- **Hand over, never overwrite.** An install that finds an account it held taken elsewhere must not upload its backup (`uploadBrc39Backup` refuses) or broadcast its never-broadcast transactions. `accountHandover.ts` stops the monitor, exports the BRC-38 delta of `(lastUploadedAt, displacedAt]` without unbroadcast rows, tombstones their BRC-29 notices in the notice journal and pushes it (the `owed` entry carries the BEEF; the handover waits until the push lands), voids those transactions, and sends it BRC-78 sealed to self in `handover` parts (durable pending list, retried each serve tick). The holder merges with `importBRC38` merge and ACKs only after the merge.
- Empty-local × remote overwrite is isolated in `historyEmptyGuard.ts` (auto paths refuse; manual Upload may force).
- Prefer `refreshFromChain` from `chainIngest.ts` — single entry for network → localState.
- Wallet-layer overlaps (chain ingest × spend × history × recompose) go through `walletCoordinator.ts` + `walletCoordinatorMachine.ts`.
- Items (including recursive inscription content) stay basket `1sat` — same remittance + BRC-39 path.
- BRC-150: `oneSatProvenance.ts` fully verifies/rebuilds v2 ancestry, every exact parent spend, one-sat continuity, AtomicBEEF subject, and the origin `ord` envelope; oversized/incomplete proofs are omitted. **Remittance is local basket metadata** — it does not ride a P2PKH lock to peers.
- Authenticity order is fixed in `oneSatAuthenticity.ts`: complete BRC-150 → indexer identity marked `unproven`. Legacy `brc156` cache pins display as BRC-150. Never promote indexer data or marker-only scripts to proven.
- Soft-latch (BRC-156) is **withdrawn** — do not revive `oneSatLatch*` / `softLatchSendMachine`. Item identity is BRC-150 remittance only. Advertise `147`+`150` only.
- Messagebox: BRC-33 store-and-forward by identity key — optional chat/notify, never custody. Prefer resolved peer `messagebox` URL; BRC-CLOUD is the convenience fallback. Plan: `docs/wallet-p2p-messagebox.md`.
## Read first

| Topic | Path |
|-------|------|
| Aeon consumer rules | `.cursor/rules/aeon-ui.mdc` |
| BRC / migrate rules | `.cursor/rules/brc100-bsva.mdc` |
| Wallet layer SSoT | `src/wallet/layers.ts` |
| P2P / remittance / messagebox | `docs/wallet-p2p-messagebox.md` |
| Coins of other chains, swaps, wrapping (held back from BSVA) | `docs/bsva/brcs/coins/README.md` |
| Aeon engine (vendored) | `vendor/aeon-ui-engine/CONSUMER.md` |
| Aeon engine (upstream, if cloned) | `~/AeonUI/AGENTS.md` |
| App overview | `README.md` |
| Versioning / releases | `VERSIONING.md` |

## Do not

- Add a second UI framework (Tailwind, shadcn, MUI, …).
- Invent a non–BRC-100 connect path for web apps.
- Change migrate APIs without updating `items-market` `src/lib/brc100/*` and docs (legacy `/migrate` site — not BRC-MARKET).
- Open `items-market` for storefront work. Live market is `handcash-market/` (`HandCash/BRC-MARKET`); wallet list/buy/settle is `src/wallet/market*`.
- Treat missing cloud BRC-39 as “out of sync” with the chain, or treat Refresh as device history sync.

## Commands

```bash
npm run dev          # Vite + Electron
npm run launch:mac   # packaged Mac local run
npm run launch       # packaged Linux local run (Linux host)
npm run package:mac
npm run brc:map # Jev: every wallet feature → BRC, plus features that need one → docs/brc-coverage.md
# Linux AppImage: push tag vX.Y.Z → GitHub Actions Release Linux
```
