/**
 * A token or item self-send can echo back through the inbox as "Receiving"
 * after the Sending row is gone. The signed cheque is still ours: broadcast it
 * if the inputs can still land, or hide the receive if the spend is dead so
 * the next poll cannot pin "Receiving" again.
 *
 * Explorer absence is not death. Only a proven competing spend, or an Arcade
 * hard-reject, hides the row.
 */
import { txIsArcadeRejected, signedTxSpendConflictIsProven } from './arcadeSubmitGuard'
import {
  clearInboundReceivePending,
  exportAllActivity,
  listPendingInboundReceives,
  noteOutboundSendComplete,
  type ActivityItem,
} from './appActivity'
import { isGhostTxSuppressed, rememberGhostTx } from './ghostTxSuppress'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { signedChequeAtomic } from './signedChequeArchive'
import { getWalletRuntime } from './walletRuntime'

/** Let the original send propagation finish before we touch the echo. */
export const SELF_SEND_RECEIVE_GRACE_MS = 60_000

const broadcastTried = new Set<string>()

export type SelfSendReceiveFate = 'wait' | 'broadcast' | 'hidden'

export async function reconcileSelfSendReceive(args: {
  txid: string
  firstSeenAt?: number
  item?: ActivityItem
  now?: number
}): Promise<SelfSendReceiveFate> {
  const id = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return 'wait'
  const atomic = signedChequeAtomic(id)
  if (!atomic?.length) return 'wait'

  const now = args.now ?? Date.now()
  const pending = listPendingInboundReceives().find(
    (entry) => entry.txid?.toLowerCase() === id,
  )
  const first = earliest(
    args.firstSeenAt,
    pending?.at,
  )
  if (first == null || now - first < SELF_SEND_RECEIVE_GRACE_MS) return 'wait'

  if (isGhostTxSuppressed(id) || txIsArcadeRejected(id)) {
    rememberGhostTx(id)
    clearInboundReceivePending(id)
    console.info(
      `[self-send] hide ${id.slice(0, 12)} — broadcast rejected`,
    )
    return 'hidden'
  }

  const active = getWalletRuntime()?.instance
  if (!active) return 'wait'

  const started = Date.now()
  const invalid = await signedTxSpendConflictIsProven({
    txid: id,
    atomic,
    chain: active.chain,
  })
  if (invalid) {
    rememberGhostTx(id)
    clearInboundReceivePending(id)
    console.info(
      `[self-send] hide done ${Date.now() - started}ms — ${id.slice(0, 12)} spend is invalid`,
    )
    return 'hidden'
  }

  if (!spentRowExists(id)) {
    const item = args.item ?? pending?.item
    noteOutboundSendComplete({
      pendingId: `self-send-${id.slice(0, 12)}`,
      txid: id,
      sats: Math.max(1, pending?.sats ?? 1),
      to: active.address,
      friendLabel: 'me',
      ...(item ? { item } : {}),
    })
    console.info(`[self-send] restored missing send row ${id.slice(0, 12)}`)
  }

  if (broadcastTried.has(id)) return 'broadcast'
  broadcastTried.add(id)
  const posted = await broadcastAtomicBeef(id, atomic, { skipIfOnChain: true })
  if (!posted || isGhostTxSuppressed(id)) {
    clearInboundReceivePending(id)
    console.info(
      `[self-send] hide done ${Date.now() - started}ms — ${id.slice(0, 12)} broadcast rejected`,
    )
    return 'hidden'
  }
  console.info(
    `[self-send] broadcast done ${Date.now() - started}ms — ${id.slice(0, 12)}`,
  )
  return 'broadcast'
}

/** Every aged self-send receive, including ones the inbox is no longer offering. */
export async function reconcileStuckSelfSendReceives(
  now = Date.now(),
): Promise<number> {
  const txids = [
    ...new Set(
      listPendingInboundReceives().map((entry) => entry.txid!.toLowerCase()),
    ),
  ]
  let acted = 0
  for (const txid of txids) {
    try {
      const fate = await reconcileSelfSendReceive({ txid, now })
      if (fate !== 'wait') acted += 1
    } catch (err) {
      console.warn('[self-send] reconcile skipped', txid.slice(0, 12), err)
    }
  }
  return acted
}

function spentRowExists(txid: string): boolean {
  return exportAllActivity().some(
    (entry) => entry.kind === 'spent' && entry.txid?.toLowerCase() === txid,
  )
}

function earliest(...values: Array<number | undefined>): number | null {
  let best: number | null = null
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    best = best == null ? value : Math.min(best, value)
  }
  return best
}

/** Test-only. */
export function resetSelfSendReceiveForTests(): void {
  broadcastTried.clear()
}
