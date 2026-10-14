/**
 * Local remittance outbox — retry sendMessage after a BRC-29 broadcast if the
 * box missed the first delivery. Never creates a second payment tx.
 *
 * The queue is this device's work list, not the record of what is owed: that
 * is the payment output's notice (`paymentNotice.ts`), which travels with the
 * wallet's history. `reopenOwedBrc29Notices` refills the queue from it after a
 * restore or a handover, and the flush reconciles against it every few minutes
 * so a row this device lost comes back.
 *
 * An owed notice is never given up on: retries back off to once an hour, and
 * a row leaves the queue only when the record says delivered or the payment
 * itself failed. After `STALL_ATTEMPTS` the row is reported as stalled so the
 * payment's details can ask for attention.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  accountKeyScopeFor,
  accountLocalKey,
  accountLocalKeyFor,
  type BoundAccountKeyScope,
} from './accountLocalKeys'
import { storageRegistry } from '../storage/registry'
import type { Brc29Remittance } from './sendBrc29Payment'
import { mapPool } from './asyncPool'
import {
  listPendingPaymentNotices,
  markPaymentNoticeDelivered,
  paymentNoticeStatus,
  type NoticeWallet,
  type PaymentNoticeStatus,
} from './paymentNotice'
import {
  journalNoticeDone,
  noticeJournalBeef,
  noticeJournalSettled,
  owedJournalNotices,
  syncNoticeJournal,
} from './noticeJournal'
import {
  activeTransactionTrace,
  recordTransactionStage,
  type TransactionFlow,
} from './transactionTelemetry'
import {
  assertRuntimeCurrent,
  getWalletRuntime,
  type WalletRuntime,
} from './walletRuntime'

const KEY_BASE = storageRegistry.pendingBrc29Outbox.key
/** Failed attempts after which a notice is reported as stalled. It is still retried. */
export const STALL_ATTEMPTS = 20
const RETRY_BASE_MS = 30_000
const RETRY_CAP_MS = 60 * 60_000
/** How often a flush re-reads the owed notices from the wallet's records. */
const RECONCILE_EVERY_MS = 10 * 60_000
/** Concurrent remittance retries — BEEF fetch + box POST are independent per row. */
const OUTBOX_FLUSH_CONCURRENCY = 3

export type PendingBrc29Remit = {
  payeeIdentityKey: string
  senderIdentityKey: string
  txid: string
  satoshis: number
  remittance: Brc29Remittance
  messagebox?: string | null
  amountLabel?: string
  chatRef?: boolean
  createdAt: number
  attempts: number
  /** Epoch ms of the last failed attempt. */
  lastTriedAt?: number
  /** Not retried before this epoch ms; absent = due now. */
  nextAttemptAt?: number
  lastError?: string
  traceId?: string
  requestId?: string
  flow?: TransactionFlow
}

/** What the payment's details show while its notice is still owed. */
export type Brc29NoticeDelivery = {
  attempts: number
  lastTriedAt: number | null
  nextAttemptAt: number
  stalled: boolean
  lastError: string | null
}

/** Delay after the `attempts`-th failure: 30 s doubling to an hour. */
export function brc29NoticeRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 32) - 1)
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_CAP_MS)
}

function storageKey(owner?: BoundAccountKeyScope): string {
  return owner ? accountLocalKeyFor(KEY_BASE, owner) : accountLocalKey(KEY_BASE)
}

function load(owner?: BoundAccountKeyScope): PendingBrc29Remit[] {
  try {
    const raw = durableGetItem(storageKey(owner))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as PendingBrc29Remit[]) : []
  } catch {
    return []
  }
}

const listeners = new Set<() => void>()
let revision = 0

function save(rows: PendingBrc29Remit[], owner?: BoundAccountKeyScope): void {
  if (!durableSetItem(storageKey(owner), JSON.stringify(rows))) {
    console.warn(
      `[brc29-outbox] queue write refused (${rows.length} rows) — owed notices come back on the next reconcile`,
    )
  }
  revision += 1
  for (const listener of listeners) listener()
}

/** Notices of payments awaiting a miner verdict: no flush sends them until it lands. */
const awaitingVerdict = new Set<string>()

/**
 * Hold the notice for `txid` until the returned release runs. A resumed
 * payment is announced only once miners have not proved it dead.
 */
export function holdBrc29NoticeForVerdict(txid: string): () => void {
  const id = txid.trim().toLowerCase()
  awaitingVerdict.add(id)
  return () => {
    awaitingVerdict.delete(id)
  }
}

const isDue = (row: PendingBrc29Remit, now: number): boolean =>
  (row.nextAttemptAt ?? 0) <= now && !awaitingVerdict.has(row.txid)

/** Every notice this account's queue still owes. */
export function owedBrc29NoticeRows(owner: BoundAccountKeyScope): readonly PendingBrc29Remit[] {
  return load(owner)
}

/** Due rows only — Dashboard tip-poll backoff; a backed-off queue must not keep the poll fast. No network. */
export function dueBrc29NoticeCount(now = Date.now()): number {
  return load().filter((row) => isDue(row, now)).length
}

let snapshot: { key: string; revision: number; byTxid: Map<string, Brc29NoticeDelivery> } | null = null

/**
 * Delivery standing of the owed notice for `txid` in the open account, or null
 * when none is queued. Stable between queue writes (`useSyncExternalStore`).
 */
export function brc29NoticeDelivery(txid: string): Brc29NoticeDelivery | null {
  const key = storageKey()
  if (!snapshot || snapshot.key !== key || snapshot.revision !== revision) {
    const byTxid = new Map<string, Brc29NoticeDelivery>()
    for (const row of load()) {
      const attempts = row.attempts ?? 0
      byTxid.set(row.txid, {
        attempts,
        lastTriedAt: row.lastTriedAt ?? null,
        nextAttemptAt: row.nextAttemptAt ?? 0,
        stalled: attempts >= STALL_ATTEMPTS,
        lastError: row.lastError ?? null,
      })
    }
    snapshot = { key, revision, byTxid }
  }
  return snapshot.byTxid.get(txid.trim().toLowerCase()) ?? null
}

export function subscribeBrc29NoticeQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function enqueuePendingBrc29Remit(
  row: Omit<PendingBrc29Remit, 'createdAt' | 'attempts'> &
    Partial<Pick<PendingBrc29Remit, 'createdAt' | 'attempts'>>,
  owner?: BoundAccountKeyScope,
): void {
  const txid = row.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return
  const rows = load(owner).filter((r) => r.txid !== txid)
  const trace = activeTransactionTrace()
  rows.push({
    ...row,
    txid,
    createdAt: row.createdAt ?? Date.now(),
    attempts: row.attempts ?? 0,
    traceId: row.traceId ?? trace?.traceId,
    requestId: row.requestId ?? trace?.requestId,
    flow: row.flow ?? trace?.flow ?? 'brc29',
  })
  save(rows, owner)
}

/** Null when unreadable: the row is sent, since a duplicate notice is one card, a lost one is lost money. */
async function noticeStatus(active: NoticeWallet, row: PendingBrc29Remit): Promise<PaymentNoticeStatus | null> {
  try {
    return await paymentNoticeStatus(active, row.txid, row.remittance.outputIndex ?? 0)
  } catch {
    return null
  }
}

async function markDelivered(
  active: NoticeWallet,
  owner: BoundAccountKeyScope | undefined,
  row: PendingBrc29Remit,
): Promise<void> {
  if (owner) journalNoticeDone(owner, row.txid, row.remittance.outputIndex ?? 0)
  try {
    await markPaymentNoticeDelivered(active, row.txid, row.remittance.outputIndex ?? 0)
  } catch (err) {
    console.warn(
      `[brc29-outbox] notice ${row.txid.slice(0, 12)}… delivered but not marked — a recovery may re-send it`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

const lastReopenAt = new Map<string, number>()

/**
 * Queue every notice the wallet's history or the notice journal says is still
 * owed and this device has not queued. Run after the history changed under
 * this device — a restore, a recompose, a handover merge — and periodically
 * from the flush. Returns how many were added.
 */
export async function reopenOwedBrc29Notices(runtime: WalletRuntime): Promise<number> {
  assertRuntimeCurrent(runtime)
  const started = Date.now()
  const active = runtime.instance
  const owner = accountKeyScopeFor(active)
  lastReopenAt.set(storageKey(owner), started)
  const recorded = await listPendingPaymentNotices(active)
  assertRuntimeCurrent(runtime)
  const owed = [...recorded]
  const known = new Set(recorded.map((notice) => notice.txid))
  for (const notice of owedJournalNotices(owner)) {
    if (known.has(notice.txid)) continue
    known.add(notice.txid)
    owed.push({ ...notice, createdAt: 0 })
  }
  const rows = load(owner)
  const queued = new Set(rows.map((r) => r.txid))
  const fresh = owed.filter((notice) => !queued.has(notice.txid))
  if (fresh.length > 0) {
    const { listFriends } = await import('./friends')
    const boxOf = new Map(listFriends().map((f) => [f.identityKey.toLowerCase(), f.messagebox]))
    for (const notice of fresh) {
      rows.push({
        payeeIdentityKey: notice.payee,
        senderIdentityKey: active.identityKey,
        txid: notice.txid,
        satoshis: notice.satoshis,
        remittance: {
          derivationPrefix: notice.derivationPrefix,
          derivationSuffix: notice.derivationSuffix,
          outputIndex: notice.vout,
        },
        messagebox: boxOf.get(notice.payee),
        chatRef: notice.chatRef || undefined,
        createdAt: notice.createdAt || Date.now(),
        attempts: 0,
        flow: 'brc29',
      })
    }
    save(rows, owner)
  }
  const ms = Date.now() - started
  if (fresh.length > 0 || ms >= 250) {
    console.info(`[brc29-outbox] reopen done ${ms}ms — ${owed.length} owed, ${fresh.length} queued`)
  }
  return fresh.length
}

/**
 * Pull the notice journal, reopen, then deliver what was added. Never throws:
 * a notice left owed stays owed for the next run.
 */
export async function deliverOwedBrc29Notices(runtime: WalletRuntime): Promise<void> {
  try {
    await syncNoticeJournal(runtime.instance, 'recover')
    if ((await reopenOwedBrc29Notices(runtime)) === 0) return
    await flushPendingBrc29Outbox({ rootKeyHex: runtime.instance.rootKeyHex, runtime })
  } catch (err) {
    console.warn('[brc29-outbox] owed notices deferred', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Try the notice for `txid` now, ignoring its backoff. True once nothing is
 * owed for it any more — delivered now, already delivered, or the payment failed.
 */
export async function retryBrc29NoticeNow(runtime: WalletRuntime, txid: string): Promise<boolean> {
  const id = txid.trim().toLowerCase()
  await flushPendingBrc29Outbox({ rootKeyHex: runtime.instance.rootKeyHex, runtime, only: id })
  return !load(accountKeyScopeFor(runtime.instance)).some((row) => row.txid === id)
}

const flights = new Map<string, Promise<number>>()

/**
 * Send every due notice (or just `only`, due or not). One flush per account at
 * a time: a second call waits for the first, so no two flushes post one notice.
 */
export async function flushPendingBrc29Outbox(args: {
  rootKeyHex: string
  runtime?: WalletRuntime
  only?: string
}): Promise<number> {
  const runtime = args.runtime ?? getWalletRuntime()
  if (!runtime && import.meta.env?.MODE !== 'test') throw new Error('WALLET_LOCKED')
  if (runtime) assertRuntimeCurrent(runtime)
  const owner = runtime ? accountKeyScopeFor(runtime.instance) : undefined
  const key = storageKey(owner)
  const run = (flights.get(key) ?? Promise.resolve(0))
    .catch(() => 0)
    .then(() => flushOnce(args, runtime ?? undefined, owner))
  flights.set(key, run)
  try {
    return await run
  } finally {
    if (flights.get(key) === run) flights.delete(key)
  }
}

type FlushOutcome =
  | { kind: 'delivered' }
  | { kind: 'settled'; reason: 'already-delivered' | 'payment-failed' }
  | { kind: 'retry'; row: PendingBrc29Remit }

async function reconcileIfStale(runtime: WalletRuntime, key: string): Promise<void> {
  if (Date.now() - (lastReopenAt.get(key) ?? 0) < RECONCILE_EVERY_MS) return
  try {
    await reopenOwedBrc29Notices(runtime)
  } catch (err) {
    console.warn('[brc29-outbox] reconcile deferred', err instanceof Error ? err.message : String(err))
  }
}

function failedAttempt(row: PendingBrc29Remit, error: string): PendingBrc29Remit {
  const now = Date.now()
  const attempts = (row.attempts ?? 0) + 1
  if (attempts === STALL_ATTEMPTS) {
    console.warn(
      `[brc29-outbox] notice ${row.txid.slice(0, 12)}… stalled after ${attempts} attempts — still retrying hourly: ${error}`,
    )
    recordTransactionStage('peer_delivery_queued', {
      flow: row.flow ?? 'brc29',
      traceId: row.traceId,
      requestId: row.requestId,
      retryCount: attempts,
      queueWaitMs: now - row.createdAt,
      txid: row.txid,
      blockerCode: 'notice_stalled',
    })
  }
  return {
    ...row,
    attempts,
    lastTriedAt: now,
    nextAttemptAt: now + brc29NoticeRetryDelayMs(attempts),
    lastError: error.slice(0, 160),
  }
}

async function flushOnce(
  args: { rootKeyHex: string; only?: string },
  runtime: WalletRuntime | undefined,
  owner: BoundAccountKeyScope | undefined,
): Promise<number> {
  const started = Date.now()
  if (runtime) await reconcileIfStale(runtime, storageKey(owner))
  const only = args.only?.trim().toLowerCase()
  const now = Date.now()
  const due = load(owner).filter((row) =>
    only ? row.txid === only && !awaitingVerdict.has(row.txid) : isDue(row, now),
  )
  if (due.length === 0) return 0
  if (runtime) assertRuntimeCurrent(runtime)
  const { notifyPeerBrc29Payment } = await import('./messageTransport')
  const { getBeefForTxidCached } = await import('./beefCache')
  const active =
    runtime?.instance ?? (await import('./session')).getActiveWallet()

  const outcomes = await mapPool(due, OUTBOX_FLUSH_CONCURRENCY, async (row): Promise<[string, FlushOutcome]> => {
    if (runtime) assertRuntimeCurrent(runtime)
    const status = active ? await noticeStatus(active, row) : null
    if (status === 'delivered' || status === 'void') {
      const reason = status === 'delivered' ? 'already-delivered' : 'payment-failed'
      console.info(`[brc29-outbox] notice ${row.txid.slice(0, 12)}… ${reason} — dropped`)
      if (owner) journalNoticeDone(owner, row.txid, row.remittance.outputIndex ?? 0)
      return [row.txid, { kind: 'settled', reason }]
    }
    // Another device delivered it; its tombstone arrived before this record caught up.
    if (owner && noticeJournalSettled(owner, row.txid, row.remittance.outputIndex ?? 0)) {
      console.info(`[brc29-outbox] notice ${row.txid.slice(0, 12)}… settled by the journal — dropped`)
      if (active && status === 'pending') await markDelivered(active, owner, row)
      return [row.txid, { kind: 'settled', reason: 'already-delivered' }]
    }
    let error = 'Their message box did not take the notice'
    try {
      let atomicBeef: number[] | undefined
      if (active) {
        try {
          const beef = await getBeefForTxidCached(active, row.txid, {
            allowUnprovenRawTx: true,
          })
          atomicBeef = Array.from(beef.toBinaryAtomic(row.txid))
        } catch (err) {
          console.warn(
            '[brc29-outbox] no BEEF for retry',
            row.txid,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
      // A recovered device may not hold the payment at all; the journal carried its BEEF.
      if (!atomicBeef && owner) atomicBeef = noticeJournalBeef(owner, row.txid) ?? undefined
      const result = await notifyPeerBrc29Payment({
        recipientIdentityKey: row.payeeIdentityKey,
        rootKeyHex: args.rootKeyHex,
        senderIdentityKey: row.senderIdentityKey,
        messagebox: row.messagebox,
        txid: row.txid,
        satoshis: row.satoshis,
        remittance: row.remittance,
        atomicBeef,
        amountLabel: row.amountLabel,
        chatRef: row.chatRef,
      })
      if (result.delivered === 'cloud' || result.delivered === 'direct') {
        if (active) await markDelivered(active, owner, row)
        else if (owner) journalNoticeDone(owner, row.txid, row.remittance.outputIndex ?? 0)
        recordTransactionStage('peer_delivered', {
          flow: row.flow ?? 'brc29',
          traceId: row.traceId,
          requestId: row.requestId,
          retryCount: (row.attempts ?? 0) + 1,
          queueWaitMs: Date.now() - row.createdAt,
          txid: row.txid,
        })
        recordTransactionStage('completed', {
          flow: row.flow ?? 'brc29',
          traceId: row.traceId,
          requestId: row.requestId,
          txid: row.txid,
        })
        return [row.txid, { kind: 'delivered' }]
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      console.warn('[brc29-outbox] retry failed', row.txid, error)
    }
    return [row.txid, { kind: 'retry', row: failedAttempt(row, error) }]
  })

  // Merge into the queue as it is now: a send may have queued a row meanwhile.
  const settled = new Map(outcomes)
  const rows = load(owner).flatMap((row) => {
    const outcome = settled.get(row.txid)
    if (!outcome) return [row]
    return outcome.kind === 'retry' ? [outcome.row] : []
  })
  save(rows, owner)
  const delivered = outcomes.filter(([, o]) => o.kind === 'delivered').length
  const ms = Date.now() - started
  if (delivered > 0 || ms >= 250) {
    const retrying = outcomes.filter(([, o]) => o.kind === 'retry').length
    console.info(`[brc29-outbox] flush done ${ms}ms — ${delivered} delivered, ${retrying} retrying, ${rows.length} queued`)
  }
  return delivered
}
