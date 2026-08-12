import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  brc29SendMachine,
  mayBrc29SenderBroadcast,
  mustBrc29DeliverToPeer,
} from './brc29SendMachine'

const PEER =
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const TXID = 'a'.repeat(64)

describe('brc29SendMachine', () => {
  it('peerDeliver ignores BROADCASTED — inbox first', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'peerDeliver', recipientIdentityKey: PEER },
    })
    actor.send({ type: 'READY' })
    actor.send({ type: 'SIGNED', txid: TXID })
    expect(actor.getSnapshot().matches('peerDeliver')).toBe(true)
    expect(mustBrc29DeliverToPeer(actor.getSnapshot())).toBe(true)
    expect(mayBrc29SenderBroadcast(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'BROADCASTED' })
    expect(actor.getSnapshot().matches('peerDeliver')).toBe(true)
  })

  it('BEEF_IN_BOX → silent confirmBroadcast (does not fail the send)', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'peerDeliver', recipientIdentityKey: PEER },
    })
    actor.send({ type: 'READY' })
    actor.send({ type: 'SIGNED', txid: TXID })
    actor.send({ type: 'BEEF_IN_BOX' })
    expect(actor.getSnapshot().matches('confirmBroadcast')).toBe(true)
    expect(mayBrc29SenderBroadcast(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SKIPPED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('sender broadcast only after remittance is in the box (or box unreachable)', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'peerDeliver', recipientIdentityKey: PEER },
    })
    actor.send({ type: 'READY' })
    actor.send({ type: 'SIGNED', txid: TXID })
    actor.send({ type: 'REMIT_IN_BOX' })
    expect(actor.getSnapshot().matches('confirmBroadcast')).toBe(true)
    expect(mayBrc29SenderBroadcast(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'BROADCASTED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('selfReceive settles locally (broadcast + internalize)', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'selfReceive' },
    })
    actor.send({ type: 'READY' })
    actor.send({ type: 'SIGNED', txid: TXID })
    expect(actor.getSnapshot().matches('selfReceive')).toBe(true)
    expect(mayBrc29SenderBroadcast(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SETTLED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })
})
