import { describe, expect, it, vi } from 'vitest'

const budget = vi.hoisted(() => ({ expired: false, yields: 0 }))
vi.mock('./yieldToUi', () => ({
  uiBudgetExpired: () => budget.expired,
  yieldToUi: async () => {
    budget.yields += 1
  },
}))

import { ledgerActivityRows, ledgerActivityRowsSliced } from './activityLedger'

const tx = (n: number) => n.toString(16).padStart(64, '0')
const baskets = [
  { basketId: 1, name: 'default' },
  { basketId: 2, name: '1sat' },
  { basketId: 3, name: 'bsv21' },
]

describe('ledgerActivityRows', () => {
  it('shows a payment with the time and description it was created with', () => {
    const at = new Date('2026-09-20T10:00:00Z')
    const rows = ledgerActivityRows(
      [
        { transactionId: 1, txid: tx(1), satoshis: -1_500, isOutgoing: true, description: 'Pay coffee', created_at: at },
        { transactionId: 2, txid: tx(2), satoshis: 55_000, isOutgoing: false, description: 'Deposit', created_at: at.getTime() + 1 },
      ],
      [],
      baskets,
    )
    expect(rows).toEqual([
      expect.objectContaining({ id: `ledger:${tx(1)}`, kind: 'spent', sats: 1_500, method: 'send', note: 'Pay coffee', at: at.getTime(), txid: tx(1) }),
      expect.objectContaining({ id: `ledger:${tx(2)}`, kind: 'earned', sats: 55_000, method: 'receive', note: 'Deposit' }),
    ])
  })

  it('never invents a time or an amount', () => {
    const rows = ledgerActivityRows(
      [
        { transactionId: 1, txid: tx(1), satoshis: -10 },
        { transactionId: 2, txid: tx(2), satoshis: 0, created_at: 5 },
      ],
      [],
      baskets,
    )
    expect(rows).toEqual([])
  })

  it('shows one row per collectable a transaction moved, in and out', () => {
    const rows = ledgerActivityRows(
      [
        { transactionId: 1, txid: tx(1), satoshis: 2, created_at: 5, description: 'Gift' },
        { transactionId: 2, txid: tx(2), satoshis: -40, isOutgoing: true, created_at: 6 },
      ],
      [
        { transactionId: 1, basketId: 2, vout: 0, spentBy: 2 },
        { transactionId: 1, basketId: 2, vout: 1 },
      ],
      baskets,
    )
    expect(rows.map((r) => [r.kind, r.method, r.item?.outpoint, r.note])).toEqual([
      ['earned', 'receive-collectable', `${tx(1)}.0`, 'Gift'],
      ['earned', 'receive-collectable', `${tx(1)}.1`, 'Gift'],
      ['spent', 'send-collectable', `${tx(1)}.0`, 'Sent collectable'],
    ])
    expect(rows[0]!.item).toEqual({ name: 'Collectable', origin: `${tx(1)}_0`, outpoint: `${tx(1)}.0` })
  })

  it('names a collectable by the small identity note it was filed with, and nothing larger', () => {
    const rows = ledgerActivityRows(
      [{ transactionId: 1, txid: tx(1), satoshis: 0, created_at: 5, description: 'Migrated 3 collectables' }],
      [
        { transactionId: 1, basketId: 2, vout: 0, customInstructions: JSON.stringify({ origin: `${tx(9)}.3`, name: 'Fox' }) },
        { transactionId: 1, basketId: 2, vout: 1, customInstructions: '{"origin":"not-an-origin","name":7}' },
        { transactionId: 1, basketId: 2, vout: 2, customInstructions: JSON.stringify({ origin: `${tx(9)}_4`, lineage: 'x'.repeat(5_000) }) },
      ],
      baskets,
    )
    expect(rows.map((r) => r.item)).toEqual([
      { name: 'Fox', origin: `${tx(9)}_3`, outpoint: `${tx(1)}.0` },
      { name: 'Collectable', origin: `${tx(1)}_1`, outpoint: `${tx(1)}.1` },
      { name: 'Collectable', origin: `${tx(1)}_2`, outpoint: `${tx(1)}.2` },
    ])
  })

  it('shows a send to yourself as both of its activities', () => {
    const rows = ledgerActivityRows(
      [
        { transactionId: 1, txid: tx(1), satoshis: 1, created_at: 5 },
        { transactionId: 2, txid: tx(2), satoshis: -30, isOutgoing: true, created_at: 6, description: 'Send Fox to me' },
      ],
      [
        { transactionId: 1, basketId: 2, vout: 0, spentBy: 2 },
        { transactionId: 2, basketId: 2, vout: 0 },
      ],
      baskets,
    )
    expect(rows.filter((r) => r.txid === tx(2)).map((r) => [r.kind, r.method, r.item?.outpoint, r.note])).toEqual([
      ['spent', 'send-collectable', `${tx(1)}.0`, 'Sent collectable'],
      ['earned', 'receive-collectable', `${tx(2)}.0`, 'Received collectable'],
    ])
  })

  it('shows a mint as a receive although it only cost the fee', () => {
    const rows = ledgerActivityRows(
      [{ transactionId: 1, txid: tx(1), satoshis: -25, isOutgoing: true, created_at: 5, description: 'Mint Fox' }],
      [{ transactionId: 1, basketId: 2, vout: 0 }],
      baskets,
    )
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'earned', method: 'receive-collectable', note: 'Mint Fox', item: expect.objectContaining({ outpoint: `${tx(1)}.0` }) }),
    ])
  })

  it('names a token move without dressing it up as a collectable', () => {
    const rows = ledgerActivityRows(
      [{ transactionId: 1, txid: tx(1), satoshis: -30, isOutgoing: true, created_at: 5 }],
      [{ transactionId: 9, txid: tx(9), basketId: 3, vout: 0, spentBy: 1 }],
      baskets,
    )
    expect(rows).toEqual([
      expect.objectContaining({ method: 'send', sats: 30, note: 'Token transfer' }),
    ])
    expect(rows[0]!.item).toBeUndefined()
  })
})

describe('ledgerActivityRowsSliced', () => {
  it('projects a large history with turns for the UI and the same rows', async () => {
    const txs = Array.from({ length: 3_000 }, (_, i) => ({
      transactionId: i + 1,
      txid: tx(i + 1),
      satoshis: i % 2 ? -(i + 10) : i + 10,
      isOutgoing: i % 2 === 1,
      created_at: 1_000 + i,
    }))
    const outputs = Array.from({ length: 2_000 }, (_, i) => ({
      transactionId: (i % 3_000) + 1,
      basketId: 2,
      vout: 1,
      customInstructions: JSON.stringify({ origin: `${tx(i + 1)}_0`, name: `Cat ${i}` }),
    }))
    budget.expired = true
    budget.yields = 0
    const sliced = await ledgerActivityRowsSliced(txs, outputs, baskets)
    budget.expired = false
    expect(sliced).toEqual(ledgerActivityRows(txs, outputs, baskets))
    expect(budget.yields).toBeGreaterThan(10)
  })
})
