import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  collectableSendMachine,
  hardenedStateEventTypes,
} from './collectableSendMachine'

const TX = 'a'.repeat(64)

describe('collectableSendMachine', () => {
  it('routes hardenedResend to hardened and succeeds', () => {
    const actor = createActor(collectableSendMachine).start()
    actor.send({
      type: 'START',
      outpoint: `${TX}.0`,
      sendPath: {
        path: 'hardenedResend',
        proofOutpoint: `${TX}_1`,
        proofSource: 'remittance',
      },
    })
    expect(actor.getSnapshot().matches('hardened')).toBe(true)
    actor.send({ type: 'SUCCESS', txid: 'c'.repeat(64) })
    expect(actor.getSnapshot().matches('done')).toBe(true)
    expect(actor.getSnapshot().context.txid).toBe('c'.repeat(64))
  })

  it('routes softLatch without touching hardened', () => {
    const actor = createActor(collectableSendMachine).start()
    actor.send({
      type: 'START',
      outpoint: `${TX}.0`,
      sendPath: { path: 'softLatch', latchOutpoint: null },
    })
    expect(actor.getSnapshot().matches('softLatch')).toBe(true)
  })

  it('refuses without entering softLatch', () => {
    const actor = createActor(collectableSendMachine).start()
    actor.send({
      type: 'START',
      outpoint: `${TX}.0`,
      sendPath: { path: 'refuse', reason: 'no identity' },
    })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('no identity')
    expect(actor.getSnapshot().matches('softLatch')).toBe(false)
  })

  it('has no hardened → softLatch fallthrough on FAIL', () => {
    expect(hardenedStateEventTypes()).toEqual(['SUCCESS', 'FAIL'])
    const actor = createActor(collectableSendMachine).start()
    actor.send({
      type: 'START',
      outpoint: `${TX}.0`,
      sendPath: { path: 'hardenedGenesis' },
    })
    actor.send({ type: 'FAIL', error: 'commit failed' })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().matches('softLatch')).toBe(false)
  })
})
