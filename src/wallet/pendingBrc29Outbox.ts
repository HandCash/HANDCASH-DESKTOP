/**
 * Local remittance outbox — retry sendMessage after a BRC-29 broadcast if the
 * box missed the first delivery. Never creates a second payment tx.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import type { Brc29Remittance } from './sendBrc29Payment'

const KEY = 'handcash.brc29.pendingOutbox.v1'
const MAX_ATTEMPTS = 20

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
  let delivered = 0
  const keep: PendingBrc29Remit[] = []
  const { notifyPeerBrc29Payment } = await import('./messageTransport')
  const { getActiveWallet } = await import('./session')
  const { getBeefForTxidCached } = await import('./beefCache')
  const active = getActiveWallet()
  for (const row of rows) {
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
        delivered += 1
        continue
      }
    } catch (err) {
      console.warn(
        '[brc29-outbox] retry failed',
        row.txid,
        err instanceof Error ? err.message : String(err),
      )
    }
    const attempts = (row.attempts ?? 0) + 1
    if (attempts < MAX_ATTEMPTS) keep.push({ ...row, attempts })
  }
  save(keep)
  return delivered
}
