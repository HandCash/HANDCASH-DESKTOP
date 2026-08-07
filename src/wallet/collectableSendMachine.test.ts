import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { collectableSendMachine } from './collectableSendMachine'

const TX = 'a'.repeat(64)

describe('collectableSendMachine', () => {
  it('routes softLatch and succeeds', () => {
    const actor = createActor(collectableSendMachine).start()
    actor.send({
      type: 'START',
      outpoint: `${TX}.0`,
      sendPath: { path: 'softLatch', latchOutpoint: null },
    })
    expect(actor.getSnapshot().matches('softLatch')).toBe(true)
    actor.send({ type: 'SUCCESS', txid: 'c'.repeat(64) })
    expect(actor.getSnapshot().matches('done')).toBe(true)
    expect(actor.getSnapshot().context.txid).toBe('c'.repeat(64))
  })

  it('refuses without entering softLatch', () => {
    const actor = createActor(collectableSendMachine).start()
    actor.send({
      type: 'START',
      outpoint: `${TX}.0`,
      sendPath: {
        path: 'refuse',
        reason: 'This collectable is covenant-locked and can no longer be sent. Abandon it to remove it from inventory.',
      },
    })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.error).toMatch(/abandon/i)
    expect(actor.getSnapshot().matches('softLatch')).toBe(false)
  })

  it('has no hardened state', () => {
    expect(collectableSendMachine.states).not.toHaveProperty('hardened')
  })
})
