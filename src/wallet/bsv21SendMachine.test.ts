import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { bsv21SendMachine } from './bsv21SendMachine'

const TOKEN_ID = `${'ab'.repeat(32)}_0`

describe('bsv21SendMachine', () => {
  it('runs a classified plain path to done', () => {
    const actor = createActor(bsv21SendMachine).start()
    actor.send({
      type: 'START',
      tokenId: TOKEN_ID,
      sendPath: { path: 'plain' },
    })
    expect(actor.getSnapshot().matches('plainSend')).toBe(true)
    actor.send({ type: 'SUCCESS', txid: 'cd'.repeat(32) })
    expect(actor.getSnapshot().matches('done')).toBe(true)
    expect(actor.getSnapshot().context.txid).toBe('cd'.repeat(32))
  })

  it.each([
    ['unknown_lock'],
    ['mixed_tips'],
    ['cosigner_required'],
  ])('fails closed for %s', (reason) => {
    const actor = createActor(bsv21SendMachine).start()
    actor.send({
      type: 'START',
      tokenId: TOKEN_ID,
      sendPath: { path: 'refuse', reason },
    })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe(reason)
  })

  it('has no cosigned execution edge until a cosigner client exists', () => {
    const actor = createActor(bsv21SendMachine).start()
    actor.send({
      type: 'START',
      tokenId: TOKEN_ID,
      sendPath: {
        path: 'cosigned',
        cosign: { pubkey: `02${'ef'.repeat(32)}` },
      },
    })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(actor.getSnapshot().context.error).toBe('cosigner_required')
  })
})
