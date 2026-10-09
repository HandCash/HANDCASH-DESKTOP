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
import { loadLedgerSnapshot, saveLedgerRows, type SavedLedger, type SavedLedgerTxs } from './activityLedgerStore'
import { isGhostTxSuppressed } from './ghostTxSuppress'
import { withStorageLockLabel } from './storageLockTrace'
import { shouldYieldChainIngestToSpend, spendNeedsStorage } from './walletCoordinator'
import { getWalletRuntime, runtimeIsCurrent, type WalletRuntime } from './walletRuntime'
import { uiBudgetExpired, yieldToUi } from './yieldToUi'

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
  const steps = ledgerRowSteps(txs, outputs, baskets)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/**
 * {@link ledgerActivityRows} with a turn for the UI whenever the budget runs
 * out. A full read projects the whole history; in one task that froze the
 * phone for 2.6s after the last transaction chunk landed.
 */
export async function ledgerActivityRowsSliced(
  txs: LedgerTx[],
  outputs: LedgerOutput[],
  baskets: LedgerBasket[],
): Promise<ActivityEntry[]> {
  const steps = ledgerRowSteps(txs, outputs, baskets)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    if (uiBudgetExpired()) await yieldToUi()
  }
}

/** Rows between budget checks; a check is a clock read, the rows are cheaper. */
const ROW_STEP = 256

function* ledgerRowSteps(
  txs: LedgerTx[],
  outputs: LedgerOutput[],
  baskets: LedgerBasket[],
): Generator<void, ActivityEntry[], void> {
  let sinceStep = 0
  const step = () => (sinceStep += 1) % ROW_STEP === 0
  const basketName = new Map(
    baskets.map((b) => [Number(b.basketId), String(b.name ?? '').toLowerCase()]),
  )
  const txidById = new Map<number, string>()
  for (const tx of txs) {
    const id = Number(tx.transactionId)
    const txid = tx.txid?.trim().toLowerCase()
    if (id > 0 && txid) txidById.set(id, txid)
    if (step()) yield
  }
  const itemsOf = new Map<number, { moves: ItemMove[]; token: boolean }>()
  const note = (txId: number, basket: string, move: ItemMove | null) => {
    const slot = itemsOf.get(txId) ?? { moves: [], token: false }
    if (basket === TOKEN_BASKET) slot.token = true
    else if (move) slot.moves.push(move)
    itemsOf.set(txId, slot)
  }
  for (const out of outputs) {
    if (step()) yield
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
    if (step()) yield
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

/**
 * Rows for this wallet's own transactions that broadcast after the last read
 * began. An import leg is in the feed and in the saved copy the moment it
 * lands, not only once a live read — minutes behind the storage lock on a
 * phone — reaches it; without this a restart mid-import showed none of it.
 * The first read that began after a row was noted settles it: the read's own
 * row replaces it, or the transaction is not settled and the row goes.
 */
type Provisional = { namespace: string; notedAt: number; rows: ActivityEntry[] }
const provisional = new Map<string, Provisional>()

/**
 * `rows` with every provisional row of `namespace` it does not hold. A live
 * read (`readStartedAt`) retires the ones it holds or that were noted before
 * it began.
 */
function withProvisional(
  namespace: string,
  rows: readonly ActivityEntry[],
  readStartedAt: number | null,
): ActivityEntry[] {
  if (provisional.size === 0) return rows as ActivityEntry[]
  const held = new Set(rows.map((row) => row.txid))
  const extra: ActivityEntry[] = []
  for (const [txid, entry] of provisional) {
    if (entry.namespace !== namespace) continue
    const settled = held.has(txid) || (readStartedAt != null && entry.notedAt < readStartedAt)
    if (settled && readStartedAt != null) provisional.delete(txid)
    if (settled || isGhostTxSuppressed(txid)) continue
    extra.push(...entry.rows)
  }
  if (extra.length === 0) return rows as ActivityEntry[]
  return [...rows, ...extra].sort((a, b) => a.at - b.at)
}

/**
 * Ledger rows for a transaction this wallet just broadcast, in the shape a
 * read will produce for it (`ledger:<txid>:<outpoint>`), so the read replaces
 * them row for row.
 */
export function noteOwnLedgerRows(rows: readonly ActivityEntry[]): void {
  const namespace = getWalletRuntime()?.storageNamespace
  if (!namespace) return
  const notedAt = Date.now()
  for (const row of rows) {
    const txid = row.txid?.trim().toLowerCase()
    if (!txid || !/^[0-9a-f]{64}$/.test(txid) || !row.id.startsWith(`ledger:${txid}`)) continue
    const entry = provisional.get(txid)
    const kept = entry?.namespace === namespace ? entry.rows.filter((r) => r.id !== row.id) : []
    provisional.set(txid, { namespace, notedAt, rows: [...kept, { ...row, txid }] })
  }
  const current = currentSnapshot()
  // Before the restored copy paints there is nothing to merge into; the
  // restore, or the first read, picks these up.
  if (!current) return
  installSnapshot(namespace, withProvisional(namespace, current.rows, null), { persist: true })
}

export function publishActivityLedger(
  namespace: string,
  rows: ActivityEntry[],
  readStartedAt: number | null = null,
): void {
  installSnapshot(namespace, withProvisional(namespace, rows, readStartedAt), { persist: true })
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
      void saveLedgerRows(next.namespace, next.rows, txsToSave(next.namespace)).catch((err) => {
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
    void saveLedgerRows(next.namespace, next.rows, txsToSave(next.namespace)).catch(() => undefined)
  }
}

/** This session's transaction cache, or undefined to keep what is saved. */
function txsToSave(namespace: string): SavedLedgerTxs | undefined {
  if (txCache?.namespace !== namespace) return undefined
  return { userId: txCache.userId, txs: [...txCache.byId.values()] }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave()
  })
  window.addEventListener('pagehide', () => flushSave())
}

let primed: { namespace: string; saved: SavedLedger } | null = null
/** Transactions the last session read, until this session's first read seeds its cache from them. */
let savedTxs: { namespace: string; saved: SavedLedgerTxs } | null = null

async function readSaved(namespace: string): Promise<SavedLedger> {
  try {
    const saved = await loadLedgerSnapshot(namespace)
    return { rows: (saved.rows ?? []).filter((row) => !isGhostTxSuppressed(row.txid!)), txs: saved.txs }
  } catch (err) {
    console.warn('[activity-ledger] last read unavailable', err instanceof Error ? err.message : err)
    return { rows: [], txs: null }
  }
}

/**
 * Read the saved projection before the runtime is published, so the account
 * start can paint it in the same turn the feed first reads. Without it a fresh
 * launch paints the annotation log alone and the history arrives a frame later.
 */
export async function preloadActivityLedger(namespace: string): Promise<void> {
  primed = { namespace, saved: await readSaved(namespace) }
}

function paintRestored(namespace: string, saved: SavedLedger): void {
  if (saved.txs && txCache?.namespace !== namespace) savedTxs = { namespace, saved: saved.txs }
  const rows = saved.rows ?? []
  const shown = withProvisional(namespace, rows, null)
  if (shown.length === 0) return
  // Only rows this session added are worth writing back.
  installSnapshot(namespace, shown, { persist: shown.length !== rows.length })
  if (rows.length > 0) console.info(`[activity-ledger] restored ${rows.length} row(s) from the last read`)
}

/**
 * Paint the last session's read until the live one lands. Synchronous when
 * unlock preloaded this namespace — even an empty preload is not read twice.
 * A live read is never replaced, and a restored read is not written back.
 */
export function paintSavedActivityLedger(runtime: WalletRuntime): void {
  const namespace = runtime.storageNamespace
  const preloaded = primed?.namespace === namespace ? primed.saved : null
  primed = null
  if (preloaded) {
    paintRestored(namespace, preloaded)
    return
  }
  void readSaved(namespace).then((saved) => {
    if (!runtimeIsCurrent(runtime) || currentSnapshot()) return
    paintRestored(namespace, saved)
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
 * that left the settled set are dropped and the rest are kept — across
 * launches too, from the saved copy. `full` rereads everything, for a
 * recompose that rewrote the store.
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
  const started = Date.now()
  if (full || !txCache || txCache.namespace !== namespace || txCache.userId !== userId) {
    const seed =
      !full && savedTxs?.namespace === namespace && savedTxs.saved.userId === userId ? savedTxs.saved.txs : []
    txCache = { namespace, userId, byId: new Map(seed.map((tx) => [tx.transactionId!, tx])) }
    savedTxs = null
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
  const ms = Date.now() - started
  if (ms >= 250) {
    console.info(`[activity-ledger] transactions ${missing.length} new of ${settled.size} done ${ms}ms`)
  }
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

/** Longest one storage session waits out sends before it reads anyway. */
const SEND_WAIT_MS = 30_000

/**
 * Let a waiting send take the lock first, for a while. An import keeps a send
 * waiting for hours, and abandoning the read whenever one waited left the
 * ledger at its last read for the whole run — every record shed from the
 * Activity store meanwhile was gone from the feed. One page is one short lock.
 */
async function yieldToWaitingSends(runtime: WalletRuntime): Promise<void> {
  const until = Date.now() + SEND_WAIT_MS
  while (sendIsWaiting() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, SPEND_YIELD_MS))
    assertCurrent(runtime)
  }
}

/**
 * Item outputs, one page per storage session.
 *
 * A single `findOutputs` of the whole 1sat basket holds the writer lock for
 * the entire history. The spend gate then waits out its ceiling and reports
 * "wallet storage is busy" on a funded wallet. Between pages the lock is free,
 * and a send that arrives mid-scan goes first.
 */
async function readItemOutputs(
  storage: StorageSession,
  runtime: WalletRuntime,
  userId: number,
  itemBaskets: LedgerBasket[],
): Promise<LedgerOutput[]> {
  const outputs: LedgerOutput[] = []
  for (const basket of itemBaskets) {
    let offset = 0
    for (;;) {
      await yieldToWaitingSends(runtime)
      const page = asRows<LedgerOutput>(
        await withStorageLockLabel('activityLedger(items)', () => storage.runAsStorageProvider(async (raw) => {
          const sp = raw as unknown as LedgerReader
          return sp.findOutputs({
            partial: { userId, basketId: basket.basketId },
            noScript: true,
            paged: { limit: OUTPUT_PAGE, offset },
          })
        })),
      )
      outputs.push(...page)
      if (page.length < OUTPUT_PAGE) break
      offset += page.length
      await yieldToUi()
    }
  }
  return outputs
}

/**
 * A cached transaction whose txid is not the one its outputs name: the store
 * was rewritten under the same ids by a path that did not ask for a full read.
 */
function cachedTxidsDisagree(txs: readonly LedgerTx[], outputs: readonly LedgerOutput[]): boolean {
  const txidById = new Map<number, string>()
  for (const tx of txs) {
    const txid = tx.txid?.trim().toLowerCase()
    if (txid) txidById.set(Number(tx.transactionId), txid)
  }
  for (const out of outputs) {
    const expected = txidById.get(Number(out.transactionId))
    const txid = out.txid?.trim().toLowerCase()
    if (expected && txid && txid !== expected) return true
  }
  return false
}

async function readLedger(runtime: WalletRuntime, full: boolean): Promise<ActivityEntry[] | null> {
  const active = runtime.instance
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  await yieldToWaitingSends(runtime)
  const read = await withStorageLockLabel('activityLedger(head)', () => storage.runAsStorageProvider(async (raw) => {
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
  })) as {
    sp: LedgerReader
    userId: number
    txs: LedgerTx[] | null
    baskets: LedgerBasket[]
  }
  const itemBaskets = read.baskets.filter((b) => {
    const name = String(b.name ?? '').toLowerCase()
    return name === COLLECTABLE_BASKET || name === TOKEN_BASKET
  })
  const itemsStarted = Date.now()
  const outputs = await readItemOutputs(storage, runtime, read.userId, itemBaskets)
  const itemsMs = Date.now() - itemsStarted
  if (itemsMs >= 250) console.info(`[activity-ledger] item outputs ${outputs.length} done ${itemsMs}ms`)
  // Read-only IndexedDB transactions are consistent on their own, so the
  // transaction records are fetched outside the storage lock: a spend waiting
  // for the writer never queues behind the first read of a long history.
  let all = read.txs ?? (await settledTransactions(read.sp, runtime, read.userId, full))
  if (!read.txs && !full && cachedTxidsDisagree(all, outputs)) {
    console.warn('[activity-ledger] saved transactions disagree with storage — rereading every record')
    all = await settledTransactions(read.sp, runtime, read.userId, true)
  }
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
  if (uiBudgetExpired()) await yieldToUi()
  assertCurrent(runtime)
  const projectStarted = Date.now()
  const rows = (await ledgerActivityRowsSliced(txs, outputs, baskets)).filter(
    (row) => !isGhostTxSuppressed(row.txid!),
  )
  const projectMs = Date.now() - projectStarted
  if (projectMs >= 250) {
    console.info(`[activity-ledger] project ${txs.length} tx ${outputs.length} out done ${projectMs}ms`)
  }
  return rows
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
      publishActivityLedger(runtime.storageNamespace, rows, started)
      const ms = Date.now() - started
      if (!logged || ms >= 250) {
        logged = true
        console.info(`[activity-ledger] ${rows.length} row(s) from wallet history done ${ms}ms`)
      }
    } catch (err) {
      if (!runtimeIsCurrent(runtime)) {
        console.info(`[activity-ledger] read abandoned after ${Date.now() - started}ms — the wallet runtime changed`)
        return
      }
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

/** Longest a scheduled read stands aside for sends before it starts anyway. */
const MAX_SEND_DEFER_MS = 60_000
let deferredSince = 0

/**
 * Re-read after Activity changes settle. Sends go first, but not forever: an
 * import keeps one waiting for hours, and the read pages around them.
 */
export function scheduleActivityLedgerRefresh(): void {
  if (timer || !getWalletRuntime()) return
  // A read that keeps failing (no owner row, storage closed) backs off instead
  // of warning every ten seconds for the whole session.
  const gap = Math.min(MAX_FAILURE_GAP_MS, MIN_REFRESH_GAP_MS * 2 ** failures)
  const wait = Math.max(SETTLE_MS, lastRefreshAt + gap - Date.now())
  timer = setTimeout(function fire() {
    timer = setTimeout(fire, SPEND_YIELD_MS)
    void import('./recompose').then(({ isRecomposeInFlight }) => {
      if (isRecomposeInFlight()) return
      if (sendIsWaiting()) {
        deferredSince ||= Date.now()
        if (Date.now() - deferredSince < MAX_SEND_DEFER_MS) return
      }
      deferredSince = 0
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
  deferredSince = 0
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
  savedTxs = null
  provisional.clear()
  snapshot = null
  txCache = null
  lastRefreshAt = 0
  deferredSince = 0
  logged = false
  failures = 0
}
