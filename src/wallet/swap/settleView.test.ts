import { describe, expect, it } from 'vitest'
import type { SignedSwapOffer } from './offer'
import type { SettleRecord } from './settleStore'
import { describeSwap } from './settleView'

const NOW = 1_800_000_000_000
const offer = { give: 'bsv', get: 'ltc' } as SignedSwapOffer

function record(swapId: string, over: Partial<SettleRecord> = {}): SettleRecord {
  return {
    v: 1,
    role: 'taker',
    counterparty: '02' + '11'.repeat(32),
    terms: {
      v: 1,
      swapId,
      offer,
      taker: '02' + '22'.repeat(32),
      pay: '100000000',
      receive: '350000000',
      fee: { leg: 'maker', amount: '1750000' },
      hash: '00'.repeat(32),
      takerPub: '02' + '33'.repeat(32),
      takenAt: NOW,
      t1: 0,
      t2: 0,
    },
    own: {},
    peer: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

describe('settle view', () => {
  it('calls a swap swapped once its claim is in, even while the fee output waits out the lock', () => {
    const until = NOW + 3_600_000
    const claimed = { role: 'maker' as const, peer: { claimed: true }, phase: 'locked' as const }
    expect(describeSwap(record('f', { ...claimed, waiting: { for: 'locktime', until } }))).toMatchObject({
      state: 'swapped',
      status: expect.stringMatching(/^Swapped · unclaimed fee returns to you /),
    })
    expect(describeSwap(record('f', claimed))).toMatchObject({ state: 'swapped', status: 'Swapped' })
  })

  it('says what the swap waits on, its phase, then its outcome', () => {
    expect(describeSwap(record('a', { waiting: { for: 'accept' } }))).toMatchObject({ state: 'accept', status: 'Waiting for the maker to accept' })
    expect(describeSwap(record('a', { waiting: { for: 'peer-burial' }, peer: { confirmations: { have: 2, need: 6 } } })).status).toBe(
      "Confirming the maker's lock",
    )
    expect(describeSwap(record('a', { phase: 'locking', waiting: { for: 'accept' } })).state).toBe('locking')
    expect(describeSwap(record('a', { outcome: 'swapped', phase: 'settled', lastError: 'old' }))).toMatchObject({ state: 'swapped', status: 'Swapped' })
    expect(describeSwap(record('a', { role: 'maker', outcome: 'missed' })).state).toBe('missed')
    expect(describeSwap(record('a', { waiting: { for: 'secret' }, lastError: 'offline' })).status).toBe('Waiting for the maker to claim · last try: offline')
  })

  it('says when the swap waits on a block, and whose lock is in it', () => {
    const lock = { txid: 'aa'.repeat(32), main: 0 }
    // The taker locked LTC; the maker locks only once that lock is buried.
    expect(describeSwap(record('a', { waiting: { for: 'peer-funding' }, own: { funding: lock } }))).toMatchObject({
      state: 'peer-funding',
      status: 'Confirming your lock',
    })
    expect(describeSwap(record('a', { waiting: { for: 'peer-funding' }, own: { funding: lock, confirmations: { have: 1, need: 3 } } })).status).toBe(
      'Confirming your lock',
    )
    expect(describeSwap(record('a', { waiting: { for: 'peer-funding' }, own: { funding: lock } })).confirming).toEqual({ chain: 'ltc', counted: 0, needed: 6 })
    expect(describeSwap(record('a', { waiting: { for: 'peer-funding' }, own: { funding: lock, confirmations: { have: 1, need: 3 } } })).confirming).toEqual({ chain: 'ltc', counted: 1, needed: 3 })
    expect(describeSwap(record('a', { waiting: { for: 'peer-funding' }, own: { funding: lock, buried: true } }))).toEqual({ state: 'peer-funding', status: 'Waiting for the maker to lock' })
    // The maker, seeing the taker's lock still unmined.
    expect(describeSwap(record('a', { role: 'maker', waiting: { for: 'peer-burial' } })).status).toBe(
      "Confirming the taker's lock",
    )
    expect(describeSwap(record('a', { role: 'maker', waiting: { for: 'secret' }, own: { funding: lock } }))).toEqual({
      state: 'secret',
      status: 'Confirming your lock',
      confirming: { chain: 'bsv', counted: 0, needed: 1 },
    })
  })

  it("says when a claim waits on reading the chain's clock", () => {
    expect(describeSwap(record('a', { waiting: { for: 'chain-time' } }))).toEqual({ state: 'chain-time', status: 'Preparing your claim' })
  })

  it('names a refused counterparty lock', () => {
    expect(describeSwap(record('a', { peer: { refused: 'amount' } })).state).toBe('refused')
  })
})
