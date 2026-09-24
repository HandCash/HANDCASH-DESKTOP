import { getDisplayCurrency } from './displayCurrency'
import { formatPrimaryFromSats } from './fx'

export type SpendAnnouncement = {
  txid: string
  sats: number
  method: string
  note?: string
  item?: { name?: string; tokenId?: string }
}

/** One native notification per transaction, even when a batch has many legs. */
const announcedTxids = new Set<string>()

/**
 * Tell the shell that an outgoing transaction completed.
 *
 * Activity is the common terminal projection for BSV, item, token, market and
 * BRC-100 app spends. Dispatching from that boundary covers every path without
 * making protocol modules know about Android. Mobile turns `handcash:spend`
 * into a system notification while HandCash is backgrounded; Desktop ignores
 * it.
 */
export function announceSpendCompleted(spend: SpendAnnouncement): void {
  const txid = spend.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid) || announcedTxids.has(txid)) return
  announcedTxids.add(txid)

  const itemName = spend.item?.name?.trim()
  const title = spend.item?.tokenId
    ? 'Token sent'
    : itemName
      ? 'Collectable sent'
      : 'Payment sent'
  const amount = Math.max(0, Math.trunc(spend.sats))
  const amountLabel =
    !itemName && amount > 0
      ? formatPrimaryFromSats(amount, getDisplayCurrency())
      : undefined
  const note = spend.note?.trim()
  const body = itemName
    ? `${itemName} was sent`
    : amountLabel && note
      ? `${amountLabel} · ${note}`
      : amountLabel ?? note ?? 'Your wallet has been updated'

  try {
    document.dispatchEvent(
      new CustomEvent('handcash:spend', {
        detail: { title, body, txid, method: spend.method },
      }),
    )
  } catch {
    // Node tests / no DOM
  }
}

export function resetSpendAnnouncementsForTests(): void {
  announcedTxids.clear()
}
