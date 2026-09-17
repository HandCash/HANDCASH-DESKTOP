/**
 * Imperative executor for the bulk-item send chart.
 *
 * The atomic item transaction remains in `collectables.ts`; this module owns
 * only the multi-transaction loop. Keeping the queue beside
 * `collectableSendRunMachine` makes the legal transitions reviewable without
 * adding another orchestration branch to the wallet's largest domain module.
 */
import { createActor } from 'xstate'
import {
  sendCollectables,
  type SendCollectablesArgs,
} from './collectables'
import {
  classifySendRunFailure,
  collectableSendRunItemCount,
  planCollectableSendRun,
  type CollectableSendRunResult,
} from './collectableSendRun'
import { collectableSendRunMachine } from './collectableSendRunMachine'
import { collectableSendBatchRefusal } from './collectableBatch'
import { splitItemMigrateBundle } from './itemMigrateBundle'
import { yieldToUi } from './yieldToUi'

export type SendCollectablesRunArgs = SendCollectablesArgs & {
  onProgress?: (progress: {
    /** Legs signed so far. */
    sentLegs: number
    sentItems: number
    failedItems: number
    /** Legs still outstanding, including halves from a split. */
    queued: number
    itemCount: number
  }) => void
}

/**
 * Send a selection of any size as a sequence of atomic transactions.
 *
 * The chart owns the loop's legality; this function only signs the leg it is
 * told to sign and reports what happened. A wallet-wide fault ends the run with
 * the remaining tips untouched; a leg-specific rejection is halved and retried
 * down to singles so one bad tip cannot strand the rest of the selection.
 */
export async function sendCollectablesRun(
  args: SendCollectablesRunArgs,
): Promise<CollectableSendRunResult> {
  const plan = planCollectableSendRun(args.outpoints)
  if (plan.kind === 'refuse') {
    throw new Error(
      collectableSendBatchRefusal({ kind: 'refuse', reason: 'empty' }),
    )
  }

  const chart = createActor(collectableSendRunMachine).start()
  chart.send({ type: 'START', legs: plan.legs.length })

  const queue = plan.legs.map((leg) => leg.outpoints)
  const result: CollectableSendRunResult = {
    sent: [],
    failed: [],
    stopped: null,
    lastError: null,
  }
  const report = () => {
    const { context } = chart.getSnapshot()
    args.onProgress?.({
      sentLegs: context.sentLegs,
      sentItems: context.sentItems,
      failedItems: context.failedItems,
      queued: context.queued,
      itemCount: plan.itemCount,
    })
  }
  report()

  while (chart.getSnapshot().value === 'sending') {
    const leg = queue.shift()
    // The chart says a leg is due, so an empty queue is a real disagreement.
    if (!leg) {
      console.warn('[collectables] send run queue drained while chart expected a leg')
      break
    }
    await yieldToUi()
    try {
      const { txid } = await sendCollectables({
        outpoints: leg,
        toAddress: args.toAddress,
        recipientIdentityKey: args.recipientIdentityKey,
        friendLabel: args.friendLabel,
      })
      result.sent.push({ txid, outpoints: leg })
      chart.send({ type: 'LEG_SENT', items: leg.length })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      result.lastError = reason
      if (classifySendRunFailure(err) === 'wallet') {
        result.failed.push({ outpoints: [...leg, ...queue.flat()], reason })
        queue.length = 0
        chart.send({ type: 'WALLET_FAULT', reason })
        break
      }
      if (leg.length > 1) {
        const [first, second] = splitItemMigrateBundle(leg)
        // Retry the halves before untouched legs: isolate the fault while the
        // rest of the selection is still worth sending.
        queue.unshift(first, second)
        chart.send({ type: 'LEG_REJECTED', items: leg.length, reason })
      } else {
        result.failed.push({ outpoints: leg, reason })
        chart.send({ type: 'LEG_REJECTED', items: 1, reason })
      }
    }
    report()
  }

  const settled = chart.getSnapshot()
  result.stopped = settled.context.stopped
  chart.stop()
  console.info(
    `[collectables] send run: ${result.sent.length} tx, ${
      collectableSendRunItemCount(result).sent
    }/${plan.itemCount} items${
      result.stopped ? ` — stopped: ${result.lastError}` : ''
    }`,
  )
  return result
}
