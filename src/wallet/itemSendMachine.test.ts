import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { chooseItemSettlePath } from './itemSettlePath'
import {
  maySenderBroadcast,
  mustDeliverToPeer,
  itemSendMachine,
} from './itemSendMachine'

const TX = 'a'.repeat(64)
const IDENTITY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const peerSettle = chooseItemSettlePath({
  paysOurAddress: false,
  recipientIdentityKey: IDENTITY,
})
const selfSettle = chooseItemSettlePath({
  paysOurAddress: true,
  recipientIdentityKey: IDENTITY,
})
const externalSettle = chooseItemSettlePath({
  paysOurAddress: false,
  recipientIdentityKey: null,
})

function start(settlePath = peerSettle) {
  const actor = createActor(itemSendMachine).start()
  actor.send({ type: 'START', outpoint: `${TX}.0`, settlePath })
  actor.send({ type: 'BUILT' })
  return actor
}

describe('itemSendMachine', () => {
  it('peer metadata does not change the common broadcast rule', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    expect(actor.getSnapshot().matches('peerDeliver')).toBe(true)
    expect(mustDeliverToPeer(actor.getSnapshot())).toBe(true)
    expect(maySenderBroadcast(actor.getSnapshot())).toBe(true)
  })

  it('createAction without txid requires signing before settle', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED' })
    expect(actor.getSnapshot().matches('signing')).toBe(true)
    actor.send({ type: 'SIGNED', txid: 'c'.repeat(64) })
    expect(actor.getSnapshot().matches('peerDeliver')).toBe(true)
  })

  it('peer transfer completes its transaction lifecycle on BROADCASTED', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    actor.send({ type: 'BROADCASTED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('retries an existing signed BEEF through confirmBroadcast', () => {
    const actor = createActor(itemSendMachine).start()
    actor.send({
      type: 'RETRY_BROADCAST',
      outpoint: `${TX}.0`,
      txid: 'b'.repeat(64),
    })
    expect(actor.getSnapshot().matches('confirmBroadcast')).toBe(true)
    expect(maySenderBroadcast(actor.getSnapshot())).toBe(true)
    expect(actor.getSnapshot().context.txid).toBe('b'.repeat(64))
    actor.send({ type: 'BROADCASTED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('self-receive may broadcast immediately', () => {
    const actor = start(selfSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    expect(actor.getSnapshot().matches('selfReceive')).toBe(true)
    expect(maySenderBroadcast(actor.getSnapshot())).toBe(true)
    expect(mustDeliverToPeer(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'BROADCASTED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('external address may broadcast (no identity box)', () => {
    const actor = start(externalSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    expect(actor.getSnapshot().matches('externalBroadcast')).toBe(true)
    expect(maySenderBroadcast(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'BROADCASTED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('FAIL from createAction does not invent another path', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'FAIL', error: 'insufficient' })
    expect(actor.getSnapshot().matches('failed')).toBe(true)
    expect(maySenderBroadcast(actor.getSnapshot())).toBe(false)
  })
})
