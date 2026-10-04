import { Beef, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_INPUT_BEEF,
  isInputBeefRefusal,
  verifiableInputBeef,
} from './verifiableInputBeef'

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

function txSpending(sourceTXID: string, salt: number): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID, sourceOutputIndex: 0, unlockingScript: lock, sequence: 0xffffffff })
  tx.addOutput({ lockingScript: lock, satoshis: 1000 + salt })
  return tx
}

function child(parent: Transaction, salt: number): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: lock, sequence: 0xffffffff })
  tx.addOutput({ lockingScript: lock, satoshis: salt })
  return tx
}

describe('verifiableInputBeef — the package the Toolbox verifies before reading storage', () => {
  it('drops an unconfirmed funding parent with no ancestry, and the tip that depends on it', () => {
    const funding = txSpending('11'.repeat(32), 1)
    const tip = child(funding, 1)
    const beef = new Beef()
    beef.mergeRawTx(funding.toBinary())
    beef.mergeRawTx(tip.toBinary())
    expect(beef.isValid(true)).toBe(false)

    const frame = verifiableInputBeef(beef.toBinary())

    expect(frame.dropped.sort()).toEqual([funding.id('hex'), tip.id('hex')].sort())
    expect(Beef.fromBinary(frame.inputBEEF).isValid(true)).toBe(true)
  })

  it('keeps a proven chain and drops only the stray body beside it', () => {
    const mined = txSpending('22'.repeat(32), 2)
    mined.merklePath = new MerklePath(900_000, [[{ offset: 0, hash: mined.id('hex'), txid: true }]])
    const tip = child(mined, 2)
    const stray = txSpending('33'.repeat(32), 3)
    const beef = new Beef()
    beef.mergeTransaction(tip)
    beef.mergeRawTx(stray.toBinary())

    const frame = verifiableInputBeef(beef.toBinary())
    const kept = Beef.fromBinary(frame.inputBEEF)

    expect(frame.dropped).toEqual([stray.id('hex')])
    expect(kept.findTxid(tip.id('hex'))?.tx).toBeTruthy()
    expect(kept.findTxid(mined.id('hex'))?.tx).toBeTruthy()
    expect(frame.roots).toEqual({ 900000: mined.id('hex') })
  })

  it('leaves txid-only parents to trustSelf', () => {
    const parentTxid = '44'.repeat(32)
    const tip = txSpending(parentTxid, 4)
    const beef = new Beef()
    beef.mergeTxidOnly(parentTxid)
    beef.mergeRawTx(tip.toBinary())

    const frame = verifiableInputBeef(beef.toBinary())

    expect(frame.dropped).toEqual([])
    expect(frame.inputBEEF).not.toBe(EMPTY_INPUT_BEEF)
  })

  it('names the Toolbox whole-package refusal and nothing else', () => {
    expect(
      isInputBeefRefusal(
        new Error('The inputBEEF parameter must be valid Beef when factoring options.trustSelf'),
      ),
    ).toBe(true)
    expect(
      isInputBeefRefusal(
        new Error('The inputBEEF parameter must be valid and contain proof data for possibly known abc'),
      ),
    ).toBe(false)
  })
})
