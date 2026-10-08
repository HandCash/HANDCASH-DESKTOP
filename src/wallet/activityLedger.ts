/**
 * Activity's base layer, read live from the Toolbox transaction table.
 *
 * The table is the wallet's own complete record of what it sent and received,
 * and it rides the BRC-39 replica. Stored Activity rows are annotations on top
 * of it — app origin, item identity, pending/failed sends, events — so a row
 * the store shed or never had still shows from here. Never from an indexer,
 * never with an invented time. The last read is kept so a launch paints that
 * projection before a live read.
 */
import type { ActivityEntry, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { loadLedgerRows, saveLedgerRows } from './activityLedgerStore'
import { isGhostTxSuppressed } from './ghostTxSuppress'
import { shouldYieldChainIngestToSpend, spendNeedsStorage } from './walletCoordinator'
import { getWalletRuntime, runtimeIsCurrent, type WalletRuntime } from './walletRuntime'
import { yieldToUi } from './yieldToUi'

const WALLET_ORIGIN: typeof WALLET_ACTIVITY_ORIGIN = 'handcash'
/**
 * `sending` is signed and handed to broadcast. `nosend` is a signed cheque
 * still held: item sends since 1.3.492 stay there until Arcade pins them, so
 * a read of only completed and unproven drops them from Activity entirely.
 */
const SETTLED_STATUSES = ['completed', 'unproven', 'sending', 'nosend'] as const
const HELD_STATUS = 'nosend'
const COLLECTABLE_BASKET = '1sat'
const TOKEN_BASKET = 'bsv21'

export type LedgerTx = {
  transactionId?: number
  /** Status index this id was listed under on this read. */
  status?: string
  txid?: string | null
  satoshis?: number
  description?: string
  isOutgoing?: boolean
  created_at?: Date | string | number
}

export type LedgerOutput = {
  transactionId?: number
  spentBy?: number | null
  basketId?: number | null
  vout?: number
  txid?: string | null
  customInstructions?: string | null
}

export type LedgerBasket = { basketId?: number; name?: string }

function timeOf(value: LedgerTx['created_at']): number | null {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

type ItemMove = { outpoint: string; role: 'created' | 'spent'; origin?: string; name?: string }

/** Identity notes are a few hundred bytes; a remittance lineage is not and is never parsed here. */
const MAX_IDENTITY_NOTE = 4_096

/** The origin and name an item output was filed with, when its note is the small identity form. */
function filedIdentity(note: LedgerOutput['customInstructions']): { origin?: string; name?: string } {
  if (typeof note !== 'string' || note.length > MAX_IDENTITY_NOTE || note[0] !== '{') return {}
  try {
    const parsed = JSON.parse(note) as { origin?: unknown; name?: unknown }
    const origin =
      typeof parsed.origin === 'string' && /^[0-9a-f]{64}[._]\d+$/i.test(parsed.origin.trim())
        ? parsed.origin.trim().toLowerCase().replace('.', '_')
        : undefined
    const name = typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 80) || undefined : undefined
    return { ...(origin ? { origin } : {}), ...(name ? { name } : {}) }
  } catch {
    return {}
  }
}

/**
 * One row per settled transaction, or one per 1Sat item it moved.
 *
 * An item's direction is its own: an output the transaction created came in,
 * one it spent went out. A send to yourself or a purchase from yourself is one
 * transaction and two activities, and a mint is a receive even though the
 * transaction's net effect is the fee. A coin-only transaction has one net
 * effect, and that is its row; the note is the description it was created with.
 */
export function ledgerActivityRows(
  txs: LedgerTx[],
  outputs: LedgerOutput[],
  baskets: LedgerBasket[],
): ActivityEntry[] {
  const basketName = new Map(
    baskets.map((b) => [Number(b.basketId), String(b.name ?? '').toLowerCase()]),
  )
  const txidById = new Map<number, string>()
  for (const tx of txs) {
    const id = Number(tx.transactionId)
    const txid = tx.txid?.trim().toLowerCase()
    if (id > 0 && txid) txidById.set(id, txid)
  }
  const itemsOf = new Map<number, { moves: ItemMove[]; token: boolean }>()
  const note = (txId: number, basket: string, move: ItemMove | null) => {
    const slot = itemsOf.get(txId) ?? { moves: [], token: false }
    if (basket === TOKEN_BASKET) slot.token = true
    else if (move) slot.moves.push(move)
    itemsOf.set(txId, slot)
  }
  for (const out of outputs) {
    const basket = basketName.get(Number(out.basketId))
    if (basket !== COLLECTABLE_BASKET && basket !== TOKEN_BASKET) continue
    const creator = Number(out.transactionId)
    const txid = out.txid?.trim().toLowerCase() || txidById.get(creator)
    const outpoint = txid && /^[0-9a-f]{64}$/.test(txid) && Number.isSafeInteger(out.vout) && out.vout! >= 0 ? `${txid}.${out.vout}` : null
    const identity = basket === COLLECTABLE_BASKET ? filedIdentity(out.customInstructions) : {}
    if (creator > 0) note(creator, basket, outpoint ? { outpoint, role: 'created', ...identity } : null)
    const spender = Number(out.spentBy)
    if (spender > 0) note(spender, basket, outpoint ? { outpoint, role: 'spent', ...identity } : null)
  }

  const rows: ActivityEntry[] = []
  for (const tx of txs) {
    const txid = tx.txid?.trim().toLowerCase()
    if (!txid || !/^[0-9a-f]{64}$/.test(txid)) continue
    const at = timeOf(tx.created_at)
    if (at == null) continue
    const net = Number.isSafeInteger(tx.satoshis) ? tx.satoshis! : 0
    const outgoing = tx.isOutgoing === true || net < 0
    const description = tx.description?.trim() || ''
    const items = itemsOf.get(Number(tx.transactionId))
    if (items?.moves.length) {
      const seen = new Set<string>()
      const moves = items.moves.filter((m) => !seen.has(m.outpoint) && seen.add(m.outpoint))
      // Both directions in one transaction: its description names only one.
      const oneWay = moves.every((m) => m.role === moves[0]!.role)
      for (const { outpoint, role, origin, name } of moves) {
        const received = role === 'created'
        rows.push({
          id: `ledger:${txid}:${outpoint}`,
          origin: WALLET_ORIGIN,
          kind: received ? 'earned' : 'spent',
          sats: 1,
          at,
          method: received ? 'receive-collectable' : 'send-collectable',
          note:
            (oneWay && description) ||
            (received ? 'Received collectable' : 'Sent collectable'),
          txid,
          item: { name: name ?? 'Collectable', origin: origin ?? outpoint.replace(/\.(\d+)$/, '_$1'), outpoint },
        })
      }
      continue
    }
    const kind = outgoing ? 'spent' : 'earned'
    const sats = Math.abs(net)
    if (sats === 0) continue
    rows.push({
      id: `ledger:${txid}`,
      origin: WALLET_ORIGIN,
      kind,
      sats,
      at,
      method: outgoing ? 'send' : 'receive',
      note: description || (items?.token ? 'Token transfer' : outgoing ? 'Sent' : 'Received coins'),
      txid,
    })
  }
  return rows.sort((a, b) => a.at - b.at)
}

type Snapshot = {
  namespace: string
  rows: readonly ActivityEntry[]
  byId: ReadonlyMap<string, ActivityEntry>
  timeByTxid: ReadonlyMap<string, number>
}

const EMPTY: readonly ActivityEntry[] = Object.freeze([])
let snapshot: Snapshot | null = null
const listeners = new Set<() => void>()

function currentSnapshot(): Snapshot | null {
  const namespace = getWalletRuntime()?.storageNamespace
  return namespace && snapshot?.namespace === namespace ? snapshot : null
}

/** Ledger rows for the unlocked account; empty until the first read lands. */
export function ledgerActivitySnapshot(): readonly ActivityEntry[] {
  return currentSnapshot()?.rows ?? EMPTY
}

export function ledgerActivityById(id: string): ActivityEntry | null {
  return currentSnapshot()?.byId.get(id) ?? null
}

/** When the ledger says this transaction happened, if it holds it. */
export function ledgerTimeOfTxid(txid: string | undefined): number | null {
  if (!txid) return null
  return currentSnapshot()?.timeByTxid.get(txid.trim().toLowerCase()) ?? null
}

export function subscribeActivityLedger(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function sameRows(a: readonly ActivityEntry[], b: readonly ActivityEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.at !== y.at || x.sats !== y.sats || x.note !== y.note ||
        x.kind !== y.kind || x.method !== y.method || x.item?.outpoint !== y.item?.outpoint ||
        x.item?.origin !== y.item?.origin || x.item?.name !== y.item?.name) return false
  }
  return true
}

export function publishActivityLedger(namespace: string, rows: ActivityEntry[]): void {
  installSnapshot(namespace, rows, { persist: true })
}

function installSnapshot(namespace: string, rows: ActivityEntry[], opts: { persist: boolean }): void {
  const prev = snapshot?.namespace === namespace ? snapshot.rows : null
  if (prev && sameRows(prev, rows)) return
  const timeByTxid = new Map<string, number>()
  for (const row of rows) {
    const known = timeByTxid.get(row.txid!)
    if (known == null || row.at < known) timeByTxid.set(row.txid!, row.at)
  }
  snapshot = {
    namespace,
    rows: Object.freeze(rows),
    byId: new Map(rows.map((row) => [row.id, row])),
    timeByTxid,
  }
  if (opts.persist) scheduleSave(namespace, snapshot.rows)
  for (const cb of listeners) cb()
}

const SAVE_DELAY_MS = 3_000
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveRows: { namespace: string; rows: readonly ActivityEntry[] } | null = null

function scheduleSave(namespace: string, rows: readonly ActivityEntry[]): void {
  saveRows = { namespace, rows }
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const next = saveRows
    saveRows = null
    if (next) {
      void saveLedgerRows(next.namespace, next.rows).catch((err) => {
        console.warn('[activity-ledger] saving the last read failed', err instanceof Error ? err.message : err)
      })
    }
  }, SAVE_DELAY_MS)
}

function flushSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const next = saveRows
  saveRows = null
  if (next) {
    void saveLedgerRows(next.namespace, next.rows).catch(() => undefined)
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave()
  })
  window.addEventListener('pagehide', () => flushSave())
}

let primed: { namespace: string; rows: ActivityEntry[] } | null = null

async function readSavedRows(namespace: string): Promise<ActivityEntry[]> {
  try {
    const rows = await loadLedgerRows(namespace)
    return (rows ?? []).filter((row) => !isGhostTxSuppressed(row.txid!))
  } catch (err) {
    console.warn('[activity-ledger] last read unavailable', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * Read the saved projection before the runtime is published, so the account
 * start can paint it in the same turn the feed first reads. Without it a fresh
 * launch paints the annotation log alone and the history arrives a frame later.
 */
export async function preloadActivityLedger(namespace: string): Promise<void> {
  primed = { namespace, rows: await readSavedRows(namespace) }
}

/**
 * Paint the last session's read until the live one lands. Synchronous when
 * unlock preloaded this namespace — even an empty preload is not read twice.
 * A live read is never replaced, and a restored read is not written back.
 */
export function paintSavedActivityLedger(runtime: WalletRuntime): void {
  const namespace = runtime.storageNamespace
  const preloaded = primed?.namespace === namespace ? primed.rows : null
  primed = null
  if (preloaded) {
    if (preloaded.length > 0) installSnapshot(namespace, preloaded, { persist: false })
    return
  }
  void readSavedRows(namespace).then((rows) => {
    if (rows.length === 0 || !runtimeIsCurrent(runtime) || currentSnapshot()) return
    installSnapshot(namespace, rows, { persist: false })
    console.info(`[activity-ledger] restored ${rows.length} row(s) from the last read`)
  })
}

type IdbTransaction = {
  objectStore(name: string): {
    index(name: string): { getAllKeys(query: unknown): Promise<unknown[]> }
    get(key: unknown): Promise<unknown>
  }
  done: Promise<void>
}

type LedgerReader = {
  findUsers: (args: unknown) => Promise<unknown>
  findTransactions: (args: unknown) => Promise<unknown>
  findOutputs: (args: unknown) => Promise<unknown>
  findOutputBaskets: (args: unknown) => Promise<unknown>
  /** Present on the IndexedDB provider (`StorageIdb`). */
  toDbTrx?: (stores: string[], mode: 'readonly') => IdbTransaction
}

const asRows = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

const TX_CHUNK = 40
/** One output page, then the storage lock is released so a send can read a balance. */
const OUTPUT_PAGE = 200

type TxCache = { namespace: string; userId: number; byId: Map<number, LedgerTx> }
let txCache: TxCache | null = null

function assertCurrent(runtime: WalletRuntime): void {
  if (!runtimeIsCurrent(runtime)) throw new DOMException('Activity account changed', 'AbortError')
}

function ledgerTxOf(value: unknown): LedgerTx | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const transactionId = Number(r.transactionId)
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) return null
  return {
    transactionId,
    txid: typeof r.txid === 'string' ? r.txid : null,
    satoshis: typeof r.satoshis === 'number' ? r.satoshis : undefined,
    description: typeof r.description === 'string' ? r.description : undefined,
    isOutgoing: r.isOutgoing === true,
    created_at: r.created_at as LedgerTx['created_at'],
  }
}

/**
 * Settled transactions, reading only records this session has not seen.
 *
 * IndexedDB cannot project fields: every record read is cloned whole, raw
 * transaction and input BEEF included, and on a phone that is the entire
 * history copied on the UI thread. Ids come from the `status_userId` index
 * without their values; only new ids are fetched, in small transactions with a
 * frame between them. A settled record's ledger fields do not change, so ids
 * that left the settled set are dropped and the rest are kept. `full` rereads
 * everything, for a recompose that may have rewritten the store.
 */
async function settledTransactions(
  sp: LedgerReader,
  runtime: WalletRuntime,
  userId: number,
  full: boolean,
): Promise<LedgerTx[]> {
  const toDbTrx = sp.toDbTrx?.bind(sp)
  if (!toDbTrx) {
    return asRows<LedgerTx>(
      await sp.findTransactions({ partial: { userId }, status: [...SETTLED_STATUSES], noRawTx: true }),
    )
  }
  const namespace = runtime.storageNamespace
  if (full || !txCache || txCache.namespace !== namespace || txCache.userId !== userId) {
    txCache = { namespace, userId, byId: new Map() }
  }
  const cache = txCache
  const keys = toDbTrx(['transactions'], 'readonly')
  const index = keys.objectStore('transactions').index('status_userId')
  const lists = await Promise.all(SETTLED_STATUSES.map((status) => index.getAllKeys([status, userId])))
  await keys.done
  assertCurrent(runtime)
  const statusById = new Map<number, string>()
  SETTLED_STATUSES.forEach((status, i) => {
    for (const key of lists[i] ?? []) statusById.set(Number(key), status)
  })
  const settled = new Set(statusById.keys())
  for (const id of cache.byId.keys()) if (!settled.has(id)) cache.byId.delete(id)
  const missing = [...settled].filter((id) => !cache.byId.has(id))
  for (let i = 0; i < missing.length; i += TX_CHUNK) {
    if (i > 0) {
      await yieldToUi()
      assertCurrent(runtime)
    }
    const trx = toDbTrx(['transactions'], 'readonly')
    const store = trx.objectStore('transactions')
    const records = await Promise.all(missing.slice(i, i + TX_CHUNK).map((id) => store.get(id)))
    await trx.done
    for (const record of records) {
      const tx = ledgerTxOf(record)
      if (tx) cache.byId.set(tx.transactionId!, tx)
    }
  }
  assertCurrent(runtime)
  return [...cache.byId.values()].map((tx) => {
    const status = statusById.get(tx.transactionId!)
    return status && status !== tx.status ? { ...tx, status } : tx
  })
}

type StorageSession = {
  runAsStorageProvider: (fn: (sp: unknown) => Promise<unknown>) => Promise<unknown>
}

function sendIsWaiting(): boolean {
  return spendNeedsStorage() || shouldYieldChainIngestToSpend()
}

/**
 * Item outputs, one page per storage session.
 *
 * A single `findOutputs` of the whole 1sat basket holds the writer lock for
 * the entire history. The spend gate then waits out its ceiling and reports
 * "wallet storage is busy" on a funded wallet. Between pages the lock is free,
 * and a send that arrives mid-scan keeps the projection already on screen.
 */
async function readItemOutputs(
  storage: StorageSession,
  runtime: WalletRuntime,
  userId: number,
  itemBaskets: LedgerBasket[],
): Promise<LedgerOutput[] | null> {
  const outputs: LedgerOutput[] = []
  for (const basket of itemBaskets) {
    let offset = 0
    for (;;) {
      if (sendIsWaiting()) return null
      assertCurrent(runtime)
      const page = asRows<LedgerOutput>(
        await storage.runAsStorageProvider(async (raw) => {
          const sp = raw as unknown as LedgerReader
          return sp.findOutputs({
            partial: { userId, basketId: basket.basketId },
            noScript: true,
            paged: { limit: OUTPUT_PAGE, offset },
          })
        }),
      )
      outputs.push(...page)
      if (page.length < OUTPUT_PAGE) break
      offset += page.length
      await yieldToUi()
    }
  }
  return outputs
}

async function readLedger(runtime: WalletRuntime, full: boolean): Promise<ActivityEntry[] | null> {
  const active = runtime.instance
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  if (sendIsWaiting()) return null
  const read = await storage.runAsStorageProvider(async (raw) => {
    const sp = raw as unknown as LedgerReader
    const users = asRows<{ userId: number }>(await sp.findUsers({ partial: { identityKey: active.identityKey } }))
    if (users.length !== 1 || !Number.isSafeInteger(users[0]?.userId) || users[0]!.userId <= 0) {
      throw new Error('Activity ledger wallet owner is unavailable')
    }
    assertCurrent(runtime)
    const userId = users[0]!.userId
    const baskets = asRows<LedgerBasket>(await sp.findOutputBaskets({ partial: { userId } }))
    assertCurrent(runtime)
    const txs = sp.toDbTrx ? null : await settledTransactions(sp, runtime, userId, full)
    return { sp, userId, txs, baskets }
  }) as {
    sp: LedgerReader
    userId: number
    txs: LedgerTx[] | null
    baskets: LedgerBasket[]
  }
  const itemBaskets = read.baskets.filter((b) => {
    const name = String(b.name ?? '').toLowerCase()
    return name === COLLECTABLE_BASKET || name === TOKEN_BASKET
  })
  const outputs = await readItemOutputs(storage, runtime, read.userId, itemBaskets)
  if (!outputs) return null
  // Read-only IndexedDB transactions are consistent on their own, so the
  // transaction records are fetched outside the storage lock: a spend waiting
  // for the writer never queues behind the first read of a long history.
  const all = read.txs ?? (await settledTransactions(read.sp, runtime, read.userId, full))
  const { baskets } = read
  const itemTx = new Set<number>()
  const basketName = new Map(baskets.map((b) => [Number(b.basketId), String(b.name ?? '').toLowerCase()]))
  for (const out of outputs) {
    const name = basketName.get(Number(out.basketId))
    if (name !== COLLECTABLE_BASKET && name !== TOKEN_BASKET) continue
    const creator = Number(out.transactionId)
    const spender = Number(out.spentBy)
    if (creator > 0) itemTx.add(creator)
    if (spender > 0) itemTx.add(spender)
  }
  const txs = all.filter((tx) => {
    if (tx.status !== HELD_STATUS) return true
    return itemTx.has(Number(tx.transactionId))
  })
  return ledgerActivityRows(txs, outputs, baskets).filter(
    (row) => !isGhostTxSuppressed(row.txid!),
  )
}

const MIN_REFRESH_GAP_MS = 10_000
const SETTLE_MS = 2_500
const SPEND_YIELD_MS = 2_000
const MAX_FAILURE_GAP_MS = 5 * 60_000

const inFlights = new Map<WalletRuntime, Promise<void>>()
let timer: ReturnType<typeof setTimeout> | null = null
let lastRefreshAt = 0
let logged = false
let failures = 0

/**
 * Read the ledger now for this runtime. Concurrent calls share one read.
 * `full` rereads every transaction record, for after the store was rewritten.
 */
export function refreshActivityLedger(
  runtime: WalletRuntime | null = getWalletRuntime(),
  opts: { full?: boolean } = {},
): Promise<void> {
  if (!runtime) return Promise.resolve()
  if (!runtimeIsCurrent(runtime)) return Promise.resolve()
  const current = inFlights.get(runtime)
  if (current) return current
  const flight = (async () => {
    const started = Date.now()
    lastRefreshAt = started
    try {
      const rows = await readLedger(runtime, opts.full === true)
      if (!rows || !runtimeIsCurrent(runtime)) return
      failures = 0
      publishActivityLedger(runtime.storageNamespace, rows)
      const ms = Date.now() - started
      if (!logged || ms >= 250) {
        logged = true
        console.info(`[activity-ledger] ${rows.length} row(s) from wallet history done ${ms}ms`)
      }
    } catch (err) {
      if (!runtimeIsCurrent(runtime)) return
      failures += 1
      console.warn('[activity-ledger] read failed', err instanceof Error ? err.message : err)
      scheduleActivityLedgerRefresh()
    } finally {
      inFlights.delete(runtime)
    }
  })()
  inFlights.set(runtime, flight)
  return flight
}

/** Re-read after Activity changes settle; never competes with a spend. */
export function scheduleActivityLedgerRefresh(): void {
  if (timer || !getWalletRuntime()) return
  // A read that keeps failing (no owner row, storage closed) backs off instead
  // of warning every ten seconds for the whole session.
  const gap = Math.min(MAX_FAILURE_GAP_MS, MIN_REFRESH_GAP_MS * 2 ** failures)
  const wait = Math.max(SETTLE_MS, lastRefreshAt + gap - Date.now())
  timer = setTimeout(function fire() {
    timer = setTimeout(fire, SPEND_YIELD_MS)
    void import('./recompose').then(({ isRecomposeInFlight }) => {
      if (shouldYieldChainIngestToSpend() || spendNeedsStorage() || isRecomposeInFlight()) return
      if (timer) clearTimeout(timer)
      timer = null
      void refreshActivityLedger()
    })
  }, wait)
}

export function resetActivityLedgerForRuntime(): void {
  flushSave()
  if (timer) clearTimeout(timer)
  timer = null
  snapshot = null
  txCache = null
  lastRefreshAt = 0
  logged = false
  failures = 0
  for (const cb of listeners) cb()
}

export function resetActivityLedgerForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  saveRows = null
  inFlights.clear()
  primed = null
  snapshot = null
  txCache = null
  lastRefreshAt = 0
  logged = false
  failures = 0
}
