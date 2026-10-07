import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { loadLedgerRows, saveLedgerRows } from './activityLedgerStore'
import type { ActivityEntry } from './appActivity'

const txid = (n: number) => n.toString(16).padStart(64, '0')
const row = (n: number, at: number): ActivityEntry => ({
  id: `ledger:${txid(n)}`,
  origin: 'handcash',
  kind: 'earned',
  sats: n,
  at,
  method: 'receive',
  txid: txid(n),
})

describe('activityLedgerStore', () => {
  it('keeps one read per namespace, oldest first, and drops rows that are not ledger rows', async () => {
    await saveLedgerRows('a', [row(2, 20), row(1, 10)])
    await saveLedgerRows('b', [row(3, 30)])
    expect((await loadLedgerRows('a'))!.map((r) => r.txid)).toEqual([txid(1), txid(2)])
    expect((await loadLedgerRows('b'))!.map((r) => r.txid)).toEqual([txid(3)])

    await saveLedgerRows('a', [row(4, 40), { ...row(5, 50), id: 'stored:5' }, { ...row(6, 60), txid: 'nope' }])
    expect((await loadLedgerRows('a'))!.map((r) => r.txid)).toEqual([txid(4)])
    expect(await loadLedgerRows('missing')).toBeNull()
  })
})
