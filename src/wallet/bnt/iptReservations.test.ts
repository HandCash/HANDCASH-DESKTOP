import { describe, expect, it } from 'vitest'
import { iptRequestId, type IptProposal } from './iptProposal'
import { createIptReservations, type IptReservationEvent } from './iptReservations'

const proposal = (ef = [1]): IptProposal => ({
  requestId: iptRequestId(ef), ef, assetId: 'ab'.repeat(20), inputs: ['cd'.repeat(32) + '.0'], holders: [], amount: 1n,
})

describe('BRC-253 accept-once reservations', () => {
  it('keeps conflicting requests reserved across restart and returns recorded bytes on replay', () => {
    const events: IptReservationEvent[] = []
    const journal = { read: () => events, append: (event: IptReservationEvent) => { events.push(structuredClone(event)) } }
    const first = createIptReservations(journal)
    expect(first.reserve(proposal()).state).toBe('reserved')
    expect(first.reserve(proposal()).state).toBe('pending')
    const restarted = createIptReservations(journal)
    expect(restarted.reserve(proposal()).state).toBe('pending')
    expect(() => restarted.reserve(proposal([2]))).toThrow('reserved')
    restarted.recordSigned(proposal().requestId, [3])
    const replay = createIptReservations(journal).reserve(proposal())
    expect(replay).toMatchObject({ state: 'signed', signedEf: [3] })
    expect(events).toHaveLength(2)
    expect(() => restarted.recordSigned(proposal().requestId, [4])).toThrow('already signed')
  })
  it('does not reserve after a failed durable append', () => {
    let fail = true
    const ledger = createIptReservations({
      read: () => [],
      append: () => { if (fail) throw new Error('disk full') },
    })
    expect(() => ledger.reserve(proposal())).toThrow('disk full')
    fail = false
    expect(ledger.reserve(proposal()).state).toBe('reserved')
  })
  it('keeps a reservation pending when saving signed bytes fails', () => {
    const events: IptReservationEvent[] = []
    const ledger = createIptReservations({
      read: () => events,
      append: (event) => { if (event.t === 'signed') throw new Error('disk full'); events.push(event) },
    })
    ledger.reserve(proposal())
    expect(() => ledger.recordSigned(proposal().requestId, [2])).toThrow('disk full')
    expect(ledger.reserve(proposal()).state).toBe('pending')
    expect(() => ledger.reserve(proposal([3]))).toThrow('reserved')
  })
  it('fails closed on conflicting journal history and altered proposal bindings', () => {
    const p = proposal()
    expect(() => createIptReservations({ read: () => [
      { t: 'reserved', requestId: p.requestId, assetId: p.assetId, inputs: p.inputs },
      { t: 'reserved', requestId: iptRequestId([2]), assetId: p.assetId, inputs: p.inputs },
    ], append: () => {} })).toThrow('Conflicting')
    const ledger = createIptReservations({ read: () => [], append: () => {} })
    ledger.reserve(p)
    expect(() => ledger.reserve({ ...p, inputs: ['other.0'] })).toThrow('binding')
    expect(() => ledger.reserve({ ...p, ef: [2] })).toThrow('commitment')
  })
})
