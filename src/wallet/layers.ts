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
 * - **Items (1sat / recursive)** → basket `1sat`; remittance + BRC-39 same as funds history.
 *   Recursive inscription *content* does not get a separate basket — tip→origin remittance does
 *   (BRC-150 in `oneSatProvenance.ts`; BRC-153 latched v3 in `oneSatLatch.ts`; oversized packages omitted).
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
    'brc100Handler.ts',
    'oneSatProvenance.ts',
    'oneSatLatch.ts',
    'sentItemGuard.ts',
    'pendingSend.ts',
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
    'deviceSync.ts',
    'cloudBackupHealth.ts',
    'historyEmptyGuard.ts',
    'recompose.ts',
  ],
  balanceView: ['session.ts#fetchBalanceSats', 'layers.ts#inspectLocalToolboxState'],
  health: ['walletHealth.ts', 'cloudBackupHealth.ts', 'backupStatus.ts'],
  coordinator: [
    'walletCoordinatorMachine.ts',
    'walletCoordinator.ts',
    'spendGuard.ts',
    'spendLease.ts',
  ],
} as const satisfies Record<WalletLayer | 'coordinator', readonly string[]>

/**
 * Composed recovery entry — prefer over calling history + chain separately.
 * Isolated from Refresh: do not call from Dashboard / spend heal.
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
      actionCount: 0,
      looksEmpty: true,
    }
  }

  const [spendableSats, defaultOutputCount, oneSatOutputCount, actionCount] = await Promise.all([
    fetchBalanceSats(active.wallet).catch(() => 0),
    countOutputs('default'),
    countOutputs('1sat'),
    countActions(),
  ])

  const looksEmpty =
    spendableSats <= 0 &&
    defaultOutputCount <= 0 &&
    oneSatOutputCount <= 0 &&
    actionCount <= 0

  return {
    spendableSats,
    defaultOutputCount,
    oneSatOutputCount,
    actionCount,
    looksEmpty,
  }
}

export async function localToolboxStateLooksEmpty(): Promise<boolean> {
  return (await inspectLocalToolboxState()).looksEmpty
}
