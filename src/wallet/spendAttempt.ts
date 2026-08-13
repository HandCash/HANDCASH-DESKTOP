/**
 * What the user may do about a spend that never confirmed — items and payments.
 *
 * A chain 404 alone never authorizes another spend. Retry is offered only when
 * the wallet can prove the original funds are still spendable, and the exact
 * recipient data was persisted with the attempt. Everything else is offered as
 * a clear: drop the dead row and release the local reservations it left behind,
 * which is what used to surface as "a previous failed send is blocking this
 * payment".
 */
import {
  countFailedActivity,
  isFailedActivity,
  removeActivityById,
  removeFailedActivity,
  type ActivityEntry,
  type ActivityRetry,
} from './appActivity'
import { isCollectableOutpointSpendable, sendCollectable } from './collectables'
import { counterpartyMaySettle } from './sentItemGuard'
import { getBeefForTxidCached } from './beefCache'
import { txExistsOnChain } from './legacyScan'
import { broadcastAtomicBeef } from './sendBrc29Payment'
import { getActiveWallet } from './session'
import { itemSendMachine, maySenderBroadcast } from './itemSendMachine'
import type { Chain } from './vault'
import { createActor } from 'xstate'

export type SpendAttemptFate =
  | { kind: 'notAttempt' }
  | { kind: 'checking' }
  | { kind: 'confirmed' }
  | {
      kind: 'refuse'
      reason:
        | 'statusUnknown'
        | 'missingRetryDetails'
        | 'sourceNotSpendable'
        /**
         * The transfer left this wallet and the payee may still broadcast it.
         * Neither retry nor clear is safe: retry would race a live transaction,
         * and clearing would delete the sender's only record of an item that can
         * still land in the recipient's wallet.
         */
        | 'counterpartyMaySettle'
      message: string
      mayClear: boolean
      /**
       * Reserved coins may be released even when the row must stay. Repair only
       * fails *unsigned* transactions, so it frees a stuck balance without
       * touching a signed transfer the payee still holds.
       */
      mayReleaseFunds?: boolean
    }
  | {
      kind: 'retry'
      /**
       * `rebroadcast` re-submits the transaction this attempt already signed.
       * `recreateItem` re-runs a collectable send that died before signing.
       * `reopenPayment` hands a coin send back to the Send screen — the wallet
       * must never silently re-spend coins on the user's behalf.
       */
      action: 'rebroadcast' | 'recreateItem' | 'reopenPayment'
      retry: ActivityRetry
      message: string
      mayClear: true
    }

const ITEM_METHOD = 'send-collectable'
const BSV_METHOD = 'send'

/**
 * How long a broadcast row is left alone before a chain 404 counts as trouble.
 * Item sends can be settled by the payee (`peerDeliver`), so their transaction
 * is legitimately absent for far longer than a coin payment's.
 */
const ITEM_UNCONFIRMED_GRACE_MS = 10 * 60_000
const BSV_UNCONFIRMED_GRACE_MS = 2 * 60_000

export function isSpendAttempt(
  entry: ActivityEntry | null,
  now = Date.now(),
): boolean {
  if (!entry || entry.kind !== 'spent' || entry.status === 'pending') return false
  const isItem = entry.method === ITEM_METHOD
  if (isItem ? !entry.item : entry.method !== BSV_METHOD) return false
  if (isFailedActivity(entry)) return true
  const grace = isItem ? ITEM_UNCONFIRMED_GRACE_MS : BSV_UNCONFIRMED_GRACE_MS
  return now - entry.at >= grace
}

/**
 * True when the payee still owns the outcome of this item transfer.
 *
 * A failed row is not automatically a dead row: on a `peerDeliver` settle the
 * signed transfer is already in the recipient's inbox, so it can land hours
 * later. Offering retry or clear in that window is how a sender either races a
 * live transaction or deletes the only local record of an item that is really
 * gone.
 */
export function isCounterpartySettlePending(
  entry: ActivityEntry,
  now = Date.now(),
): boolean {
  if (entry.method !== ITEM_METHOD) return false
  const outpoint =
    entry.retry?.kind === 'send-collectable'
      ? entry.retry.outpoint
      : entry.item?.outpoint
  if (!outpoint) return false
  return counterpartyMaySettle(outpoint, now)
}

function hasTxid(entry: ActivityEntry): boolean {
  return Boolean(entry.txid && /^[0-9a-f]{64}$/i.test(entry.txid))
}

export async function resolveSpendAttemptFate(
  entry: ActivityEntry,
  chain: Chain,
): Promise<SpendAttemptFate> {
  if (!isSpendAttempt(entry)) return { kind: 'notAttempt' }

  if (isCounterpartySettlePending(entry)) {
    return {
      kind: 'refuse',
      reason: 'counterpartyMaySettle',
      message:
        'The recipient has this transfer and can still broadcast it, so it is not lost. Retrying would race a live transaction and clearing would delete your only record of it.',
      mayClear: false,
      mayReleaseFunds: true,
    }
  }

  if (hasTxid(entry)) {
    const onChain = await txExistsOnChain(entry.txid!, chain).catch(() => null)
    if (onChain === true) return { kind: 'confirmed' }
    if (onChain === null) {
      return {
        kind: 'refuse',
        reason: 'statusUnknown',
        message:
          'Confirmation status is unavailable. Retry stays disabled until the chain can be checked.',
        mayClear: false,
      }
    }
  }

  const retry = entry.retry
  if (!retry) {
    return {
      kind: 'refuse',
      reason: 'missingRetryDetails',
      message: isFailedActivity(entry)
        ? 'This send failed and cannot be retried — its original recipient details were not saved.'
        : 'This send did not confirm and cannot be retried — its original recipient details were not saved.',
      mayClear: true,
    }
  }

  if (retry.kind === 'send-bsv') {
    return {
      kind: 'retry',
      action: 'reopenPayment',
      retry,
      message: hasTxid(entry)
        ? 'This payment never landed on chain. You can send it again from the Send screen, or clear it.'
        : 'This payment failed before it reached the network. You can send it again from the Send screen, or clear it.',
      mayClear: true,
    }
  }

  const spendable = await isCollectableOutpointSpendable(retry.outpoint).catch(
    () => null,
  )
  if (spendable === null) {
    return {
      kind: 'refuse',
      reason: 'statusUnknown',
      message:
        'Item spendability could not be checked. Retry stays disabled until the wallet refreshes.',
      mayClear: false,
    }
  }
  if (!spendable) {
    return {
      kind: 'refuse',
      reason: 'sourceNotSpendable',
      message:
        'This send cannot be retried — the original item output is no longer spendable in this wallet.',
      mayClear: true,
    }
  }

  return {
    kind: 'retry',
    action: hasTxid(entry) ? 'rebroadcast' : 'recreateItem',
    retry,
    message: hasTxid(entry)
      ? 'This send did not confirm. The item is still unspent, so the signed transfer can be broadcast again.'
      : 'This send failed before it produced a transaction. The item is still spendable and can be retried.',
    mayClear: true,
  }
}

export type SpendAttemptRetryResult =
  | { kind: 'rebroadcasted'; txid: string }
  | { kind: 'recreated'; txid: string }
  | { kind: 'reopenPayment'; toAddress: string; satoshis: number }

/**
 * Retry the transaction this attempt already signed when one exists. A new
 * spend is created only for an item attempt that never produced a txid; coin
 * payments are handed back to the Send screen instead.
 */
export async function retrySpendAttempt(
  entry: ActivityEntry,
  chain: Chain,
): Promise<SpendAttemptRetryResult> {
  const fate = await resolveSpendAttemptFate(entry, chain)
  if (fate.kind !== 'retry') {
    throw new Error(
      fate.kind === 'refuse' ? fate.message : 'This send cannot be retried.',
    )
  }

  if (fate.action === 'reopenPayment' && fate.retry.kind === 'send-bsv') {
    return {
      kind: 'reopenPayment',
      toAddress: fate.retry.toAddress,
      satoshis: fate.retry.satoshis,
    }
  }

  if (fate.retry.kind !== 'send-collectable') {
    throw new Error('This send cannot be retried.')
  }

  if (fate.action === 'recreateItem') {
    const sent = await sendCollectable({
      outpoint: fate.retry.outpoint,
      toAddress: fate.retry.toAddress,
      recipientIdentityKey: fate.retry.recipientIdentityKey,
      friendLabel: fate.retry.friendLabel,
      name: entry.item?.name,
      origin: entry.item?.origin,
      app: entry.item?.app,
    })
    return { kind: 'recreated', txid: sent.txid }
  }

  const txid = entry.txid?.trim().toLowerCase() ?? ''
  const active = getActiveWallet()
  if (!active || !/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error('The signed item transfer is no longer available to rebroadcast.')
  }
  const chart = createActor(itemSendMachine).start()
  chart.send({ type: 'RETRY_BROADCAST', outpoint: fate.retry.outpoint, txid })
  if (!maySenderBroadcast(chart.getSnapshot())) {
    chart.stop()
    throw new Error('The item send statechart refused this broadcast retry.')
  }
  let atomic: number[]
  try {
    const beef = await getBeefForTxidCached(active, txid, {
      allowUnprovenRawTx: true,
    })
    atomic = Array.from(beef.toBinaryAtomic(txid))
  } catch {
    chart.send({ type: 'FAIL', error: 'Signed transaction body unavailable' })
    chart.stop()
    throw new Error(
      'The signed transaction body is no longer available. This attempt cannot be retried.',
    )
  }
  if (!(await broadcastAtomicBeef(txid, atomic))) {
    chart.send({ type: 'FAIL', error: 'Network refused broadcast retry' })
    chart.stop()
    throw new Error(
      'The network did not accept the transfer. The original output remains safe.',
    )
  }
  chart.send({ type: 'BROADCASTED' })
  chart.stop()
  return { kind: 'rebroadcasted', txid }
}

/**
 * Drop a dead attempt: release the local reservations it left on our outputs,
 * then remove the row. Repair runs first so clearing a payment actually unblocks
 * the next send rather than only hiding the evidence.
 *
 * Refuses while the payee could still broadcast the transfer — the row is then
 * the sender's only record of an item that has already left the wallet.
 */
export async function clearSpendAttempt(
  entry: ActivityEntry,
): Promise<{ removed: boolean }> {
  if (isCounterpartySettlePending(entry)) {
    throw new Error(
      'The recipient can still broadcast this transfer, so it cannot be cleared yet.',
    )
  }
  await releaseLocalSpendReservations()
  return { removed: removeActivityById(entry.id) }
}

/**
 * Free the coins a dead attempt reserved, without touching history.
 *
 * Repair only fails *unsigned* transactions, so this unblocks a balance that a
 * half-built send is sitting on while leaving any signed transfer — and every
 * Activity row — alone. It is the safe half of "clear" for an attempt whose
 * record has to stay.
 */
export async function releaseSpendAttemptFunds(): Promise<void> {
  await releaseLocalSpendReservations()
}

/**
 * Clear failed sends from history in one pass.
 *
 * Repair runs once — not once per row — then failed rows are dropped, except
 * item transfers the payee can still broadcast. Everything removed is local-only
 * bookkeeping, so this cancels nothing on chain. Returns how many rows were
 * removed and how many were kept back, so the caller can report both.
 */
export async function clearAllFailedSpends(): Promise<{
  removed: number
  kept: number
}> {
  const now = Date.now()
  const keep = (entry: ActivityEntry) => isCounterpartySettlePending(entry, now)
  const failed = countFailedActivity()
  await releaseLocalSpendReservations()
  const removed = removeFailedActivity(keep)
  // Repair can settle rows between the two reads, so never report a negative.
  return { removed, kept: Math.max(0, failed - removed) }
}

/** Best-effort release of the local reservations a dead spend left behind. */
async function releaseLocalSpendReservations(): Promise<void> {
  try {
    const { repairFailedSpendState } = await import('./actionReview')
    const repair = await repairFailedSpendState()
    if (repair.failedTxs > 0 || repair.quarantined > 0 || repair.healed > 0) {
      console.info('[spend-attempt] cleared local spend state', repair)
    }
  } catch (err) {
    // Removing the row is still correct — the repair is a best-effort unblock.
    console.warn('[spend-attempt] local spend repair skipped', err)
  }
}
