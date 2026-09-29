import { Beef, MerklePath, PrivateKey, P2PKH, Script, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  inputsWithPossiblyMinedParent,
  parseConfirmedForeignSpender,
} from './createActionInputFate'

const SELF = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)

describe('parseConfirmedForeignSpender', () => {
  it('names a confirmed spender that is not this transaction', () => {
    expect(
      parseConfirmedForeignSpender(
        { txid: OTHER, status: 'confirmed' },
        SELF,
      ),
    ).toBe(OTHER)
  })

  it('ignores a spend by this transaction and anything not confirmed', () => {
    expect(
      parseConfirmedForeignSpender({ txid: SELF, status: 'confirmed' }, SELF),
    ).toBeNull()
    expect(
      parseConfirmedForeignSpender(
        { txid: OTHER, status: 'unconfirmed' },
        SELF,
      ),
    ).toBeNull()
    expect(parseConfirmedForeignSpender({ status: 'confirmed' }, SELF)).toBeNull()
    expect(parseConfirmedForeignSpender(null, SELF)).toBeNull()
  })
})

describe('inputsWithPossiblyMinedParent', () => {
  const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

  function txFrom(prevTxids: string[]): Transaction {
    const tx = new Transaction()
    for (const sourceTXID of prevTxids) {
      tx.addInput({ sourceTXID, sourceOutputIndex: 0, unlockingScript: new Script() })
    }
    tx.addOutput({ lockingScript: lock, satoshis: 1_000 })
    return tx
  }

  it('skips inputs whose parent rides the BEEF unmined, probes the rest', () => {
    const mined = txFrom(['11'.repeat(32)])
    mined.merklePath = MerklePath.fromCoinbaseTxidAndHeight(mined.id('hex'), 900_000)
    const unmined = txFrom(['22'.repeat(32)])
    const txidOnly = '33'.repeat(32)
    const absent = '44'.repeat(32)
    const child = txFrom([mined.id('hex'), unmined.id('hex'), txidOnly, absent])

    const beef = new Beef()
    beef.mergeTransaction(mined)
    beef.mergeRawTx(unmined.toBinary())
    beef.mergeTxidOnly(txidOnly)
    beef.mergeRawTx(child.toBinary())
    const atomic = Array.from(beef.toBinaryAtomic(child.id('hex')))

    expect(inputsWithPossiblyMinedParent(atomic, child.id('hex'))).toEqual([
      `${mined.id('hex')}.0`,
      `${txidOnly}.0`,
      `${absent}.0`,
    ])
  })
})
