import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { MAX_ITEMS_PER_ONE_SAT_TX } from './collectableBatch'
import {
  classifySendRunFailure,
  collectableSendRunItemCount,
  planCollectableSendRun,
  summarizeCollectableSendRun,
  type CollectableSendRunResult,
} from './collectableSendRun'
import { collectableSendRunMachine } from './collectableSendRunMachine'

function selection(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${i.toString(16).padStart(64, '0')}.0`,
  )
}

describe('planCollectableSendRun', () => {
  it('refuses an empty selection', () => {
    expect(planCollectableSendRun([])).toEqual({ kind: 'refuse', reason: 'empty' })
  })

  it('keeps a selection at the ceiling as one leg', () => {
    const plan = planCollectableSendRun(selection(MAX_ITEMS_PER_ONE_SAT_TX))
    expect(plan.kind === 'legs' && plan.legs).toHaveLength(1)
  })

  it('splits a large selection into ceiling-sized legs in order', () => {
    const plan = planCollectableSendRun(selection(700))
    if (plan.kind !== 'legs') throw new Error('expected legs')

    expect(plan.itemCount).toBe(700)
    expect(plan.legs).toHaveLength(Math.ceil(700 / MAX_ITEMS_PER_ONE_SAT_TX))
    expect(plan.legs[0]!.index).toBe(1)
    expect(plan.legs[0]!.outpoints).toHaveLength(MAX_ITEMS_PER_ONE_SAT_TX)
    expect(plan.legs.at(-1)!.outpoints).toHaveLength(
      700 % MAX_ITEMS_PER_ONE_SAT_TX || MAX_ITEMS_PER_ONE_SAT_TX,
    )
    // Every tip travels exactly once, in selection order.
    expect(plan.legs.flatMap((leg) => leg.outpoints)).toEqual(selection(700))
  })

  it('never exceeds the ceiling even when asked for a bigger leg', () => {
    const plan = planCollectableSendRun(selection(60), 500)
    if (plan.kind !== 'legs') throw new Error('expected legs')
    for (const leg of plan.legs) {
      expect(leg.outpoints.length).toBeLessThanOrEqual(MAX_ITEMS_PER_ONE_SAT_TX)
    }
  })
})

describe('classifySendRunFailure', () => {
  it('treats wallet-wide faults as reasons to stop the run', () => {
    for (const reason of [
      'Wallet locked',
      'Not enough spendable BSV',
      'insufficient funds for fee',
      'You appear to be offline',
      'Invalid recipient address or identity key',
    ]) {
      expect(classifySendRunFailure(new Error(reason))).toBe('wallet')
    }
  })

  it('treats a tip-specific rejection as a leg to split', () => {
    expect(
      classifySendRunFailure(new Error('Collectable is no longer in this wallet')),
    ).toBe('leg')
    expect(classifySendRunFailure(new Error('rejected by miner'))).toBe('leg')
  })
})

describe('collectableSendRunMachine', () => {
  it('sends every queued leg then settles', () => {
    const actor = createActor(collectableSendRunMachine).start()
    actor.send({ type: 'START', legs: 3 })

    for (let leg = 0; leg < 3; leg++) {
      expect(actor.getSnapshot().value).toBe('sending')
      actor.send({ type: 'LEG_SENT', items: 25 })
    }

    const snapshot = actor.getSnapshot()
    expect(snapshot.value).toBe('done')
    expect(snapshot.context.sentLegs).toBe(3)
    expect(snapshot.context.sentItems).toBe(75)
    expect(snapshot.context.stopped).toBeNull()
  })

  it('queues two halves when a multi-tip leg is rejected', () => {
    const actor = createActor(collectableSendRunMachine).start()
    actor.send({ type: 'START', legs: 1 })
    actor.send({ type: 'LEG_REJECTED', items: 4, reason: 'rejected' })

    // One leg left the queue and two halves joined it.
    expect(actor.getSnapshot().value).toBe('sending')
    expect(actor.getSnapshot().context.queued).toBe(2)

    actor.send({ type: 'LEG_SENT', items: 2 })
    actor.send({ type: 'LEG_REJECTED', items: 2, reason: 'rejected' })
    expect(actor.getSnapshot().context.queued).toBe(2)
  })

  it('records a failure instead of splitting a single tip', () => {
    const actor = createActor(collectableSendRunMachine).start()
    actor.send({ type: 'START', legs: 1 })
    actor.send({ type: 'LEG_REJECTED', items: 1, reason: 'unspendable' })

    const snapshot = actor.getSnapshot()
    expect(snapshot.value).toBe('done')
    expect(snapshot.context.failedItems).toBe(1)
    expect(snapshot.context.error).toBe('unspendable')
    expect(snapshot.context.stopped).toBeNull()
  })

  it('halts the whole run on a wallet fault and counts the untouched legs', () => {
    const actor = createActor(collectableSendRunMachine).start()
    actor.send({ type: 'START', legs: 10 })
    actor.send({ type: 'LEG_SENT', items: 25 })
    actor.send({ type: 'WALLET_FAULT', reason: 'Not enough spendable BSV' })

    const snapshot = actor.getSnapshot()
    expect(snapshot.value).toBe('halted')
    expect(snapshot.context.stopped).toBe('wallet')
    expect(snapshot.context.queued).toBe(0)
    expect(snapshot.context.sentItems).toBe(25)
    // The nine legs never attempted are outstanding, not silently forgotten.
    expect(snapshot.context.failedItems).toBe(9)
  })

  it('will not accept a leg outcome once halted', () => {
    const actor = createActor(collectableSendRunMachine).start()
    actor.send({ type: 'START', legs: 2 })
    actor.send({ type: 'WALLET_FAULT', reason: 'Wallet locked' })
    actor.send({ type: 'LEG_SENT', items: 25 })

    expect(actor.getSnapshot().context.sentItems).toBe(0)
    expect(actor.getSnapshot().value).toBe('halted')
  })
})

describe('summarizeCollectableSendRun', () => {
  const sent = (count: number) => ({
    txid: 'a'.repeat(64),
    outpoints: selection(count),
  })

  it('counts items and transactions on a clean run', () => {
    const result: CollectableSendRunResult = {
      sent: [sent(25), sent(25)],
      failed: [],
      stopped: null,
      lastError: null,
    }
    expect(collectableSendRunItemCount(result)).toEqual({ sent: 50, failed: 0 })
    expect(summarizeCollectableSendRun(result)).toBe(
      'Sent 50 collectables in 2 transactions.',
    )
  })

  it('names what is left when the wallet stopped the run', () => {
    const result: CollectableSendRunResult = {
      sent: [sent(25)],
      failed: [{ outpoints: selection(3), reason: 'Not enough spendable BSV' }],
      stopped: 'wallet',
      lastError: 'Not enough spendable BSV',
    }
    expect(summarizeCollectableSendRun(result)).toContain('Stopped with 3 left')
  })

  it('says nothing was sent rather than implying success', () => {
    const result: CollectableSendRunResult = {
      sent: [],
      failed: [{ outpoints: selection(2), reason: 'rejected' }],
      stopped: null,
      lastError: 'rejected',
    }
    expect(summarizeCollectableSendRun(result)).toContain(
      'No collectables were sent.',
    )
  })
})
