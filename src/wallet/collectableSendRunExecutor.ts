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
  failedSendAttemptActivity,
  planCollectableSendRun,
  type CollectableSendRunResult,
} from './collectableSendRun'
import { collectableSendRunMachine } from './collectableSendRunMachine'
import { collectableSendBatchRefusal } from './collectableBatch'
import { splitItemMigrateBundle } from './itemMigrateBundle'
import { pinBroadcastLocalTx } from './staleOutputRelease'
import { yieldToUi } from './yieldToUi'

const LEG_PIN_TIMEOUT_MS = 20_000

/**
 * A leg returns once its signed cheque and background miner submit exist. The
 * next leg is normally funded by that cheque's change, so wait until Arcade has
 * pinned it and local state has promoted the change. A single eager pin raced
 * the background submit, returned false, and made a 25-item run stop after its
 * first five items for "insufficient funds".
 */
async function awaitLegPin(txid: string): Promise<void> {
  const deadline = Date.now() + LEG_PIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await pinBroadcastLocalTx(txid).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `The first transaction is signed but its change is not ready after ${LEG_PIN_TIMEOUT_MS / 1000}s. The remaining collectables were left untouched.`,
  )
}

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
      plan.reason === 'empty'
        ? collectableSendBatchRefusal({ kind: 'refuse', reason: 'empty' })
        : `Send up to ${plan.max} collectables at a time, not ${plan.count}.`,
    )
  }

  const chart = createActor(collectableSendRunMachine).start()
  chart.send({ type: 'START', legs: plan.legs.length })
  console.info(
    `[collectables] send run start — ${plan.itemCount} items in ${plan.legs.length} atomic legs`,
  )

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
        failureActivity: failedSendAttemptActivity(leg.length),
      })
      result.sent.push({ txid, outpoints: leg })
      // Every leg after the first is funded by the previous leg's change, and a
      // `peerDeliver` leg parks that change in an app-held `nosend` row. Pin it
      // before signing the next leg or the run starves on its own money.
      await awaitLegPin(txid)
      chart.send({ type: 'LEG_SENT', items: leg.length })
      console.info(
        `[collectables] send run leg accepted — ${leg.length} items by ${txid.slice(
          0,
          12,
        )} (${chart.getSnapshot().context.sentItems}/${plan.itemCount})`,
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      result.lastError = reason
      const decision = classifySendRunFailure(err)
      console.warn(
        `[collectables] send run leg rejected (${leg.length} item${
          leg.length === 1 ? '' : 's'
        }) — ${decision.action}:${decision.reason}`,
        reason,
      )
      if (decision.action === 'stop') {
        const remaining = [...leg, ...queue.flat()]
        result.failed.push({ outpoints: remaining, reason })
        queue.length = 0
        chart.send({
          type: 'RUN_FAULT',
          reason,
          remainingItems: remaining.length,
        })
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
