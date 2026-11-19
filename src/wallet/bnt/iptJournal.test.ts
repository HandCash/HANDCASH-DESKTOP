import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDurableIptJournal } from './iptJournal'
import { createIptReservations } from './iptReservations'
import { iptRequestId, type IptProposal } from './iptProposal'

const disk = vi.hoisted(() => new Map<string, string>())
const faults = vi.hoisted(() => ({ head: false, segment: false }))
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => disk.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (key.includes('.s') ? faults.segment : faults.head) return false
    disk.set(key, value)
    return true
  },
}))
const owner = { identityKey: '02' + '11'.repeat(32), accountIndex: 0, chain: 'test' as const }
const issuer = '03' + '22'.repeat(32)
const proposal = (ef = [1]): IptProposal => ({
  requestId: iptRequestId(ef), ef, assetId: 'ab'.repeat(20),
  inputs: ['cd'.repeat(32) + '.0'], holders: [], amount: 1n,
})
const open = () => createIptReservations(createDurableIptJournal(owner, issuer))

beforeEach(() => { disk.clear(); faults.head = false; faults.segment = false })
describe('durable IPT acceptance journal', () => {
  it('reopens pending and signed requests and preserves conflicts', () => {
    open().reserve(proposal())
    expect(open().reserve(proposal()).state).toBe('pending')
    expect(() => open().reserve(proposal([2]))).toThrow('reserved')
    open().recordSigned(proposal().requestId, [3])
    expect(open().reserve(proposal())).toMatchObject({ state: 'signed', signedEf: [3] })
  })
  it('recovers a segment saved before the head failed without freeing inputs', () => {
    const ledger = open()
    faults.head = true
    expect(() => ledger.reserve(proposal())).toThrow('head')
    faults.head = false
    expect(open().reserve(proposal()).state).toBe('pending')
    expect(() => open().reserve(proposal([2]))).toThrow('reserved')
    open().recordSigned(proposal().requestId, [3])
    expect(open().reserve(proposal()).state).toBe('signed')
  })
  it('does not admit a failed segment and refuses a stale writer', () => {
    const first = open()
    const stale = open()
    faults.segment = true
    expect(() => first.reserve(proposal())).toThrow('not saved')
    faults.segment = false
    expect(open().reserve(proposal()).state).toBe('reserved')
    expect(() => stale.reserve(proposal([2]))).toThrow('another writer')
  })
  it('pins account, network and issuer namespaces', () => {
    open().reserve(proposal())
    for (const [scope, key] of [
      [{ ...owner, accountIndex: 1 }, issuer],
      [{ ...owner, chain: 'main' as const }, issuer],
      [owner, '02' + '33'.repeat(32)],
    ] as const) {
      expect(createIptReservations(createDurableIptJournal(scope, key)).reserve(proposal()).state).toBe('reserved')
    }
  })
  it('fails closed on corrupt or missing committed segments', () => {
    open().reserve(proposal())
    const segment = [...disk.keys()].find((key) => key.endsWith('.s0'))!
    disk.set(segment, '{')
    expect(open).toThrow('Corrupt')
    disk.delete(segment)
    expect(open).toThrow('Missing')
  })
})
