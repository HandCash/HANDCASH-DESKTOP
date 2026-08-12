import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  brc29SendMachine,
  mustBrc29DeliverToPeer,
  mustBrc29SelfReceive,
} from './brc29SendMachine'

const PEER =
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const TXID = 'a'.repeat(64)

describe('brc29SendMachine', () => {
  it('broadcasts before inbox notify', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'peerDeliver', recipientIdentityKey: PEER },
    })
    actor.send({ type: 'READY' })
    expect(actor.getSnapshot().matches('broadcasting')).toBe(true)
    expect(mustBrc29DeliverToPeer(actor.getSnapshot())).toBe(false)
    actor.send({ type: 'BROADCASTED', txid: TXID })
    expect(actor.getSnapshot().matches('peerNotify')).toBe(true)
    expect(mustBrc29DeliverToPeer(actor.getSnapshot())).toBe(true)
  })

  it('inbox success or miss both finish the send (no second tx)', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'peerDeliver', recipientIdentityKey: PEER },
    })
    actor.send({ type: 'READY' })
    actor.send({ type: 'BROADCASTED', txid: TXID })
    actor.send({ type: 'BOX_UNREACHABLE' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('BEEF_IN_BOX after broadcast → done', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'peerDeliver', recipientIdentityKey: PEER },
    })
    actor.send({ type: 'READY' })
    actor.send({ type: 'BROADCASTED', txid: TXID })
    actor.send({ type: 'BEEF_IN_BOX' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })

  it('selfReceive settles locally after broadcast', () => {
    const actor = createActor(brc29SendMachine).start()
    actor.send({
      type: 'START',
      payee: PEER,
      satoshis: 1000,
      settlePath: { settle: 'selfReceive' },
    })
    actor.send({ type: 'READY' })
    actor.send({ type: 'BROADCASTED', txid: TXID })
    expect(actor.getSnapshot().matches('selfReceive')).toBe(true)
    expect(mustBrc29SelfReceive(actor.getSnapshot())).toBe(true)
    actor.send({ type: 'SETTLED' })
    expect(actor.getSnapshot().matches('done')).toBe(true)
  })
})
