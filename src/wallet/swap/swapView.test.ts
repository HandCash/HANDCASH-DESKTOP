import { describe, expect, it } from 'vitest'
import { composeActivityRecords } from '../activityRecords'
import type { ActivityEntry } from '../appActivity'
import type { SwapRecord } from './exolixSwap'
import type { SignedSwapOffer } from './offer'
import type { SettleRecord, SettleState } from './settleStore'
import { foldSwapActivity, swapActivityTitle } from './swapActivity'
import { directSwapView, exolixSwapView, recentSwapViews, swapViews } from './swapView'

const NOW = 1_800_000_000_000
const tx = (n: number) => n.toString(16).padStart(64, '0')
const offer = { give: 'bsv', get: 'ltc' } as SignedSwapOffer

function direct(swapId: string, over: Partial<SettleRecord> = {}): SettleRecord {
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

function exolix(id: string, over: Partial<SwapRecord> = {}): SwapRecord {
  return {
    id,
    via: 'exolix',
    from: 'bsv',
    to: 'btc',
    pay: '50000000',
    receive: '12000',
    depositAddress: '1Deposit',
    payout: 'bc1payout',
    stage: 'paid',
    status: 'exchanging',
    txid: tx(1),
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

const row = (over: Partial<ActivityEntry>): ActivityEntry => ({
  id: over.id ?? `row-${over.txid}`,
  origin: 'handcash',
  kind: 'spent',
  sats: 1000,
  at: NOW,
  method: 'send',
  ...over,
})

describe('swap view', () => {
  it('names what the taker pays and what lands after the fee, and the maker its own leg', () => {
    expect(directSwapView(direct('a')).title).toBe('1 LTC → 3.4825 BSV')
    expect(directSwapView(direct('a', { role: 'maker' })).title).toBe('3.5 BSV → 1 LTC')
    expect(directSwapView(direct('a'))).toMatchObject({ id: 'direct:a', route: 'direct', from: 'ltc', to: 'bsv', pay: 100_000_000n, receive: 348_250_000n })
  })

  it('lists every transaction of a direct swap once, by its part in the swap', () => {
    const view = directSwapView(
      direct('a', {
        own: { prepared: { txid: tx(1), beef: '' }, funding: { txid: tx(1), main: 0 }, refund: { txid: tx(4), hex: '' } },
        peer: { funding: { txid: tx(2), main: 0 }, claim: { txid: tx(3), hex: '' } },
      }),
    )
    expect(view.legs).toEqual([
      { role: 'lock', asset: 'ltc', txid: tx(1) },
      { role: 'peer-lock', asset: 'bsv', txid: tx(2) },
      { role: 'claim', asset: 'bsv', txid: tx(3) },
      { role: 'refund', asset: 'ltc', txid: tx(4) },
    ])
  })

  it('reads an Exolix exchange in the same words, deposit and payout as its legs', () => {
    const view = exolixSwapView(exolix('ex1', { status: 'success', payoutTxid: tx(9) }))
    expect(view).toMatchObject({ id: 'exolix:ex1', route: 'exolix', tone: 'done', title: '0.5 BSV → 0.00012 BTC', status: 'Paid out to this wallet' })
    expect(view.legs.map((l) => l.role)).toEqual(['deposit', 'payout'])
    expect(exolixSwapView(exolix('ex2', { stage: 'created', txid: undefined })).tone).toBe('stopped')
    expect(exolixSwapView(exolix('ex3')).tone).toBe('moving')
  })

  it('puts moving swaps first; the swap screens keep finished ones a day', () => {
    const state: SettleState = {
      offers: {},
      swaps: {
        a: direct('a', { outcome: 'swapped', createdAt: NOW - 3, updatedAt: NOW - 1_000 }),
        b: direct('b', { createdAt: NOW - 2 }),
        c: direct('c', { outcome: 'refunded', updatedAt: NOW - 25 * 3600_000 }),
      },
    }
    const views = swapViews(state, [exolix('ex', { createdAt: NOW - 1 })])
    expect(views.map((v) => v.id)).toEqual(['exolix:ex', 'direct:b', 'direct:c', 'direct:a'])
    expect(recentSwapViews(views, NOW).map((v) => v.id)).toEqual(['exolix:ex', 'direct:b', 'direct:a'])
  })
})

describe('swaps in Activity', () => {
  it('folds every transaction of a swap, either chain, under one row naming it', () => {
    const view = directSwapView(
      direct('a', {
        createdAt: NOW - 10,
        own: { funding: { txid: tx(1), main: 0 } },
        peer: { claim: { txid: tx(3), hex: '' } },
        outcome: 'swapped',
      }),
    )
    const entries = [
      row({ txid: tx(3), kind: 'earned', at: NOW, method: 'receive' }),
      row({ txid: tx(7), at: NOW - 5 }),
      row({ txid: tx(1), at: NOW - 9, item: { name: 'LTC', origin: 'ltc', amt: '100000000', dec: 8, backedBy: 'ltc' }, status: 'failed' }),
    ]
    const records = composeActivityRecords(foldSwapActivity(entries, [view]))
    expect(records).toHaveLength(2)
    const [swap, other] = records
    expect(swap!.subject.swap).toMatchObject({ id: 'direct:a', tone: 'done', title: 'Swapped LTC for BSV', receive: '348250000' })
    expect(swap!.entries.map((e) => e.txid ?? e.id).sort()).toEqual([tx(1), tx(3), 'swap:direct:a'].sort())
    expect(other!.subject.txid).toBe(tx(7))
  })

  it('carries the lock a swap waits on, and its count, to the Activity row', () => {
    const waiting = directSwapView(direct('a', { waiting: { for: 'peer-funding' }, own: { funding: { txid: tx(1), main: 0 }, confirmations: { have: 2, need: 6 } } }))
    const [record] = composeActivityRecords(foldSwapActivity([], [waiting]))
    expect(record!.subject.swap).toMatchObject({ tone: 'moving', confirming: { chain: 'ltc', counted: 2, needed: 6 } })
    const buried = directSwapView(direct('b', { waiting: { for: 'peer-funding' }, own: { funding: { txid: tx(1), main: 0 }, buried: true } }))
    expect(composeActivityRecords(foldSwapActivity([], [buried]))[0]!.subject.swap!.confirming).toBeUndefined()
  })

  it('names a swap by its verb, the way Activity names every action', () => {
    expect(swapActivityTitle({ tone: 'moving', from: 'bsv', to: 'ltc' })).toBe('Swapping BSV for LTC')
    expect(swapActivityTitle({ tone: 'done', from: 'bsv', to: 'ltc' })).toBe('Swapped BSV for LTC')
    expect(swapActivityTitle({ tone: 'returned', from: 'doge', to: 'bsv' })).toBe('Swap DOGE for BSV')
  })

  it('shows a swap before any of its transactions exist', () => {
    const view = exolixSwapView(exolix('ex', { stage: 'created', txid: undefined, createdAt: NOW - 1 }))
    const out = foldSwapActivity([row({ txid: tx(5), at: NOW }), row({ txid: tx(6), at: NOW - 2 })], [view])
    expect(out.map((e) => e.txid ?? e.id)).toEqual([tx(5), 'swap:exolix:ex', tx(6)])
  })

  it('a filtered feed keeps only swaps one of whose transactions passed', () => {
    const moved = exolixSwapView(exolix('a'))
    const idle = exolixSwapView(exolix('b', { txid: undefined }))
    const out = foldSwapActivity([row({ txid: tx(1) })], [moved, idle], { onlyWithLegs: true })
    expect(out.filter((e) => e.swap).map((e) => e.swap!.id)).toEqual(['exolix:a'])
  })
})
