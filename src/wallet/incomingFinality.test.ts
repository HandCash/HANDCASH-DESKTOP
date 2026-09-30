import { Beef, MerklePath, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { assertIncomingFinal, IncomingNotFinalError, unprovenTxsOf } from './incomingFinality'

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

function payment(opts: { lockTime: number; sequence: number }): { atomic: number[]; parent: Transaction } {
  const parent = new Transaction()
  parent.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() })
  parent.addOutput({ lockingScript: lock, satoshis: 2_000 })
  parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 900_000)
  const child = new Transaction()
  child.lockTime = opts.lockTime
  child.addInput({
    sourceTXID: parent.id('hex'),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: opts.sequence,
  })
  child.addOutput({ lockingScript: lock, satoshis: 1_900 })
  const beef = new Beef()
  beef.mergeTransaction(parent)
  beef.mergeRawTx(child.toBinary())
  return { atomic: Array.from(beef.toBinaryAtomic(child.id('hex'))), parent }
}

describe('assertIncomingFinal', () => {
  it('judges only the unproven transactions in the package', () => {
    const { atomic, parent } = payment({ lockTime: 0, sequence: 0xffffffff })
    const txids = unprovenTxsOf(atomic).map((t) => t.txid)
    expect(txids).toHaveLength(1)
    expect(txids).not.toContain(parent.id('hex'))
  })

  it('credits a final payment without asking for the tip', async () => {
    const getHeight = vi.fn(async () => 900_000)
    await assertIncomingFinal(payment({ lockTime: 0, sequence: 0 }).atomic, getHeight)
    await assertIncomingFinal(payment({ lockTime: 999_999, sequence: 0xffffffff }).atomic, getHeight)
    expect(getHeight).not.toHaveBeenCalled()
  })

  it('refuses a payment its sender can still replace', async () => {
    const { atomic } = payment({ lockTime: 950_000, sequence: 1 })
    await expect(assertIncomingFinal(atomic, async () => 900_000)).rejects.toMatchObject({
      name: 'IncomingNotFinalError',
      reason: 'non-final',
    })
  })

  it('credits a lock time the chain has already reached', async () => {
    const { atomic } = payment({ lockTime: 899_999, sequence: 1 })
    await expect(assertIncomingFinal(atomic, async () => 900_000)).resolves.toBeUndefined()
  })

  it('fails closed when a live lock time meets no chain height', async () => {
    const { atomic } = payment({ lockTime: 899_999, sequence: 1 })
    const err = await assertIncomingFinal(atomic, async () => {
      throw new Error('offline')
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IncomingNotFinalError)
    expect((err as IncomingNotFinalError).reason).toBe('finality-unknown')
  })
})
