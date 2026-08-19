import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { assetBurnUiMachine } from './assetBurnUiMachine'

describe('assetBurnUiMachine', () => {
  it('requires an explicit confirm before burning', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN' })
    expect(actor.getSnapshot().matches('confirming')).toBe(true)
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches('burning')).toBe(true)
  })

  it('keeps a failure visible and permits an explicit retry', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'CONFIRM' })
    actor.send({ type: 'FAIL', error: 'broadcast rejected' })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('broadcast rejected')
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().matches('burning')).toBe(true)
    expect(actor.getSnapshot().context.error).toBeNull()
  })

  it('stores the irreversible result until reset', () => {
    const actor = createActor(assetBurnUiMachine).start()
    actor.send({ type: 'OPEN' })
    actor.send({ type: 'CONFIRM' })
    actor.send({ type: 'SUCCESS', txid: 'aa'.repeat(32), recoveredSatoshis: 4 })
    expect(actor.getSnapshot().matches('done')).toBe(true)
    expect(actor.getSnapshot().context.recoveredSatoshis).toBe(4)
  })
})
