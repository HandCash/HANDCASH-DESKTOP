import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, LockingScript, PrivateKey, P2PKH, Transaction } from '@bsv/sdk'
import type { ActiveWallet } from './session'

describe('beefCache', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('fetches a body once and serves every later send step from cache', async () => {
    const { buildMergedInputBeef, getBeefForTxidCached, resetBeefCacheForTests } =
      await import('./beefCache')
    resetBeefCacheForTests()

    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()),
    })
    const txid = tx.id('hex')
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())

    const getBeefForTxid = vi.fn(async () => {
      // Return a fresh Beef each time so a cache miss would be observable.
      const copy = new Beef()
      copy.mergeRawTx(tx.toBinary())
      return copy
    })
    const wallet = {
      services: { getBeefForTxid },
    } as unknown as ActiveWallet

    const first = await getBeefForTxidCached(wallet, txid)
    const second = await getBeefForTxidCached(wallet, txid)
    const merged = await buildMergedInputBeef(wallet, [`${txid}.0`], (op) => op)

    expect(first.findTxid(txid)?.tx).toBeTruthy()
    expect(second.findTxid(txid)?.tx).toBeTruthy()
    expect(Beef.fromBinary(merged).findTxid(txid)?.tx).toBeTruthy()
    expect(getBeefForTxid).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent fetches for the same txid', async () => {
    const { getBeefForTxidCached, resetBeefCacheForTests } = await import('./beefCache')
    resetBeefCacheForTests()

    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const txid = tx.id('hex')
    let resolveFetch!: (b: Beef) => void
    const getBeefForTxid = vi.fn(
      () =>
        new Promise<Beef>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const wallet = { services: { getBeefForTxid } } as unknown as ActiveWallet

    const a = getBeefForTxidCached(wallet, txid)
    const b = getBeefForTxidCached(wallet, txid)
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    resolveFetch(beef)
    await Promise.all([a, b])

    expect(getBeefForTxid).toHaveBeenCalledTimes(1)
  })

  it('patches missing parents as txidOnly so tip-only wraps verify under trustSelf', async () => {
    const { asTrustSelfInputBeef, resetBeefCacheForTests } = await import('./beefCache')
    resetBeefCacheForTests()

    const parent = new Transaction()
    parent.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()),
    })
    const parentId = parent.id('hex')

    const tip = new Transaction()
    tip.addInput({
      sourceTXID: parentId,
      sourceOutputIndex: 0,
      unlockingScript: LockingScript.fromHex('51'),
    })
    tip.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()),
    })
    const tipId = tip.id('hex')

    const wrap = new Beef()
    wrap.mergeTransaction(tip)
    expect(wrap.verifyValid(true).valid).toBe(false)

    const shaped = asTrustSelfInputBeef(wrap)
    expect(shaped).toBeTruthy()
    const beef = Beef.fromBinary(shaped!)
    expect(beef.findTxid(tipId)?.tx).toBeTruthy()
    expect(beef.findTxid(parentId)?.isTxidOnly).toBe(true)
    expect(beef.verifyValid(true).valid).toBe(true)
  })
})
