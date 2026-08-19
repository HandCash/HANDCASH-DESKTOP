/**
 * Wallet layers — HandCash Desktop SSoT for how funds exist on a device.
 *
 * Do not treat these as one “sync”. Refresh, Backup, and Restore are different layers.
 *
 * ```
 * custody        vault keys (BRC-75 / BRC-140) — durable, origin-independent
 * localState     toolbox IndexedDB — managed change, baskets, remittance / customInstructions
 * chainIngest    network → localState (spendable review + legacy P2PKH + 1sat import)
 * historyReplica BRC-39 blob — replica of localState for recovery / multi-device
 *              + write-once on-device archive under userData/brc39-archive (never overwritten)
 * balanceView    what UI shows: owned cash = spendable managed change
 *                + unconfirmed change of live local sends (never payment outs,
 *                never 1sat / bsv21). See `balanceView.ts`.
 * health         chain ingest health ⊕ history replica health ⊕ bridge
 * coordinator    walletCoordinatorMachine — legal overlaps between layers (UTXO safety)
 * ```
 *
 * Glossary:
 * - **Refresh** → `chainIngest` only (`refreshFromChain`). Does not pull BRC-39.
 * - **History backup / Sync devices** → `historyReplica` (`deviceSync` / `historyBackup`).
 * - **Linked devices** → identity link + sealed mutual key backups (`deviceWallets` /
 *   `deviceKeyBackup`). Different keys OK; cold spare only — not a shared spend pot.
 * - **Recompose** → historyReplica then chainIngest (`recomposeWallet`) — restore a device.
 * - **Legacy address** → receive P2PKH UTXOs not yet swept into managed change.
 * - **Managed change / P2P outs** → live only in `localState` until exported via BRC-39.
 * - **Items (1sat / recursive)** → basket `1sat` in `localState`.
 *   - **BRC-150 remittance** (`oneSatProvenance.ts`) — tip→origin proof in
 *     `customInstructions`; **wallet-local**, does not ride a P2PKH lock to peers.
 *     This is the *only* item authenticity/identity model — there is no on-chain
 *     latch companion (BRC-156 was withdrawn and fully removed).
 *   - **Self-send** keeps the settle Atomic BEEF locally (`beefCache`) so the next
 *     spend does not wait on an indexer.
 *     Failed sends must not ghost-relinquish the tip (that burned 1-sats).
 *   - **Item P2P settle** (`itemSettlePath.ts` + `itemSendMachine`): sender
 *     signs `noSend` and classifies once — `peerDeliver` (Atomic BEEF to peer;
 *     **payee** broadcasts), `selfReceive`, or `externalBroadcast` (pasted
 *     address). There is no broadcast-then-notify path; `peerDeliver` has no
 *     sender-broadcast edge. After inbox delivery, sender silently `postBeef`
 *     (`confirmBroadcast`) so the tx is on-chain even if the payee never
 *     broadcasts. A user retry re-enters `confirmBroadcast` with the same signed
 *     BEEF only when the original tip remains unspent; it never creates a
 *     competing spend. Remittance ± inline BEEF on `sendMessage`.
 *   - Oversized remittance packages are omitted (fail unproven), never truncated.
 * - **Messagebox** → BRC-33 store-and-forward by identity key (chat/notify). Optional;
 *   not custody. BRC-CLOUD hosts a convenience box; resolve may return any box URL.
 * - **Peer BSV pay (BRC-29)** → `brc29SettlePath` + `brc29SendMachine`. Sender
 *   `createAction` broadcasts immediately (Babbage / toolbox). Remittance
 *   (± inline Atomic BEEF) then goes on `sendMessage`. Inbox miss → local
 *   outbox retry, never a second payment. Inbox is not ACKed until ingest
 *   succeeds. Same-identity still notifies our box so other devices ingest.
 *   `/files` is not the payment path (Android WebView). Plain address P2PKH
 *   remains for external/pasted addresses (`sendPayment.ts` + `bsvSendMachine`).
 * - **Dual-layer confirmation** → `txLifecycle` / `utxoLockManager` /
 *   `dualLayerSend` / `txReconcile`. Optimistic soft-locks + ARC status sit
 *   beside settle-path machines; hard finality is MINED only after SPV-verified
 *   BUMP. Overlay uses BRC-38 `spendable` / `spentBy` so coins are hidden
 *   without deleting toolbox rows (`lockOwnerId` is a local send reservation).
 *   Refresh never asks the indexer `isUtxo` to resurrect coins — only change of
 *   a live local tx is restored, and inputs of those txs are re-hidden.
 *   Never treat HTTP 200 / postBeef accept as mined. Activity never drops a signed send
 *   until every one of its inputs is spent on chain — clearing history is not a
 *   cancel, and it keeps that tx's change.
 * - **Change consolidation** → `changeConsolidationPath` (tagged-union decision) +
 *   `consolidateChange`. Many small BRC-29 receives fragment the managed-change
 *   pool and slow `createAction` coin selection. A rate-limited background pass
 *   collapses spendable change into one UTXO via a self-payment using the toolbox
 *   `maxPossibleSatoshis` output (same primitive as `Wallet.sweepTo`, aimed at
 *   self). It runs in the exclusive spend region so it never races a send, yields
 *   when a spend is waiting, and only ever selects change — assets (`1sat`,
 *   `bsv21`) live in their own baskets and are never touched.
 * - **Tokens (BSV-21)** → basket `bsv21`; listed under Collect, never in Pay / balanceView.
 *   Holders verify their tips; issuer mint policy is trusted (no global supply-cap proof required).
 */

import { fetchBalanceSats, getActiveWallet } from './session'

/** Named layers — use in comments, health aggregates, and new APIs. */
export type WalletLayer =
  | 'custody'
  | 'localState'
  | 'chainIngest'
  | 'historyReplica'
  | 'balanceView'
  | 'health'

/** Canonical module map for agents and reviews. */
export const WALLET_LAYER_MODULES = {
  custody: ['vault.ts', 'sessionBackupAuth.ts'],
  localState: [
    'session.ts',
    'collectables.ts',
    'fungibles.ts',
    'bsv21.ts',
    'bsv21TipKind.ts',
    'bsv21Inscribe.ts',
    'bsv21SendMachine.ts',
    'sendFungible.ts',
    'brc100Handler.ts',
    'oneSatProvenance.ts',
    'authenticityMachine.ts',
    'collectableSendMachine.ts',
    'itemSendMachine.ts',
    'spendAttempt.ts',
    'itemSettlePath.ts',
    'ingestItemSettle.ts',
    'ingestFungibleSettle.ts',
    'bsvSendMachine.ts',
    'brc29SettlePath.ts',
    'brc29SendMachine.ts',
    'collectableTipKind.ts',
    'collectableOwnershipFate.ts',
    'sentItemGuard.ts',
    'pendingSend.ts',
    'sendPayment.ts',
    'sendBrc29Payment.ts',
    'ingestPaymentByTxid.ts',
    'inscriptionCache.ts',
    'provenCache.ts',
    'txLifecycle.ts',
    'txLifecycleMachine.ts',
    'txStore.ts',
    'utxoLifecycle.ts',
    'utxoLockManager.ts',
    'protocolValidate.ts',
    'arcStatusMap.ts',
    'spvFinality.ts',
    'dualLayerSend.ts',
  ],
  chainIngest: [
    'chainIngest.ts',
    'ingestLegacyAddress.ts',
    'legacyScan.ts',
    'legacySweepPath.ts',
    'legacyStuckSweep.ts',
    'legacyReceiptActivity.ts',
    'ordinalMigratePath.ts',
    'changeConsolidationPath.ts',
    'consolidateChange.ts',
    'oneSatImport.ts',
    'asyncPool.ts',
    'legacyImportGuard.ts',
    'oneSatImportGuard.ts',
    'staleOutputRelease.ts',
    'txReconcile.ts',
  ],
  historyReplica: [
    'historyBackup.ts',
    'walletSetupApply.ts',
    'deviceSync.ts',
    'deviceWallets.ts',
    'deviceKeyBackup.ts',
    'phraseSweep.ts',
    'cloudBackupHealth.ts',
    'historyEmptyGuard.ts',
    'recompose.ts',
  ],
  balanceView: [
    'balanceView.ts',
    'session.ts#fetchBalanceSats',
    'layers.ts#inspectLocalToolboxState',
  ],
  health: [
    'walletHealth.ts',
    'cloudBackupHealth.ts',
    'backupStatus.ts',
    'walletRuntimeStatus.ts',
  ],
  coordinator: [
    'walletCoordinatorMachine.ts',
    'walletCoordinator.ts',
    'spendGuard.ts',
    'spendLease.ts',
  ],
} as const satisfies Record<WalletLayer | 'coordinator', readonly string[]>

/**
 * Composed recovery entry — prefer over calling history + chain separately.
 * Isolated from Refresh: do not call from Dashboard / spend paths.
 */
export const RECOMPOSE_MODULE = 'recompose.ts' as const

/** Empty-local × remote clobber predicate — unit-tested in isolation. */
export const HISTORY_EMPTY_GUARD_MODULE = 'historyEmptyGuard.ts' as const

/**
 * Snapshot of toolbox IndexedDB richness — not the same as spendable balance.
 * A fully spent wallet can still have actions + remittance metadata that BRC-39 must keep.
 */
export type LocalToolboxState = {
  spendableSats: number
  defaultOutputCount: number
  oneSatOutputCount: number
  /** BSV-21 tips in basket `bsv21` — Collect tokens, not Pay balance. */
  bsv21OutputCount: number
  actionCount: number
  /** True only when there is nothing worth restoring/pushing as history. */
  looksEmpty: boolean
}

async function countOutputs(basket: string): Promise<number> {
  const active = getActiveWallet()
  if (!active) return 0
  try {
    const result = await active.wallet.listOutputs({ basket, limit: 1 })
    if (Number.isFinite(result.totalOutputs))
      return Math.max(0, Math.trunc(result.totalOutputs))
    return result.outputs?.length ?? 0
  } catch {
    return 0
  }
}

async function countActions(): Promise<number> {
  const active = getActiveWallet()
  if (!active) return 0
  try {
    const result = await active.wallet.listActions({ labels: [], limit: 1 })
    const total = (result as { totalActions?: number }).totalActions
    if (Number.isFinite(total)) return Math.max(0, Math.trunc(total!))
    return (result as { actions?: unknown[] }).actions?.length ?? 0
  } catch {
    return 0
  }
}

/** Inspect toolbox localState (IndexedDB). Prefer this over balance for BRC-39 empty checks. */
export async function inspectLocalToolboxState(): Promise<LocalToolboxState> {
  const active = getActiveWallet()
  if (!active) {
    return {
      spendableSats: 0,
      defaultOutputCount: 0,
      oneSatOutputCount: 0,
      bsv21OutputCount: 0,
      actionCount: 0,
      looksEmpty: true,
    }
  }

  const [
    spendableSats,
    defaultOutputCount,
    oneSatOutputCount,
    bsv21OutputCount,
    actionCount,
  ] = await Promise.all([
    fetchBalanceSats(active.wallet).catch(() => 0),
    countOutputs('default'),
    countOutputs('1sat'),
    countOutputs('bsv21'),
    countActions(),
  ])

  // 1sat / bsv21 from address scan alone are not historyReplica. After restore,
  // chain ingest can land item tips before BRC-39 pull — those outs must
  // not block empty-local recovery of spendable balance + TX history.
  const looksEmpty =
    spendableSats <= 0 && defaultOutputCount <= 0 && actionCount <= 0

  return {
    spendableSats,
    defaultOutputCount,
    oneSatOutputCount,
    bsv21OutputCount,
    actionCount,
    looksEmpty,
  }
}

export async function localToolboxStateLooksEmpty(): Promise<boolean> {
  return (await inspectLocalToolboxState()).looksEmpty
}
