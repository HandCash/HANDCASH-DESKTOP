import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { assetBurnUiMachine } from './assetBurnUiMachine'

describe('assetBurnUiMachine', () => {
  it('opens on editing, the same as composing a payment', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN', amount: '5' })
    expect(actor.getSnapshot().matches('editing')).toBe(true)
    expect(actor.getSnapshot().context.amount).toBe('5')
  })

  it('requires review then an explicit confirm before burning', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches('editing')).toBe(true)
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches('confirming')).toBe(true)
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches('burning')).toBe(true)
  })

  it('refuses to change the amount once it is being confirmed', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN', amount: '5' })
    actor.send({ type: 'REVIEW' })
    actor.send({ type: 'SET_AMOUNT', amount: '500' })
    expect(actor.getSnapshot().context.amount).toBe('5')
    actor.send({ type: 'BACK' })
    actor.send({ type: 'SET_AMOUNT', amount: '500' })
    expect(actor.getSnapshot().context.amount).toBe('500')
  })

  it('sends a failure back to editing with the amount intact', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN', amount: '5' })
    actor.send({ type: 'REVIEW' })
    actor.send({ type: 'CONFIRM' })
    actor.send({ type: 'FAIL', error: 'broadcast rejected' })
    expect(actor.getSnapshot().matches('failure')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('broadcast rejected')
    actor.send({ type: 'BACK' })
    expect(actor.getSnapshot().matches('editing')).toBe(true)
    expect(actor.getSnapshot().context.error).toBeNull()
    expect(actor.getSnapshot().context.amount).toBe('5')
  })

  it('cannot burn again straight from a failure', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'REVIEW' })
    actor.send({ type: 'CONFIRM' })
    actor.send({ type: 'FAIL', error: 'broadcast rejected' })
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches('failure')).toBe(true)
  })

  it('stores the irreversible result until reset', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'REVIEW' })
    actor.send({ type: 'CONFIRM' })
    actor.send({ type: 'SUCCESS', txid: 'aa'.repeat(32), recoveredSatoshis: 4 })
    expect(actor.getSnapshot().matches('done')).toBe(true)
    expect(actor.getSnapshot().context.recoveredSatoshis).toBe(4)
    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().matches('closed')).toBe(true)
    expect(actor.getSnapshot().context.txid).toBeNull()
  })
})
