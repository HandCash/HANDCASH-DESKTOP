import { describe, expect, it } from 'vitest'
import { peerSpendCandidates, planPeerSpends, type SnapshotTx } from './peerDeviceSpends'

const T = (c: string) => c.repeat(64)
const op = (c: string, vout = 0) => `${T(c)}.${vout}`

describe('peerSpendCandidates', () => {
  it('claims only coins still spendable here, once, and skips txs that spent nothing', () => {
    const txs: SnapshotTx[] = [
      { txid: T('1'), status: 'unproven', inputs: [op('a'), op('b')] },
      { txid: T('2'), status: 'completed', inputs: [op('a')] },
      { txid: T('3'), status: 'failed', inputs: [op('c')] },
      { txid: T('4'), status: 'unsigned', inputs: [op('c')] },
      { txid: T('5'), status: 'nosend', inputs: [op('d')] },
    ]
    const spendable = new Set([op('a'), op('c'), op('d')])
    expect(peerSpendCandidates(txs, spendable)).toEqual([
      { outpoint: op('a'), spender: T('1') },
      { outpoint: op('d'), spender: T('5') },
    ])
  })
})

describe('planPeerSpends', () => {
  const txs: SnapshotTx[] = [
    { txid: T('1'), status: 'unproven', inputs: [op('a')] },
    { txid: T('2'), status: 'unproven', inputs: [op('b')] },
    { txid: T('9'), status: 'failed', inputs: [] },
  ]

  it('leaves transactions this ledger already holds to the ledger', () => {
    const plan = planPeerSpends({
      txs,
      candidates: [
        { outpoint: op('a'), spender: T('1') },
        { outpoint: op('b'), spender: T('2') },
      ],
      knownHere: new Set([T('2')]),
      recordedSpenders: new Set(),
    })
    expect(plan.spends).toEqual([{ outpoint: op('a'), spender: T('1') }])
  })

  it('withdraws a recorded spender the newer snapshot shows failed', () => {
    const plan = planPeerSpends({
      txs,
      candidates: [],
      knownHere: new Set(),
      recordedSpenders: new Set([T('9'), T('1')]),
    })
    expect(plan.withdrawn).toEqual([T('9')])
  })
})
