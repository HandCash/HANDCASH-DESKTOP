/**
 * Local item remittance outbox — retry sendMessage after a collectable send if the
 * box missed the first delivery. Never creates a second payment tx.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  accountKeyScopeFor,
  accountLocalKey,
  accountLocalKeyFor,
  type BoundAccountKeyScope,
} from './accountLocalKeys'
import { storageRegistry } from '../storage/registry'
import { mapPool } from './asyncPool'
import {
  activeTransactionTrace,
  recordTransactionStage,
  type TransactionFlow,
} from './transactionTelemetry'
import type { ItemTransferAsset } from './messageStore'
import {
  assertRuntimeCurrent,
  getWalletRuntime,
  type WalletRuntime,
} from './walletRuntime'

const KEY_BASE = storageRegistry.pendingItemOutbox.key
const MAX_ATTEMPTS = 20
const OUTBOX_FLUSH_CONCURRENCY = 3

/**
 * Every retry re-merges ancestry and base64s the Atomic BEEF on the main
 * thread. Without a floor between attempts a row that keeps failing renders the
 * app unusable — field logs showed 2–6s `layers idle` stalls interleaved 1:1
 * with `[item-outbox] retry failed`. Back off so a stuck row costs one attempt
 * per window instead of one per flush tick.
 */
const RETRY_BACKOFF_MS = [0, 2_000, 8_000, 30_000, 120_000, 600_000] as const

function nextAttemptDelayMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 0), RETRY_BACKOFF_MS.length - 1)
  return RETRY_BACKOFF_MS[i]
}

export type PendingItemRemit = {
  payeeIdentityKey: string
  senderIdentityKey: string
  txid: string
  itemName: string
  itemOrigin?: string
  itemCollectionId?: string
  itemOutputIndex?: number
  asset?: ItemTransferAsset
  provenance?: import('./oneSatProvenance').ProvenanceV2
  messagebox?: string | null
  createdAt: number
  attempts: number
  /** Epoch ms before which a flush must skip this row (see RETRY_BACKOFF_MS). */
  nextAttemptAt?: number
  traceId?: string
  requestId?: string
  flow?: TransactionFlow
}

function storageKey(owner?: BoundAccountKeyScope): string {
  return owner ? accountLocalKeyFor(KEY_BASE, owner) : accountLocalKey(KEY_BASE)
}

function load(owner?: BoundAccountKeyScope): PendingItemRemit[] {
  try {
    const raw = durableGetItem(storageKey(owner))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as PendingItemRemit[]) : []
  } catch {
    return []
  }
}

function save(rows: PendingItemRemit[], owner?: BoundAccountKeyScope): void {
  durableSetItem(storageKey(owner), JSON.stringify(rows.slice(0, 50)))
}

/** Cheap peek for Dashboard tip-poll backoff — no network. */
export function pendingItemOutboxCount(): number {
  return load().length
}

export function enqueuePendingItemRemit(
  row: Omit<PendingItemRemit, 'createdAt' | 'attempts'> &
    Partial<Pick<PendingItemRemit, 'createdAt' | 'attempts'>>,
  owner?: BoundAccountKeyScope,
): void {
  const txid = row.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return
  const outputIndex =
    Number.isInteger(row.itemOutputIndex) && row.itemOutputIndex! >= 0
      ? row.itemOutputIndex
      : undefined
  // A batch has several remittances sharing one txid. Replacing by txid alone
  // kept only the last item when the peer box was unavailable.
  const rows = load(owner).filter(
    (r) =>
      !(
        r.txid === txid &&
        (outputIndex != null
          ? r.itemOutputIndex === outputIndex
          : r.itemOrigin === row.itemOrigin)
      ),
  )
  const trace = activeTransactionTrace()
  rows.push({
    ...row,
    txid,
    ...(outputIndex != null ? { itemOutputIndex: outputIndex } : {}),
    createdAt: row.createdAt ?? Date.now(),
    attempts: row.attempts ?? 0,
    traceId: row.traceId ?? trace?.traceId,
    requestId: row.requestId ?? trace?.requestId,
    flow: row.flow ?? trace?.flow ?? 'item_transfer',
  })
  save(rows, owner)
}

export async function flushPendingItemOutbox(args: {
  rootKeyHex: string
  runtime?: WalletRuntime
}): Promise<number> {
  const runtime = args.runtime ?? getWalletRuntime()
  if (!runtime && import.meta.env?.MODE !== 'test') throw new Error('WALLET_LOCKED')
  if (runtime) assertRuntimeCurrent(runtime)
  const owner = runtime ? accountKeyScopeFor(runtime.instance) : undefined
  const all = load(owner)
  if (all.length === 0) return 0
  const now = Date.now()
  const rows = all.filter((r) => (r.nextAttemptAt ?? 0) <= now)
  const waiting = all.filter((r) => (r.nextAttemptAt ?? 0) > now)
  if (rows.length === 0) return 0
  const { notifyPeerItemIncoming } = await import('./messageTransport')
  const { getBeefForTxidCached } = await import('./beefCache')
  const active =
    runtime?.instance ?? (await import('./session')).getActiveWallet()

  const outcomes = await mapPool(rows, OUTBOX_FLUSH_CONCURRENCY, async (row) => {
    if (runtime) assertRuntimeCurrent(runtime)
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
            '[item-outbox] no BEEF for retry',
            row.txid,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
      const result = await notifyPeerItemIncoming({
        recipientIdentityKey: row.payeeIdentityKey,
        rootKeyHex: args.rootKeyHex,
        senderIdentityKey: row.senderIdentityKey,
        messagebox: row.messagebox,
        txid: row.txid,
        itemName: row.itemName,
        itemOrigin: row.itemOrigin,
        itemCollectionId: row.itemCollectionId,
        itemOutputIndex: row.itemOutputIndex,
        asset: row.asset,
        provenance: row.provenance,
        atomicBeef,
      })
      if (result.delivered === 'cloud' || result.delivered === 'direct') {
        if (row.asset?.kind === 'fungible' && !result.beefInBox) {
          throw new Error('BSV-21 remittance missing AtomicBEEF')
        }
        recordTransactionStage('peer_delivered', {
          flow: row.flow ?? 'item_transfer',
          traceId: row.traceId,
          requestId: row.requestId,
          retryCount: (row.attempts ?? 0) + 1,
          queueWaitMs: Date.now() - row.createdAt,
          txid: row.txid,
        })
        recordTransactionStage('completed', {
          flow: row.flow ?? 'item_transfer',
          traceId: row.traceId,
          requestId: row.requestId,
          txid: row.txid,
        })
        return { delivered: true as const }
      }
    } catch (err) {
      console.warn(
        '[item-outbox] retry failed',
        row.txid,
        err instanceof Error ? err.message : String(err),
      )
    }
    const attempts = (row.attempts ?? 0) + 1
    if (attempts < MAX_ATTEMPTS) {
      return {
        delivered: false as const,
        keep: {
          ...row,
          attempts,
          nextAttemptAt: Date.now() + nextAttemptDelayMs(attempts),
        },
      }
    }
    return { delivered: false as const }
  })

  let delivered = 0
  const keep: PendingItemRemit[] = [...waiting]
  for (const o of outcomes) {
    if (o.delivered) {
      delivered += 1
      continue
    }
    if ('keep' in o && o.keep) keep.push(o.keep)
  }
  save(keep, owner)
  return delivered
}
