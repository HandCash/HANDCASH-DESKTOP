/**
 * Refresh-time reconcile of basket `1sat` rows storage holds unspendable while
 * the address scan lists them unspent at this wallet's address.
 *
 * Custody-journal recovery only re-imports outputs the toolbox has no row for,
 * and the written-off coin reconcile only reads basket `default`. An item whose
 * row was hidden — its import leg failed locally, or taken by the fail closure
 * of an earlier leg whose change funded it — was reached by neither: the tip sat
 * at the address, Collect could not list it, and the ingest classify walk calls
 * it "unrecognized" and never imports it. See `kernel/writtenOffItemFate.ts`.
 *
 * Storage is read and written one page per session, and every page first lets a
 * waiting send take the lock: this runs inside Refresh, which must never hold a
 * send back.
 */

import type { LegacyUtxo } from './legacyScan'
import type { ActiveWallet } from './session'
import { decideWrittenOffItemFate, type WrittenOffItemFate } from './kernel/writtenOffItemFate'
import { isItemAbandoned, isItemSent } from './sentItemGuard'
import { withStorageLockLabel } from './storageLockTrace'
import { outpointFromOutput } from './txOutpoints'
import { getUtxoLock, isUtxoBlockedFromRestore } from './utxoLockManager'
import { isQuarantined } from './utxoLifecycle'
import { yieldToUi } from './yieldToUi'

/** Unspendable rows read per storage session. */
const READ_PAGE = 500
/** Rows flipped per storage session. */
const WRITE_PAGE = 100
const MAX_READ_PAGES = 200

type OutputRow = {
  outputId?: number
  transactionId?: number
  spentBy?: number | null
  spendable?: boolean
  txid?: string
  vout?: number
}

type TxRow = { transactionId?: number; status?: string; txid?: string }

type ReconcileProvider = {
  findOutputBaskets(args: unknown): Promise<Array<{ basketId: number }>>
  findOutputs(args: unknown): Promise<OutputRow[]>
  findTransactions(args: unknown): Promise<TxRow[]>
  updateOutput(id: number, patch: Record<string, unknown>): Promise<unknown>
}

type ReconcileStorage = {
  getAuth(): Promise<{ userId?: number }>
  runAsStorageProvider<T>(fn: (sp: ReconcileProvider) => Promise<T>): Promise<T>
}

export type WrittenOffItemReconcileResult = {
  /** One-sat tips the scan lists at our address that the spendable basket lacks. */
  absent: number
  /** Of those, rows storage holds unspendable. The rest have no row at all. */
  rows: number
  restored: number
  revived: number
  pinned: number
  kept: Partial<Record<Extract<WrittenOffItemFate, { kind: 'keep' }>['reason'] | 'creatorRefused', number>>
  /** Outpoints now spendable, for the caller's basket view. */
  restoredOutpoints: string[]
  stopped: boolean
}

type Hidden = { outputId: number; outpoint: string; creatorId: number | null; spentBy: number | null }

function positiveId(value: unknown): number | null {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function key(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

function overlayHolds(outpoint: string): boolean {
  if (isUtxoBlockedFromRestore(outpoint)) return true
  const lock = getUtxoLock(outpoint)
  return lock != null && isQuarantined(lock)
}

export async function reconcileWrittenOffItems(args: {
  active: ActiveWallet
  /** The address scan, provider and ordinal index merged. */
  tips: readonly LegacyUtxo[]
  /** Every outpoint basket `1sat` lists as spendable — must be the complete list. */
  basketSpendable: ReadonlySet<string>
  shouldStop?: () => boolean
}): Promise<WrittenOffItemReconcileResult> {
  const started = Date.now()
  const stop = args.shouldStop ?? (() => false)
  const result: WrittenOffItemReconcileResult = {
    absent: 0,
    rows: 0,
    restored: 0,
    revived: 0,
    pinned: 0,
    kept: {},
    restoredOutpoints: [],
    stopped: false,
  }
  const absent = new Set<string>()
  for (const tip of args.tips) {
    if (tip.satoshis !== 1) continue
    const op = key(tip.outpoint)
    if (!args.basketSpendable.has(op)) absent.add(op)
  }
  result.absent = absent.size
  if (absent.size === 0) return result

  const storage = (args.active.wallet as { storage?: Partial<ReconcileStorage> } | undefined)?.storage
  if (typeof storage?.runAsStorageProvider !== 'function' || typeof storage.getAuth !== 'function') return result
  const { userId } = await storage.getAuth()
  if (typeof userId !== 'number') return result

  const hidden: Hidden[] = []
  let basketId: number | null = null
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    if (stop()) {
      result.stopped = true
      break
    }
    const rows = await withStorageLockLabel('itemReconcile(read)', () =>
      storage.runAsStorageProvider!(async (sp) => {
        if (basketId == null) {
          const [basket] = await sp.findOutputBaskets({ partial: { userId, name: '1sat' } })
          basketId = positiveId(basket?.basketId)
          if (basketId == null) return []
        }
        return sp.findOutputs({
          partial: { userId, basketId, spendable: false },
          noScript: true,
          paged: { limit: READ_PAGE, offset: page * READ_PAGE },
        })
      }),
    )
    for (const row of rows) {
      const outputId = positiveId(row.outputId)
      const outpoint = outpointFromOutput(row)
      if (outputId == null || outpoint == null || !absent.has(outpoint)) continue
      hidden.push({ outputId, outpoint, creatorId: positiveId(row.transactionId), spentBy: positiveId(row.spentBy) })
    }
    if (rows.length < READ_PAGE) break
    await yieldToUi()
  }
  result.rows = hidden.length

  const creatorIds = [...new Set(hidden.map((h) => h.creatorId).filter((id): id is number => id != null))]
  const creators = new Map<number, TxRow>()
  for (let i = 0; i < creatorIds.length && !stop(); i += WRITE_PAGE) {
    const ids = creatorIds.slice(i, i + WRITE_PAGE)
    const found = await withStorageLockLabel('itemReconcile(creators)', () =>
      storage.runAsStorageProvider!(async (sp) => {
        const out: TxRow[] = []
        for (const transactionId of ids) {
          const [tx] = await sp.findTransactions({ partial: { userId, transactionId }, noRawTx: true })
          if (tx) out.push(tx)
        }
        return out
      }),
    )
    for (const tx of found) {
      const id = positiveId(tx.transactionId)
      if (id != null) creators.set(id, tx)
    }
  }

  const keep = (reason: keyof WrittenOffItemReconcileResult['kept']) => {
    result.kept[reason] = (result.kept[reason] ?? 0) + 1
  }
  const toRestore: Hidden[] = []
  const needsCreator = new Map<string, { kind: 'reviveCreator' | 'pinCreator'; rows: Hidden[] }>()
  for (const h of hidden) {
    const creator = h.creatorId != null ? creators.get(h.creatorId) : undefined
    const fate = decideWrittenOffItemFate({
      spentLocally: h.spentBy != null,
      leftOnPurpose: isItemSent(h.outpoint) || isItemAbandoned(h.outpoint),
      overlayHeld: overlayHolds(h.outpoint),
      creatorStatus: String(creator?.status ?? ''),
    })
    if (fate.kind === 'keep') keep(fate.reason)
    else if (fate.kind === 'restore') toRestore.push(h)
    else {
      const txid = String(creator?.txid ?? '').toLowerCase()
      const group = needsCreator.get(txid) ?? { kind: fate.kind, rows: [] }
      group.rows.push(h)
      needsCreator.set(txid, group)
    }
  }

  if (needsCreator.size > 0) {
    const { pinBroadcastLocalTx, restoreOnChainLocalTx } = await import('./staleOutputRelease')
    for (const [txid, group] of needsCreator) {
      if (stop()) {
        result.stopped = true
        break
      }
      const ok = /^[0-9a-f]{64}$/.test(txid)
        ? group.kind === 'reviveCreator'
          ? await restoreOnChainLocalTx(txid)
          : await pinBroadcastLocalTx(txid)
        : false
      if (!ok) {
        for (let i = 0; i < group.rows.length; i += 1) keep('creatorRefused')
        continue
      }
      if (group.kind === 'reviveCreator') result.revived += 1
      else result.pinned += 1
      toRestore.push(...group.rows)
    }
  }

  for (let i = 0; i < toRestore.length; i += WRITE_PAGE) {
    if (stop()) {
      result.stopped = true
      break
    }
    const batch = toRestore.slice(i, i + WRITE_PAGE)
    const flipped = await withStorageLockLabel('itemReconcile(write)', () =>
      storage.runAsStorageProvider!(async (sp) => {
        const done: string[] = []
        for (const h of batch) {
          // A send may have claimed the tip since the read; only an untouched row flips.
          const [row] = await sp.findOutputs({ partial: { outputId: h.outputId }, noScript: true })
          if (!row || positiveId(row.spentBy) != null) continue
          if (row.spendable === true) {
            done.push(h.outpoint)
            continue
          }
          if (overlayHolds(h.outpoint)) continue
          await sp.updateOutput(h.outputId, { spendable: true })
          done.push(h.outpoint)
        }
        return done
      }),
    )
    result.restoredOutpoints.push(...flipped)
    await yieldToUi()
  }
  result.restored = result.restoredOutpoints.length

  if (result.restored > 0) {
    const { requestCollectablesRelist } = await import('./collectables')
    requestCollectablesRelist()
  }
  const kept = Object.entries(result.kept)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(' ')
  console.info(
    `[item-reconcile] done ${Date.now() - started}ms — absent=${result.absent} rows=${result.rows} ` +
      `noRow=${result.absent - result.rows} restored=${result.restored} revived=${result.revived} ` +
      `pinned=${result.pinned}${kept ? ` kept ${kept}` : ''}${result.stopped ? ' (send waiting — resumes next Refresh)' : ''}`,
  )
  return result
}
