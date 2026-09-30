import { P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { peerSnapshotFromBrc38 } from './peerSnapshot'

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

function spend(prev: string, vout: number): Transaction {
  const t = new Transaction()
  t.addInput({ sourceTXID: prev, sourceOutputIndex: vout, unlockingScript: new Script() })
  t.addOutput({ lockingScript: lock, satoshis: 500 })
  return t
}

const b64 = (tx: Transaction) => Utils.toBase64(tx.toBinary())

describe('peerSnapshotFromBrc38', () => {
  it('names inputs from bodies, proven bodies and spent output rows', () => {
    const a = spend('aa'.repeat(32), 1)
    const b = spend('bb'.repeat(32), 0)
    const c = 'cc'.repeat(32)
    const dead = spend('ee'.repeat(32), 0)
    const snapshot = peerSnapshotFromBrc38({
      sourceStorage: { storageIdentityKey: '02abc' },
      tables: {
        provenTxs: [{ provenTxId: 7, rawTx: b64(b) }],
        outputs: [
          { txid: 'dd'.repeat(32), vout: 3, spentBy: 3 },
          { txid: 'ff'.repeat(32), vout: 0 },
        ],
        transactions: [
          { transactionId: 1, txid: a.id('hex'), status: 'unproven', rawTx: b64(a) },
          { transactionId: 2, txid: b.id('hex'), status: 'completed', provenTxId: 7 },
          { transactionId: 3, txid: c, status: 'sending' },
          { transactionId: 4, txid: dead.id('hex'), status: 'failed', rawTx: b64(dead) },
          { transactionId: 5, txid: 'not-a-txid', status: 'completed' },
        ],
      },
    })
    expect(snapshot.storageIdentityKey).toBe('02abc')
    expect(snapshot.txs).toEqual([
      { txid: a.id('hex'), status: 'unproven', inputs: [`${'aa'.repeat(32)}.1`] },
      { txid: b.id('hex'), status: 'completed', inputs: [`${'bb'.repeat(32)}.0`] },
      { txid: c, status: 'sending', inputs: [`${'dd'.repeat(32)}.3`] },
      { txid: dead.id('hex'), status: 'failed', inputs: [] },
    ])
  })

  it('reads an empty or malformed document as no spends', () => {
    expect(peerSnapshotFromBrc38(null)).toEqual({ storageIdentityKey: null, txs: [] })
    expect(peerSnapshotFromBrc38({ tables: { transactions: 'x' } }).txs).toEqual([])
  })
})
