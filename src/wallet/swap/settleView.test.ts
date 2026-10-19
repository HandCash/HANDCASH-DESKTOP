import { describe, expect, it } from 'vitest'
import type { SignedSwapOffer } from './offer'
import type { SettleRecord, SettleState } from './settleStore'
import { describeSwap, recentSwaps } from './settleView'

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
  it('lists moving swaps first, then those finished within a day', () => {
    const state: SettleState = {
      offers: {},
      swaps: {
        a: record('a', { outcome: 'swapped', createdAt: NOW - 3, updatedAt: NOW - 1_000 }),
        b: record('b', { createdAt: NOW - 2 }),
        c: record('c', { outcome: 'refunded', updatedAt: NOW - 25 * 3600_000 }),
        d: record('d', { createdAt: NOW - 1 }),
      },
    }
    expect(recentSwaps(state, NOW).map((r) => r.terms.swapId)).toEqual(['d', 'b', 'a'])
  })

  it('shows the taker what lands after the fee, and the maker its own leg', () => {
    expect(describeSwap(record('a')).title).toBe('1 LTC for 3.4825 BSV')
    expect(describeSwap(record('a', { role: 'maker' })).title).toBe('3.5 BSV for 1 LTC')
  })

  it('says what the swap waits on, its phase, then its outcome', () => {
    expect(describeSwap(record('a', { waiting: { for: 'accept' } }))).toMatchObject({ state: 'accept', status: 'Waiting for the maker to accept' })
    expect(describeSwap(record('a', { waiting: { for: 'peer-burial' }, peer: { confirmations: { have: 2, need: 6 } } })).status).toBe("Waiting for the maker's lock to confirm (2/6)")
    expect(describeSwap(record('a', { phase: 'locking', waiting: { for: 'accept' } })).state).toBe('locking')
    expect(describeSwap(record('a', { outcome: 'swapped', phase: 'settled', lastError: 'old' }))).toMatchObject({ state: 'swapped', status: 'Swapped' })
    expect(describeSwap(record('a', { role: 'maker', outcome: 'missed' })).state).toBe('missed')
    expect(describeSwap(record('a', { waiting: { for: 'secret' }, lastError: 'offline' })).status).toBe('Waiting for the maker to claim · last try: offline')
  })

  it('names a refused counterparty lock', () => {
    expect(describeSwap(record('a', { peer: { refused: 'amount' } })).state).toBe('refused')
  })
})
