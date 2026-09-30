/**
 * Activity's base layer, read live from the Toolbox transaction table.
 *
 * The table is the wallet's own complete record of what it sent and received,
 * and it rides the BRC-39 replica. Stored Activity rows are annotations on top
 * of it — app origin, item identity, pending/failed sends, events — so a row
 * the store shed or never had still shows from here. Never from an indexer,
 * never with an invented time, never persisted.
 */
import type { ActivityEntry, WALLET_ACTIVITY_ORIGIN } from './appActivity'
import { isGhostTxSuppressed } from './ghostTxSuppress'
import type { ActiveWallet } from './session'
import { shouldYieldChainIngestToSpend } from './walletCoordinator'
import { getWalletRuntime, runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

const WALLET_ORIGIN: typeof WALLET_ACTIVITY_ORIGIN = 'handcash'
const SETTLED_STATUSES = ['completed', 'unproven'] as const
const COLLECTABLE_BASKET = '1sat'
const TOKEN_BASKET = 'bsv21'

export type LedgerTx = {
  transactionId?: number
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
}

export type LedgerBasket = { basketId?: number; name?: string }

function timeOf(value: LedgerTx['created_at']): number | null {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

type ItemMove = { outpoint: string; role: 'created' | 'spent' }

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
    const outpoint = txid && Number.isInteger(out.vout) ? `${txid}.${out.vout}` : null
    if (creator > 0) note(creator, basket, outpoint ? { outpoint, role: 'created' } : null)
    const spender = Number(out.spentBy)
    if (spender > 0) note(spender, basket, outpoint ? { outpoint, role: 'spent' } : null)
  }

  const rows: ActivityEntry[] = []
  for (const tx of txs) {
    const txid = tx.txid?.trim().toLowerCase()
    if (!txid || !/^[0-9a-f]{64}$/.test(txid)) continue
    const at = timeOf(tx.created_at)
    if (at == null) continue
    const net = Math.trunc(Number(tx.satoshis) || 0)
    const outgoing = tx.isOutgoing === true || net < 0
    const description = tx.description?.trim() || ''
    const items = itemsOf.get(Number(tx.transactionId))
    if (items?.moves.length) {
      const seen = new Set<string>()
      const moves = items.moves.filter((m) => !seen.has(m.outpoint) && seen.add(m.outpoint))
      // Both directions in one transaction: its description names only one.
      const oneWay = moves.every((m) => m.role === moves[0]!.role)
      for (const { outpoint, role } of moves) {
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
          item: { name: 'Collectable', origin: outpoint.replace(/\.(\d+)$/, '_$1'), outpoint },
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
    if (x.id !== y.id || x.at !== y.at || x.sats !== y.sats || x.note !== y.note) return false
  }
  return true
}

export function publishActivityLedger(namespace: string, rows: ActivityEntry[]): void {
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
  for (const cb of listeners) cb()
}

type LedgerReader = {
  findTransactions: (args: unknown) => Promise<unknown>
  findOutputs: (args: unknown) => Promise<unknown>
  findOutputBaskets: (args: unknown) => Promise<unknown>
}

const asRows = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

async function readLedger(active: ActiveWallet): Promise<ActivityEntry[] | null> {
  const storage = active.wallet?.storage
  if (!storage?.runAsStorageProvider) return null
  const { txs, outputs, baskets } = await storage.runAsStorageProvider(async (raw) => {
    const sp = raw as unknown as LedgerReader
    const [txs, baskets] = await Promise.all([
      sp.findTransactions({ partial: {}, status: [...SETTLED_STATUSES], noRawTx: true }),
      sp.findOutputBaskets({ partial: {} }),
    ])
    const itemBaskets = asRows<LedgerBasket>(baskets).filter((b) => {
      const name = String(b.name ?? '').toLowerCase()
      return name === COLLECTABLE_BASKET || name === TOKEN_BASKET
    })
    const outputs = await Promise.all(
      itemBaskets.map((b) =>
        sp.findOutputs({ partial: { basketId: b.basketId }, noScript: true }),
      ),
    )
    return {
      txs: asRows<LedgerTx>(txs),
      outputs: outputs.flatMap((o) => asRows<LedgerOutput>(o)),
      baskets: asRows<LedgerBasket>(baskets),
    }
  })
  return ledgerActivityRows(txs, outputs, baskets).filter(
    (row) => !isGhostTxSuppressed(row.txid!),
  )
}

const MIN_REFRESH_GAP_MS = 10_000
const SETTLE_MS = 2_500
const SPEND_YIELD_MS = 2_000

let inFlight: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let lastRefreshAt = 0
let logged = false

/** Read the ledger now for this runtime. Concurrent calls share one read. */
export function refreshActivityLedger(
  runtime: WalletRuntime | null = getWalletRuntime(),
): Promise<void> {
  if (!runtime) return Promise.resolve()
  if (inFlight) return inFlight
  inFlight = (async () => {
    const started = Date.now()
    lastRefreshAt = started
    try {
      const rows = await readLedger(runtime.instance)
      if (!rows || !runtimeIsCurrent(runtime)) return
      publishActivityLedger(runtime.storageNamespace, rows)
      const ms = Date.now() - started
      if (!logged || ms >= 250) {
        logged = true
        console.info(`[activity-ledger] ${rows.length} row(s) from wallet history done ${ms}ms`)
      }
    } catch (err) {
      console.warn('[activity-ledger] read failed', err instanceof Error ? err.message : err)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Re-read after Activity changes settle; never competes with a spend. */
export function scheduleActivityLedgerRefresh(): void {
  if (timer || !getWalletRuntime()) return
  const wait = Math.max(SETTLE_MS, lastRefreshAt + MIN_REFRESH_GAP_MS - Date.now())
  timer = setTimeout(function fire() {
    if (shouldYieldChainIngestToSpend()) {
      timer = setTimeout(fire, SPEND_YIELD_MS)
      return
    }
    timer = null
    void refreshActivityLedger()
  }, wait)
}

export function resetActivityLedgerForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  inFlight = null
  snapshot = null
  lastRefreshAt = 0
  logged = false
}
