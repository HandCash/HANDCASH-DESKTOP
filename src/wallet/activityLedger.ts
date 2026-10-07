/**
 * Activity's base layer, read live from the Toolbox transaction table.
 *
 * The table is the wallet's own complete record of what it sent and received,
 * and it rides the BRC-39 replica. Stored Activity rows are annotations on top
 * of it — app origin, item identity, pending/failed sends, events — so a row
 * the store shed or never had still shows from here. Never from an indexer,
 * never with an invented time. The last read is kept on disk only so a launch
 * paints it while the first live read runs (`activityLedgerStore.ts`).
 */
import type { ActivityEntry, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { itemMigrateTxDescription } from './activityJobIndex'
import { loadLedgerRows, saveLedgerRows } from './activityLedgerStore'
import { isGhostTxSuppressed } from './ghostTxSuppress'
import { shouldYieldChainIngestToSpend, spendNeedsStorage } from './walletCoordinator'
import { getWalletRuntime, runtimeIsCurrent, type WalletRuntime } from './walletRuntime'
import { yieldToUi } from './yieldToUi'

const WALLET_ORIGIN: typeof WALLET_ACTIVITY_ORIGIN = 'handcash'
/**
 * Transactions that are the wallet's history. `sending` is signed and handed to
 * broadcast: a delayed-broadcast `signAction` files there and only the Monitor's
 * own resend moves it on, even after Arcade accepted our post. Leaving it out
 * dropped every just-imported migrate from Activity on restart.
 *
 * `nosend` is a signed cheque the wallet still holds. Every migrate and item
 * send files there and leaves only when Arcade's acceptance pins it, so a leg
 * a fallback miner took — or a mined one Arcade never answered for — sat in
 * Collect with no Activity row. Those count once the wallet has propagated
 * them (`chequeWasPropagated`); an app's unbroadcast `noSend` never does.
 */
const SETTLED_STATUSES = ['completed', 'unproven', 'sending', 'nosend'] as const
const HELD_STATUS = 'nosend'
const COLLECTABLE_BASKET = '1sat'
const TOKEN_BASKET = 'bsv21'

export type LedgerTx = {
  transactionId?: number
  /** The status index the id was found under on this read. */
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
  /** Painted from the last session's read; no live read has landed yet. */
  restored: boolean
}

const EMPTY: readonly ActivityEntry[] = Object.freeze([])
let snapshot: Snapshot | null = null
const listeners = new Set<() => void>()

/**
 * Legs a running import just committed, shaped exactly as the next read will
 * file them. The read yields to every spend, so for a whole import it never
 * ran and Activity stood still while the count climbed. Memory only; each leg
 * leaves when a read holds its row.
 */
const MAX_PROVISIONAL = 5_000
let provisional: { namespace: string; byId: Map<string, ActivityEntry> } | null = null
let merged: { base: readonly ActivityEntry[]; version: number; rows: readonly ActivityEntry[] } | null = null
let provisionalVersion = 0

function currentSnapshot(): Snapshot | null {
  const namespace = getWalletRuntime()?.storageNamespace
  return namespace && snapshot?.namespace === namespace ? snapshot : null
}

function currentProvisional(): Map<string, ActivityEntry> | null {
  const namespace = getWalletRuntime()?.storageNamespace
  return namespace && provisional?.namespace === namespace && provisional.byId.size > 0 ? provisional.byId : null
}

/** Ledger rows for the unlocked account; empty until the first read lands. */
export function ledgerActivitySnapshot(): readonly ActivityEntry[] {
  const base = currentSnapshot()?.rows ?? EMPTY
  const pending = currentProvisional()
  if (!pending) return base
  if (merged?.base === base && merged.version === provisionalVersion) return merged.rows
  const rows = Object.freeze([...base, ...pending.values()].sort((a, b) => a.at - b.at))
  merged = { base, version: provisionalVersion, rows }
  return rows
}

export function ledgerActivityById(id: string): ActivityEntry | null {
  return currentSnapshot()?.byId.get(id) ?? currentProvisional()?.get(id) ?? null
}

export type CommittedItemLeg = { txid: string; vout: number; origin?: string | null; name?: string | null }

/** Show a migrate's legs now; the ledger read replaces them with its own. */
export function noteCommittedItemLegs(legs: readonly CommittedItemLeg[], at = Date.now()): void {
  const namespace = getWalletRuntime()?.storageNamespace
  if (!namespace || legs.length === 0) return
  if (provisional?.namespace !== namespace) provisional = { namespace, byId: new Map() }
  const known = currentSnapshot()?.byId
  const byTx = new Map<string, CommittedItemLeg[]>()
  for (const leg of legs) {
    const txid = leg.txid.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(leg.vout) || leg.vout < 0) continue
    const list = byTx.get(txid) ?? []
    list.push(leg)
    byTx.set(txid, list)
  }
  let added = 0
  for (const [txid, list] of byTx) {
    const first = list.reduce((low, leg) => (leg.vout < low.vout ? leg : low))
    const note = itemMigrateTxDescription(list.length, `${txid}.${first.vout}`)
    for (const leg of list) {
      const outpoint = `${txid}.${leg.vout}`
      const id = `ledger:${txid}:${outpoint}`
      if (known?.has(id) || provisional.byId.has(id)) continue
      const origin = leg.origin?.trim().toLowerCase().replace('.', '_')
      provisional.byId.set(id, {
        id,
        origin: WALLET_ORIGIN,
        kind: 'earned',
        sats: 1,
        at,
        method: 'receive-collectable',
        note,
        txid,
        item: {
          name: leg.name?.trim().slice(0, 80) || 'Collectable',
          origin: origin && /^[0-9a-f]{64}_\d+$/.test(origin) ? origin : `${txid}_${leg.vout}`,
          outpoint,
        },
      })
      added += 1
    }
  }
  for (const id of provisional.byId.keys()) {
    if (provisional.byId.size <= MAX_PROVISIONAL) break
    provisional.byId.delete(id)
  }
  if (added === 0) return
  provisionalVersion += 1
  for (const cb of listeners) cb()
}

function clearProvisional(): void {
  provisional = null
  merged = null
  provisionalVersion += 1
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

function setSnapshot(namespace: string, rows: ActivityEntry[], restored: boolean): void {
  let settled = 0
  if (provisional?.namespace === namespace) {
    for (const row of rows) if (provisional.byId.delete(row.id)) settled += 1
    if (settled > 0) provisionalVersion += 1
  }
  const prev = snapshot?.namespace === namespace ? snapshot : null
  if (prev && sameRows(prev.rows, rows)) {
    if (!restored) prev.restored = false
    if (settled > 0) for (const cb of listeners) cb()
    return
  }
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
    restored,
  }
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
    if (!next) return
    void saveLedgerRows(next.namespace, next.rows).catch((err) => {
      console.warn('[activity-ledger] saving the last read failed', err instanceof Error ? err.message : err)
    })
  }, SAVE_DELAY_MS)
}

export function publishActivityLedger(namespace: string, rows: ActivityEntry[]): void {
  const prev = snapshot?.namespace === namespace ? snapshot : null
  const changed = !prev || prev.restored || !sameRows(prev.rows, rows)
  setSnapshot(namespace, rows, false)
  if (changed) scheduleSave(namespace, rows)
}

/**
 * Paint the last session's read for this account until the first live read
 * lands. A live read that already landed is never replaced.
 */
export async function restoreActivityLedger(runtime: WalletRuntime | null = getWalletRuntime()): Promise<void> {
  if (!runtime || !runtimeIsCurrent(runtime)) return
  const namespace = runtime.storageNamespace
  const started = Date.now()
  let rows: ActivityEntry[] | null
  try {
    rows = await loadLedgerRows(namespace)
  } catch (err) {
    console.warn('[activity-ledger] last read unavailable', err instanceof Error ? err.message : err)
    return
  }
  if (!rows || !runtimeIsCurrent(runtime) || currentSnapshot()) return
  setSnapshot(namespace, rows.filter((row) => !isGhostTxSuppressed(row.txid!)), true)
  console.info(`[activity-ledger] restored ${rows.length} row(s) from the last read done ${Date.now() - started}ms`)
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
    ...(typeof r.status === 'string' ? { status: r.status } : {}),
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
  // A cached record keeps the status it was read with; a pinned cheque moves
  // `nosend` → `unproven` without leaving the set, so the index is the truth.
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

/**
 * Whether the wallet has handed this held cheque to the network: Arcade took
 * it, a node reported it, or the miner outbox is still propagating it.
 */
async function chequeWasPropagated(runtime: WalletRuntime): Promise<(txid: string) => boolean> {
  const [{ txHadArcadeSubmitContact }, { txLanded }, { pendingMinerSubmitTxids }, { accountKeyScopeFor }] =
    await Promise.all([
      import('./arcadeSubmitGuard'),
      import('./landedTx'),
      import('./pendingMinerOutbox'),
      import('./accountLocalKeys'),
    ])
  const queued = pendingMinerSubmitTxids(accountKeyScopeFor(runtime.instance))
  return (txid) => queued.has(txid) || txHadArcadeSubmitContact(txid) || txLanded(txid)
}

async function readLedger(runtime: WalletRuntime, full: boolean): Promise<ActivityEntry[] | null> {
  const active = runtime.instance
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
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
    const itemBaskets = baskets.filter((b) => {
      const name = String(b.name ?? '').toLowerCase()
      return name === COLLECTABLE_BASKET || name === TOKEN_BASKET
    })
    const outputs = await Promise.all(
      itemBaskets.map((b) =>
        sp.findOutputs({ partial: { userId, basketId: b.basketId }, noScript: true }),
      ),
    )
    const txs = sp.toDbTrx ? null : await settledTransactions(sp, runtime, userId, full)
    return { sp, userId, txs, outputs: outputs.flatMap((o) => asRows<LedgerOutput>(o)), baskets }
  })
  // Read-only IndexedDB transactions are consistent on their own, so the
  // transaction records are fetched outside the storage lock: a spend waiting
  // for the writer never queues behind the first read of a long history.
  const all = read.txs ?? (await settledTransactions(read.sp, runtime, read.userId, full))
  const propagated = all.some((tx) => tx.status === HELD_STATUS) ? await chequeWasPropagated(runtime) : null
  const txs = propagated
    ? all.filter((tx) => tx.status !== HELD_STATUS || (!!tx.txid && propagated(tx.txid.trim().toLowerCase())))
    : all
  const { outputs, baskets } = read
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
    if (shouldYieldChainIngestToSpend() || spendNeedsStorage()) {
      timer = setTimeout(fire, SPEND_YIELD_MS)
      return
    }
    timer = null
    void refreshActivityLedger()
  }, wait)
}

function cancelSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  saveRows = null
}

export function resetActivityLedgerForRuntime(): void {
  if (timer) clearTimeout(timer)
  timer = null
  cancelSave()
  snapshot = null
  clearProvisional()
  txCache = null
  lastRefreshAt = 0
  logged = false
  failures = 0
  for (const cb of listeners) cb()
}

export function resetActivityLedgerForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  cancelSave()
  inFlights.clear()
  snapshot = null
  clearProvisional()
  txCache = null
  lastRefreshAt = 0
  logged = false
  failures = 0
}
