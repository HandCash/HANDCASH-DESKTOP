import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { serverWalletRecoverMachine } from './serverWalletRecoverMachine'

const pending = {
  txid: 'bb'.repeat(32),
  atomicBeefB64: 'AA==',
  satoshis: 9_000,
  derivationPrefix: 'a',
  derivationSuffix: 'b',
}

describe('serverWalletRecoverMachine', () => {
  it('walks recover through the signed lifecycle', () => {
    const actor = createActor(serverWalletRecoverMachine).start()
    actor.send({ type: 'START', plan: { path: 'recover', outputs: [], totalSats: 10_000 } })
    expect(actor.getSnapshot().value).toBe('signing')
    actor.send({ type: 'SIGNED', txid: pending.txid })
    actor.send({ type: 'REGISTERED' })
    actor.send({ type: 'INTERNALIZED' })
    expect(actor.getSnapshot().value).toBe('done')
    expect(actor.getSnapshot().context.txid).toBe(pending.txid)
  })

  it('finishes a registered recovery by internalizing only', () => {
    const actor = createActor(serverWalletRecoverMachine).start()
    actor.send({ type: 'START', plan: { path: 'finish', pending } })
    expect(actor.getSnapshot().value).toBe('internalizing')
    expect(actor.getSnapshot().context.txid).toBe(pending.txid)
  })

  it('fails closed with the named refusal', () => {
    const actor = createActor(serverWalletRecoverMachine).start()
    actor.send({ type: 'START', plan: { path: 'refuse', reason: 'uneconomical' } })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.error).toBe('uneconomical')
  })
})
