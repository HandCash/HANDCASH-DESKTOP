import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const filed = vi.hoisted(() => vi.fn())
vi.mock('./holdingsReconcile', () => ({ fileHoldingsDepartures: filed }))

import { encodeBsv21Binary } from './token/decode162'
import { fileUnstoredSendTips } from './unstoredSendTips'

const TOKEN_ID = `${'cd'.repeat(32)}_0`

function signedSend(ours: string, payee: string): { txid: string; atomic: number[] } {
  const parent = new Transaction()
  parent.addInput({ sourceTXID: '22'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() })
  parent.addOutput({ satoshis: 10_000, lockingScript: new P2PKH().lock(ours) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new Script() })
  const token = (to: string, amount: bigint) =>
    encodeBsv21Binary({ tokenId: TOKEN_ID, amount, rest: new P2PKH().lock(to).toHex() })
  tx.addOutput({ satoshis: 1, lockingScript: token(payee, 200n) })
  tx.addOutput({ satoshis: 1, lockingScript: token(ours, 800n) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(ours) })
  tx.addOutput({ satoshis: 4_948, lockingScript: new P2PKH().lock(ours) })
  return { txid: tx.id('hex'), atomic: Array.from(tx.toAtomicBEEF()) }
}

describe('fileUnstoredSendTips', () => {
  beforeEach(() => filed.mockClear())

  it('files only the 1-sat tips that pay this wallet, by asset', () => {
    const ours = PrivateKey.fromRandom().toAddress()
    const payee = PrivateKey.fromRandom().toAddress()
    const { txid, atomic } = signedSend(ours, payee)

    expect(fileUnstoredSendTips(txid, atomic, ours)).toEqual({ tokens: 1, items: 1 })
    expect(filed).toHaveBeenCalledWith('token', [`${txid}.1`])
    expect(filed).toHaveBeenCalledWith('item', [`${txid}.2`])
  })

  it('files nothing for a body that is not this transaction', () => {
    const ours = PrivateKey.fromRandom().toAddress()
    const { atomic } = signedSend(ours, PrivateKey.fromRandom().toAddress())

    expect(fileUnstoredSendTips('ee'.repeat(32), atomic, ours)).toEqual({ tokens: 0, items: 0 })
    expect(fileUnstoredSendTips('ee'.repeat(32), [1, 2, 3], ours)).toEqual({ tokens: 0, items: 0 })
    expect(filed).not.toHaveBeenCalled()
  })
})
