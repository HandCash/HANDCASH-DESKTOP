import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, LockingScript, MerklePath, PrivateKey, P2PKH, Transaction } from '@bsv/sdk'
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

  it('hydrates missing parents with proofs — never leaves txidOnly stubs', async () => {
    const { hydrateInputBeef, incompleteProofTxids, resetBeefCacheForTests } =
      await import('./beefCache')
    resetBeefCacheForTests()

    const parent = new Transaction()
    parent.addOutput({
      satoshis: 10_000,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()),
    })
    const parentId = parent.id('hex')
    const parentProof = new MerklePath(800_001, [
      [
        { offset: 0, hash: parentId, txid: true },
        { offset: 1, duplicate: true },
      ],
    ])

    const tip = new Transaction()
    tip.addInput({
      sourceTXID: parentId,
      sourceOutputIndex: 0,
      unlockingScript: LockingScript.fromHex('51'),
    })
    tip.addOutput({
      satoshis: 9_900,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()),
    })
    const tipId = tip.id('hex')

    const wrap = new Beef()
    wrap.mergeTransaction(tip)
    expect(wrap.verifyValid(false).valid).toBe(false)
    expect(incompleteProofTxids(wrap)).toContain(parentId)

    const getBeefForTxid = vi.fn(async () => {
      const proved = new Beef()
      proved.mergeRawTx(parent.toBinary())
      proved.mergeBump(parentProof)
      return proved
    })
    const wallet = {
      services: { getBeefForTxid },
    } as unknown as ActiveWallet

    const shaped = await hydrateInputBeef(wallet, wrap)
    expect(shaped).toBeTruthy()
    expect(getBeefForTxid).toHaveBeenCalledWith(parentId)
    const beef = Beef.fromBinary(shaped!)
    expect(beef.findTxid(tipId)?.tx).toBeTruthy()
    expect(beef.findTxid(parentId)?.tx).toBeTruthy()
    expect(beef.findTxid(parentId)?.isTxidOnly).toBeFalsy()
    expect(incompleteProofTxids(beef)).toEqual([])
    expect(beef.verifyValid(false).valid).toBe(true)
  })
})
