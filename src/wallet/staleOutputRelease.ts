/**
 * Writing off spendable outputs — the only path allowed to do it.
 *
 * `reviewSpendableOutputs(all, release)` decides an output is dead through
 * `services.isUtxo`, which returns `or.isUtxo === true`. An indexer that has not
 * seen our unconfirmed change and a UTXO service that errored both answer
 * `false`, and `release` then sets `spendable: false` permanently. So a bulk
 * release run on a schedule destroys live coins, which is why chain ingest only
 * ever audits (see `chainIngest.auditSpendableOutputs`).
 *
 * A node rejecting a spend because an input is already spent is different: that
 * is affirmative evidence our set is stale, and it is the only trigger for the
 * release here.
 */
import { parseOutpoint } from './legacyScan'
import { getActiveWallet } from './session'
import {
  creditUtxo,
  hideUtxo,
  isUtxoBlockedFromRestore,
} from './utxoLockManager'
import {
  inputOutpointsFromAtomicBeef,
  inputOutpointsFromRawTx,
  outpointFromOutput,
} from './txOutpoints'
import { shouldYieldChainIngestToSpend } from './walletCoordinator'
import {
  classifyChangeScript,
  hasLockingScript,
  sweepChangeScripts,
  type ChangeRow,
} from './changeScriptFate'

/** Toolbox statuses that mean this wallet already committed the tx locally. */
const LIVE_LOCAL_TX = new Set([
  'sending',
  'unproven',
  'completed',
  'nosend',
  'nonfinal',
  'unfail',
])

type TxStatusRow = { status?: string; rawTx?: number[]; txid?: string }

function positiveId(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** True when a local transaction is still this wallet's spend — not failed/abandoned. */
export function isLiveLocalTxStatus(status: unknown): boolean {
  return LIVE_LOCAL_TX.has(String(status ?? '').toLowerCase())
}

/** Cap restore work so a huge dead set cannot stall unlock/refresh. */
const RESTORE_MAX = 200

/** The toolbox rejects `undefined` partial filters on some storage backends. */
export function isUndefinedPartialFilterError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes('must be not undefined') ||
    message.includes('Passing undefined as a filter value is not supported')
  )
}

/** True only for a rejection that proves an input is spent or gone. */
export function isAlreadySpentInputError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('missing inputs') ||
    message.includes('missingorspent') ||
    message.includes('mempool-conflict') ||
    message.includes('already spent') ||
    message.includes('double spend') ||
    message.includes('doublespend')
  )
}

/**
 * Wallet storage marked an input unspendable (failed createAction / signAction
 * that did not roll back). Not proof the UTXO is gone on-chain — do **not**
 * {@link releaseStaleSpendableOutputs}; abort + unfail instead.
 */
export function isNoLongerSpendableError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    message.includes('no longer spendable') ||
    (message.includes('werr_invalid_operation') && message.includes('spendable'))
  )
}

/**
 * Write off outputs the network refuses to spend. Prefer
 * {@link hideSpentOutpoints} with the rejected tx's inputs — a bulk review
 * treats unseen unconfirmed change as dead and hides live coins.
 *
 * @returns how many outputs were released.
 */
export async function releaseStaleSpendableOutputs(): Promise<number> {
  const active = getActiveWallet()
  if (!active) return 0
  try {
    let result
    try {
      result = await active.wallet.reviewSpendableOutputs(true, true)
    } catch (err) {
      if (!isUndefinedPartialFilterError(err)) throw err
      result = await active.wallet.reviewSpendableOutputs(false, true)
    }
    const outputs = Array.isArray(result.outputs) ? result.outputs : []
    const outpoints = outputs
      .map((row) => outpointFromOutput(row as { txid?: unknown; vout?: unknown }))
      .filter((op): op is string => Boolean(op))
    if (outpoints.length > 0) await hideSpentOutpoints(outpoints)
    if (outputs.length > 0) {
      console.info(
        `[stale-output] released ${outputs.length} output(s) the network rejected as spent`,
      )
    }
    return outputs.length
  } catch (err) {
    console.warn('[stale-output] release failed', err)
    return 0
  }
}

/**
 * After already-spent: hide those inputs, keep this tx's change, restore only
 * live local change — never a bulk indexer rewrite of the spendable set.
 */
export async function onAlreadySpentSend(args: {
  txid?: string
  atomic?: number[]
}): Promise<void> {
  const txid = args.txid?.trim().toLowerCase()
  let inputs: string[] = []
  if (txid && args.atomic?.length) {
    inputs = inputOutpointsFromAtomicBeef(args.atomic, txid)
  }
  if (txid && inputs.length === 0) {
    const raw = await loadLocalRawTx(txid)
    if (raw?.length) inputs = inputOutpointsFromRawTx(raw)
  }
  if (inputs.length > 0) {
    const hidden = await hideSpentOutpoints(inputs)
    console.info(
      `[stale-output] hid ${hidden} already-spent input(s) without deleting them`,
    )
  }
  if (txid) await keepChangeOfSignedTx(txid)
  await restoreLiveSpendableOutputs({ onlyLiveChange: true })
}

/** @deprecated Use {@link onAlreadySpentSend} so live change is not bulk-released. */
export async function releaseThenRestoreStaleOutputs(): Promise<void> {
  await restoreLiveSpendableOutputs({ onlyLiveChange: true })
}

/**
 * Hide these outpoints as `spent` and mark toolbox rows unspendable. The
 * storage row stays — Pay / restore skip `spent` overlay status.
 */
export async function hideSpentOutpoints(outpoints: string[]): Promise<number> {
  const unique = [...new Set(outpoints.map((o) => o.trim()).filter(Boolean))]
  if (unique.length === 0) return 0
  for (const op of unique) {
    hideUtxo(op, { spentBy: '', diagnostic: 'already-spent' })
  }
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage?.runAsStorageProvider) {
    return unique.length
  }
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      for (const op of unique) {
        const parsed = parseOutpoint(op)
        if (!parsed) continue
        const rows = await findOutputsForTxid(sp, parsed.txid)
        const match = rows.find((row) => Number(row.vout ?? row.outputIndex) === parsed.vout)
        const outputId = positiveId(match?.outputId)
        if (outputId == null) continue
        try {
          await sp.updateOutput(outputId, { spendable: false })
        } catch (err) {
          console.warn('[stale-output] hide spendable=false skipped', op, err)
        }
      }
    })
  } catch (err) {
    console.warn('[stale-output] hide toolbox rows skipped', err)
  }
  return unique.length
}

/**
 * Credit this signed tx's change even when the creator was marked failed and
 * the indexer 404s the txid. Clearing a send that later shows on chain used
 * to leave change `spendable: false` forever.
 */
export async function keepChangeOfSignedTx(txid: string): Promise<number> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return 0
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage?.runAsStorageProvider) return 0

  try {
    return (await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      const rows = await findOutputsForTxid(sp, id)
      let kept = 0
      for (const row of rows) {
        const outputId = positiveId(row.outputId)
        const outpoint = outpointFromOutput(row)
        if (outputId == null || !outpoint) continue
        if (positiveId(row.spentBy) != null) continue
        const basket = String(row.basket ?? '').toLowerCase()
        if (basket === '1sat' || basket === 'bsv21') continue
        const sats = Math.max(0, Math.trunc(Number(row.satoshis) || 0))
        const isChange = row.change === true || sats > 1
        if (!isChange) continue

        const healed = await healLockingScript(sp, row)
        const scripted = healed != null || hasLockingScript(row)
        if (!scripted) continue

        await sp.updateOutput(outputId, {
          spendable: true,
          spentBy: undefined,
          ...(healed != null ? { lockingScript: healed } : {}),
        })
        creditUtxo(outpoint, { satoshis: sats })
        kept += 1
      }
      if (kept > 0) {
        console.info(
          `[stale-output] kept ${kept} change output(s) of ${id.slice(0, 12)}`,
        )
      }
      return kept
    })) as number
  } catch (err) {
    console.warn('[stale-output] keep change skipped', id.slice(0, 12), err)
    return 0
  }
}

async function loadLocalRawTx(txid: string): Promise<number[] | null> {
  const storage = getActiveWallet()?.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  try {
    const found = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      if (typeof sp.getProvenOrRawTx !== 'function') return undefined
      return sp.getProvenOrRawTx(txid)
    })
    const raw = found?.rawTx
    return Array.isArray(raw) && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

async function findOutputsForTxid(
  sp: { findOutputs?: (args: unknown) => Promise<unknown> },
  txid: string,
): Promise<Array<ChangeRow & { outputIndex?: number; basket?: string; spentBy?: number }>> {
  if (typeof sp.findOutputs !== 'function') return []
  try {
    const rows = await sp.findOutputs({
      partial: { txid },
      paged: { limit: 50, offset: 0 },
    })
    return Array.isArray(rows) ? (rows as never) : []
  } catch (err) {
    if (!isUndefinedPartialFilterError(err)) {
      console.warn('[stale-output] findOutputs by txid skipped', err)
    }
    return []
  }
}

type LocalStorage = {
  updateOutput: (outputId: number, update: Record<string, unknown>) => Promise<unknown>
  findOutputs?: (args: unknown) => Promise<unknown>
  findTransactions?: (args: unknown) => Promise<TxStatusRow[] | undefined>
  getProvenOrRawTx?: (txid: string) => Promise<{ rawTx?: number[] } | undefined>
}

async function loadTxRow(
  sp: LocalStorage,
  transactionId: number,
  cache: Map<number, TxStatusRow | null>,
): Promise<TxStatusRow | null> {
  if (cache.has(transactionId)) return cache.get(transactionId) ?? null
  if (typeof sp.findTransactions !== 'function') {
    cache.set(transactionId, null)
    return null
  }
  try {
    const rows = await sp.findTransactions({
      partial: { transactionId },
      noRawTx: true,
      paged: { limit: 1, offset: 0 },
    })
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null
    cache.set(transactionId, row)
    return row
  } catch (err) {
    console.warn('[stale-output] tx lookup skipped', transactionId, err)
    cache.set(transactionId, null)
    return null
  }
}

async function healLockingScript(
  sp: LocalStorage,
  output: ChangeRow,
): Promise<number[] | null> {
  if (hasLockingScript(output)) return null
  const txid = String(output.txid ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid) || typeof sp.getProvenOrRawTx !== 'function') {
    return null
  }
  try {
    const local = await sp.getProvenOrRawTx(txid)
    const fate = classifyChangeScript(output, local?.rawTx?.length ? local.rawTx : null)
    return fate.kind === 'heal' ? fate.lockingScript : null
  } catch (err) {
    console.warn('[stale-output] change script heal skipped', txid.slice(0, 12), err)
    return null
  }
}

/**
 * After createAction the inputs are this wallet's spent coins and the change is
 * already in storage. Rebuild locking scripts from the local raw tx so the next
 * send can select that change before any indexer has seen the payment.
 */
export async function sealLocalSpendChange(): Promise<void> {
  await sweepChangeScripts({ fromChain: false })
}

const REHIDE_TX_LIMIT = 40

function txidFromRow(row: { txid?: unknown }): string | null {
  const txid = String(row.txid ?? '')
    .trim()
    .toLowerCase()
  return /^[0-9a-f]{64}$/.test(txid) ? txid : null
}

/**
 * Hide inputs of this wallet's live local spends. Restore used to trust
 * indexer `isUtxo` and flip spent coins back to spendable (and clear
 * `spentBy`) — that inflated Pay and made the next send hang on dead coins.
 */
export async function rehideInputsOfLiveLocalTxs(): Promise<number> {
  if (shouldYieldChainIngestToSpend()) return 0
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage || typeof storage.runAsStorageProvider !== 'function') return 0

  const inputs = new Set<string>()
  try {
    await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as unknown as LocalStorage
      if (typeof sp.findTransactions !== 'function') return
      let rows: TxStatusRow[] = []
      try {
        rows =
          (await sp.findTransactions({
            partial: {},
            status: [...LIVE_LOCAL_TX],
            noRawTx: false,
            paged: { limit: REHIDE_TX_LIMIT, offset: 0 },
          })) ?? []
      } catch (err) {
        if (!isUndefinedPartialFilterError(err)) {
          console.warn('[stale-output] live-tx list skipped', err)
        }
        for (const status of LIVE_LOCAL_TX) {
          if (shouldYieldChainIngestToSpend()) return
          try {
            const batch = await sp.findTransactions({
              partial: { status },
              noRawTx: false,
              paged: { limit: 15, offset: 0 },
            })
            if (Array.isArray(batch)) rows.push(...batch)
          } catch (inner) {
            console.warn('[stale-output] live-tx list skipped', status, inner)
          }
        }
      }
      for (const row of rows.slice(0, REHIDE_TX_LIMIT)) {
        if (shouldYieldChainIngestToSpend()) return
        let raw = Array.isArray(row.rawTx) && row.rawTx.length > 0 ? row.rawTx : null
        const txid = txidFromRow(row)
        if (!raw && txid && typeof sp.getProvenOrRawTx === 'function') {
          try {
            const found = await sp.getProvenOrRawTx(txid)
            raw = Array.isArray(found?.rawTx) && found.rawTx.length > 0 ? found.rawTx : null
          } catch {
            raw = null
          }
        }
        if (!raw) continue
        for (const op of inputOutpointsFromRawTx(raw)) inputs.add(op)
      }
    })
  } catch (err) {
    console.warn('[stale-output] rehide live inputs skipped', err)
    return 0
  }
  if (inputs.size === 0) return 0
  const hidden = await hideSpentOutpoints([...inputs])
  if (hidden > 0) {
    console.info(
      `[stale-output] rehid ${hidden} input(s) of live local spends so they stay unspendable`,
    )
  }
  return hidden
}

async function loadUnspendableChange(
  // Method syntax on purpose: the toolbox signature is narrower than `unknown`,
  // and only a bivariant position accepts it.
  storage: { findOutputs(args: unknown): Promise<unknown[] | undefined> },
): Promise<unknown[]> {
  try {
    const change = await storage.findOutputs({
      partial: { spendable: false, change: true },
      paged: { limit: RESTORE_MAX, offset: 0 },
    })
    if (Array.isArray(change)) return change
  } catch (err) {
    if (!isUndefinedPartialFilterError(err)) {
      console.warn('[stale-output] change-row lookup skipped', err)
    }
  }
  try {
    const dead = await storage.findOutputs({
      partial: { spendable: false },
      paged: { limit: RESTORE_MAX, offset: 0 },
    })
    return Array.isArray(dead) ? dead : []
  } catch (err) {
    console.warn('[stale-output] unspendable lookup skipped', err)
    return []
  }
}

/**
 * Re-enable change of a live local tx that was left `spendable: false`.
 *
 * Never asks the indexer `isUtxo`. Indexer lag after a spend answers `true`
 * for coins this wallet already consumed, and restoring those inflated Pay
 * and poisoned the next createAction. Overlay-hidden and locally-spent
 * inputs stay hidden. `onlyLiveChange` is kept for callers; it is always
 * the behaviour now.
 *
 * @returns how many outputs were restored.
 */
export async function restoreLiveSpendableOutputs(opts?: {
  onlyLiveChange?: boolean
}): Promise<number> {
  void opts
  if (shouldYieldChainIngestToSpend()) return 0
  const active = getActiveWallet()
  if (!active) return 0
  const storage = active.wallet.storage
  if (!storage || typeof storage.findOutputs !== 'function') return 0
  if (typeof storage.runAsStorageProvider !== 'function') return 0

  try {
    const dead = await loadUnspendableChange(storage)
    if (!dead.length) return 0

    let restored = 0
    let unscripted = 0
    let keptSpent = 0
    const txCache = new Map<number, TxStatusRow | null>()

    for (const raw of dead.slice(0, RESTORE_MAX)) {
      if (shouldYieldChainIngestToSpend()) {
        console.info(
          `[stale-output] restore yielded to spend after ${restored} restore(s)`,
        )
        break
      }
      const output = raw as ChangeRow & {
        transactionId?: number
        spentBy?: number
        outputIndex?: number
        basket?: string
        change?: boolean
      }
      const outputId = positiveId(output.outputId)
      if (outputId == null) continue
      const overlayKey = outpointFromOutput(output)
      if (overlayKey && isUtxoBlockedFromRestore(overlayKey)) {
        keptSpent += 1
        continue
      }

      try {
        const restoredThis = await storage.runAsStorageProvider(async (activeSp) => {
          const sp = activeSp as unknown as LocalStorage
        const spentBy = positiveId(output.spentBy)
        if (spentBy != null) {
          const spender = await loadTxRow(sp, spentBy, txCache)
          if (isLiveLocalTxStatus(spender?.status)) return 'spent'
        }

        const creatorId = positiveId(output.transactionId)
        const creator = creatorId != null ? await loadTxRow(sp, creatorId, txCache) : null
        const localChange =
          output.change === true &&
          isLiveLocalTxStatus(creator?.status) &&
          spentBy == null

        const healed = await healLockingScript(sp, output)
        const scripted = healed != null || hasLockingScript(output)
        if (!scripted) return 'unscripted'

        if (!localChange) return 'skip'

        await sp.updateOutput(outputId, {
          spendable: true,
          ...(healed != null ? { lockingScript: healed } : {}),
        })
        return 'restored'
      })

      if (restoredThis === 'restored') restored += 1
      else if (restoredThis === 'unscripted') unscripted += 1
      else if (restoredThis === 'spent') keptSpent += 1
      } catch (err) {
        console.warn(
          '[stale-output] restore skipped',
          outputId,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    if (restored > 0) {
      console.info(
        `[stale-output] restored ${restored} live change output(s) previously marked unspendable`,
      )
    }
    if (keptSpent > 0) {
      console.info(
        `[stale-output] left ${keptSpent} locally-spent input(s) unspendable (network lag)`,
      )
    }
    if (unscripted > 0) {
      console.info(
        `[stale-output] skipped ${unscripted} output(s) with no locking script — awaiting rebuild`,
      )
    }
    return restored
  } catch (err) {
    console.warn('[stale-output] restore failed', err)
    return 0
  }
}
