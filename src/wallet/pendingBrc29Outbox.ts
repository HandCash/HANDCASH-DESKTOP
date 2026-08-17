/**
 * Local remittance outbox — retry sendMessage after a BRC-29 broadcast if the
 * box missed the first delivery. Never creates a second payment tx.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import type { Brc29Remittance } from './sendBrc29Payment'
import { mapPool } from './asyncPool'

const KEY = 'handcash.brc29.pendingOutbox.v1'
const MAX_ATTEMPTS = 20
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
  createdAt: number
  attempts: number
}

function load(): PendingBrc29Remit[] {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as PendingBrc29Remit[]) : []
  } catch {
    return []
  }
}

function save(rows: PendingBrc29Remit[]): void {
  durableSetItem(KEY, JSON.stringify(rows.slice(0, 50)))
}

export function enqueuePendingBrc29Remit(
  row: Omit<PendingBrc29Remit, 'createdAt' | 'attempts'> &
    Partial<Pick<PendingBrc29Remit, 'createdAt' | 'attempts'>>,
): void {
  const txid = row.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return
  const rows = load().filter((r) => r.txid !== txid)
  rows.push({
    ...row,
    txid,
    createdAt: row.createdAt ?? Date.now(),
    attempts: row.attempts ?? 0,
  })
  save(rows)
}

export async function flushPendingBrc29Outbox(args: {
  rootKeyHex: string
}): Promise<number> {
  const rows = load()
  if (rows.length === 0) return 0
  const { notifyPeerBrc29Payment } = await import('./messageTransport')
  const { getActiveWallet } = await import('./session')
  const { getBeefForTxidCached } = await import('./beefCache')
  const active = getActiveWallet()

  const outcomes = await mapPool(rows, OUTBOX_FLUSH_CONCURRENCY, async (row) => {
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
      })
      if (result.delivered === 'cloud') {
        return { delivered: true as const }
      }
    } catch (err) {
      console.warn(
        '[brc29-outbox] retry failed',
        row.txid,
        err instanceof Error ? err.message : String(err),
      )
    }
    const attempts = (row.attempts ?? 0) + 1
    if (attempts < MAX_ATTEMPTS) {
      return { delivered: false as const, keep: { ...row, attempts } }
    }
    return { delivered: false as const }
  })

  let delivered = 0
  const keep: PendingBrc29Remit[] = []
  for (const o of outcomes) {
    if (o.delivered) {
      delivered += 1
      continue
    }
    if ('keep' in o && o.keep) keep.push(o.keep)
  }
  save(keep)
  return delivered
}
