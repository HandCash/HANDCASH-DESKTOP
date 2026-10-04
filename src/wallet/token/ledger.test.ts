import { describe, expect, it } from 'vitest'
import type { ActivityEntry } from '../appActivity'
import { formatTokenLedger, tokenLedger } from './ledger'

const TOKEN = `${'10a25f333af2'.padEnd(64, '0')}_0`

function row(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: Math.random().toString(16).slice(2),
    origin: 'wallet',
    kind: 'earned',
    at: 1,
    sats: 1,
    method: 'receive-token',
    status: 'complete',
    item: { name: 'REF', origin: TOKEN, tokenId: TOKEN, amt: '1000' },
    ...over,
  } as ActivityEntry
}

describe('token ledger', () => {
  const tips = [
    { outpoint: `${'a1'.repeat(32)}_0`, amt: '1000', encoding: 'brc162' as const },
    { outpoint: `${'b2'.repeat(32)}_1`, amt: '2000' },
    { outpoint: `${'c3'.repeat(32)}_0`, amt: '1000', encoding: 'legacy-json' as const },
  ]

  it('splits a card by tip kind beside its Activity net', () => {
    const ledger = tokenLedger({ tokenId: TOKEN, sym: 'REF' }, tips, [
      row({}),
      row({ kind: 'spent', method: 'burn-token', burn: { asset: 'bsv21', destroyedAmount: '200' } }),
      row({ status: 'failed', item: { name: 'REF', origin: TOKEN, tokenId: TOKEN, amt: '9999' } }),
      row({ item: { name: 'X', origin: 'x', tokenId: `${'ff'.repeat(32)}_0`, amt: '5' } }),
    ])
    expect(ledger.held).toBe(4000n)
    expect(ledger.byKind).toEqual({
      brc162: { amt: 1000n, tips: 1 },
      'legacy-json': { amt: 1000n, tips: 1 },
      remittance: { amt: 2000n, tips: 1 },
    })
    expect([ledger.historyIn, ledger.historyOut, ledger.historyRows]).toEqual([1000n, 200n, 2])
  })

  it('formats the line triage parses, largest tips first', () => {
    const line = formatTokenLedger(tokenLedger({ tokenId: TOKEN, sym: 'Ref Coin' }, tips, [row({})]))
    expect(line).toBe(
      '[bsv21] ledger Ref_Coin 10a25f333af2 holds 4000 in 3 tip(s) — ' +
        'brc162 1000/1, legacy-json 1000/1, remittance 2000/1; history in 1000 out 0 over 1 row(s); ' +
        `tips ${'b2'.repeat(6)}…_1=2000:remittance ${'a1'.repeat(6)}…_0=1000:brc162 ${'c3'.repeat(6)}…_0=1000:legacy-json`,
    )
  })
})
