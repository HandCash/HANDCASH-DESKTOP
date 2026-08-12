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
 * balanceView    what UI shows (spendable from localState; never legacy-unimported alone)
 * health         chain ingest health ⊕ history replica health ⊕ bridge
 * coordinator    walletCoordinatorMachine — legal overlaps between layers (UTXO safety)
 * ```
 *
 * Glossary:
 * - **Refresh** → `chainIngest` only (`refreshFromChain`). Does not pull BRC-39.
 * - **History backup / Sync devices** → `historyReplica` (`deviceSync` / `historyBackup`).
 * - **Recompose** → historyReplica then chainIngest (`recomposeWallet`) — restore a device.
 * - **Legacy address** → receive P2PKH UTXOs not yet swept into managed change.
 * - **Managed change / P2P outs** → live only in `localState` until exported via BRC-39.
 * - **Items (1sat / recursive)** → basket `1sat` in `localState`.
 *   - **BRC-150 remittance** (`oneSatProvenance.ts`) — tip→origin proof in
 *     `customInstructions`; **wallet-local**, does not ride a P2PKH lock to peers.
 *   - **Soft-latch state** (`oneSatLatch.ts`) — OP_RETURN on soft-latch settle (`BRC156` marker, BRC withdrawn);
 *     **this** is peer-visible item identity (origin/name). Soft-latch receive must
 *     not use an ordinal indexer for naming.
 *   - **Self-send** keeps the settle Atomic BEEF locally (`beefCache`) so the next
 *     spend does not wait on an indexer; a stuck latch falls back to tip-only.
 *     Failed sends must not ghost-relinquish the tip (that burned 1-sats).
 *   - Oversized remittance packages are omitted (fail unproven), never truncated.
 * - **Messagebox** → BRC-33 store-and-forward by identity key (chat/notify). Optional;
 *   not custody. BRC-CLOUD hosts a convenience box; resolve may return any box URL.
 * - **Peer BSV pay (BRC-29)** → HandCash↔HandCash tip/pay/Send-to-friend: sender
 *   signs (`noSend`) and delivers Atomic BEEF + remittance to the payee; the
 *   **payee** internalizes and broadcasts. Sender broadcasts only if delivery
 *   fails. Self-pay internalizes + broadcasts locally. Plain address P2PKH
 *   remains for external/pasted addresses (`sendPayment.ts` + scan).
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
    'brc100Handler.ts',
    'oneSatProvenance.ts',
    'oneSatLatch.ts',
    'authenticityMachine.ts',
    'collectableSendMachine.ts',
    'softLatchSendMachine.ts',
    'bsvSendMachine.ts',
    'collectableTipKind.ts',
    'collectableOwnershipFate.ts',
    'sentItemGuard.ts',
    'pendingSend.ts',
    'sendPayment.ts',
    'sendBrc29Payment.ts',
    'ingestPaymentByTxid.ts',
    'inscriptionCache.ts',
    'provenCache.ts',
  ],
  chainIngest: [
    'chainIngest.ts',
    'ingestLegacyAddress.ts',
    'legacyScan.ts',
    'oneSatImport.ts',
    'legacyImportGuard.ts',
    'oneSatImportGuard.ts',
    'staleOutputRelease.ts',
  ],
  historyReplica: [
    'historyBackup.ts',
    'walletSetupApply.ts',
    'deviceSync.ts',
    'cloudBackupHealth.ts',
    'historyEmptyGuard.ts',
    'recompose.ts',
  ],
  balanceView: ['session.ts#fetchBalanceSats', 'layers.ts#inspectLocalToolboxState'],
  health: ['walletHealth.ts', 'cloudBackupHealth.ts', 'backupStatus.ts', 'walletRuntimeStatus.ts'],
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
    if (Number.isFinite(result.totalOutputs)) return Math.max(0, Math.trunc(result.totalOutputs))
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

  const [spendableSats, defaultOutputCount, oneSatOutputCount, bsv21OutputCount, actionCount] =
    await Promise.all([
      fetchBalanceSats(active.wallet).catch(() => 0),
      countOutputs('default'),
      countOutputs('1sat'),
      countOutputs('bsv21'),
      countActions(),
    ])

  // 1sat / bsv21 from address scan alone are not historyReplica. After restore,
  // chain ingest can land soft-latch dust before BRC-39 pull — those outs must
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
