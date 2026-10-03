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
  it('walks recover from the server spend to internalize', () => {
    const actor = createActor(serverWalletRecoverMachine).start()
    actor.send({ type: 'START', plan: { path: 'recover', satoshis: 9_900 } })
    expect(actor.getSnapshot().value).toBe('spending')
    actor.send({ type: 'SPENT', txid: pending.txid })
    expect(actor.getSnapshot().value).toBe('internalizing')
    actor.send({ type: 'INTERNALIZED' })
    expect(actor.getSnapshot().value).toBe('done')
    expect(actor.getSnapshot().context.txid).toBe(pending.txid)
  })

  it('finishes a broadcast recovery by internalizing only', () => {
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
