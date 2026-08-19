import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { burnMachine } from './burnMachine'
import type { OneSatBurnPlan } from './burnPlan'

const executable: OneSatBurnPlan = {
  path: 'burnOneSat',
  asset: '1sat',
  inputs: [
    {
      outpoint: `${'ab'.repeat(32)}.0`,
      satoshis: 1,
      lockingScript: `76a914${'11'.repeat(20)}88ac`,
    },
  ],
  recoverSatoshis: 1,
}

describe('burnMachine', () => {
  it('requires every execution phase before completion', () => {
    const actor = createActor(burnMachine).start()
    actor.send({ type: 'START', plan: executable })
    expect(actor.getSnapshot().value).toBe('building')
    actor.send({ type: 'BUILT', reference: 'ref-1' })
    actor.send({ type: 'SIGNED', txid: 'cd'.repeat(32) })
    actor.send({ type: 'BROADCASTED' })
    actor.send({ type: 'INTERNALIZED' })
    actor.send({ type: 'REFRESHED' })
    expect(actor.getSnapshot().value).toBe('done')
    expect(actor.getSnapshot().context.txid).toBe('cd'.repeat(32))
  })

  it('fails closed for a refused plan', () => {
    const actor = createActor(burnMachine).start()
    actor.send({
      type: 'START',
      plan: { path: 'refuse', asset: '1sat', reason: 'unknown_lock' },
    })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.error).toBe('unknown_lock')
  })

  it('records a terminal execution failure', () => {
    const actor = createActor(burnMachine).start()
    actor.send({ type: 'START', plan: executable })
    actor.send({ type: 'FAIL', error: 'signing failed' })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.error).toBe('signing failed')
  })
})
