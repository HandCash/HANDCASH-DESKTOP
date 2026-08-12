import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { chooseItemSettlePath } from './itemSettlePath'
import {
  maySenderBroadcast,
  mustDeliverToPeer,
  softLatchSendMachine,
} from './softLatchSendMachine'

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
  const actor = createActor(softLatchSendMachine).start()
  actor.send({ type: 'START', outpoint: `${TX}.0`, settlePath })
  actor.send({ type: 'BUILT' })
  return actor
}

describe('softLatchSendMachine', () => {
  it('createAction with txid goes to peerDeliver (not broadcast)', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    expect(actor.getSnapshot().matches('peerDeliver')).toBe(true)
    expect(mustDeliverToPeer(actor.getSnapshot())).toBe(true)
    expect(maySenderBroadcast(actor.getSnapshot())).toBe(false)
  })

  it('createAction without txid requires signing before settle', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED' })
    expect(actor.getSnapshot().matches('signing')).toBe(true)
    actor.send({ type: 'SIGNED', txid: 'c'.repeat(64) })
    expect(actor.getSnapshot().matches('peerDeliver')).toBe(true)
  })

  it('peerDeliver ignores BROADCASTED — P2P first', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    actor.send({ type: 'BROADCASTED' })
    expect(actor.getSnapshot().matches('peerDeliver')).toBe(true)
    expect(actor.getSnapshot().matches('done')).toBe(false)
  })

  it('peerDeliver → done on DELIVERED without sender broadcast', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    actor.send({ type: 'DELIVERED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('sender broadcast only after DELIVER_FAILED', () => {
    const actor = start(peerSettle)
    actor.send({ type: 'CREATED', txid: 'b'.repeat(64) })
    actor.send({ type: 'DELIVER_FAILED' })
    expect(actor.getSnapshot().matches('senderFallback')).toBe(true)
    expect(maySenderBroadcast(actor.getSnapshot())).toBe(true)
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
