import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, LockingScript, MerklePath, PrivateKey, P2PKH, Transaction } from '@bsv/sdk'
import type { ActiveWallet } from './session'

describe('beefCache', () => {
  beforeEach(async () => {
    vi.resetModules()
    const { resetBeefCacheForTests, resetDurableBeefForTests } = await import('./beefCache')
    resetBeefCacheForTests()
    resetDurableBeefForTests()
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
    const wallet = {
      wallet: { storage: { isActiveStorageProvider: () => false } },
      services: { getBeefForTxid },
    } as unknown as ActiveWallet

    const a = getBeefForTxidCached(wallet, txid)
    const b = getBeefForTxidCached(wallet, txid)
    // Storage probe is async — wait until the shared indexer call is armed.
    await vi.waitFor(() => {
      expect(getBeefForTxid).toHaveBeenCalledTimes(1)
      expect(typeof resolveFetch).toBe('function')
    })
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    resolveFetch(beef)
    await Promise.all([a, b])

    expect(getBeefForTxid).toHaveBeenCalledTimes(1)
  })

  it('prefers indexer BEEF before raw when allowUnprovenRawTx is set', async () => {
    const { getBeefForTxidCached, resetBeefCacheForTests } = await import('./beefCache')
    resetBeefCacheForTests()

    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const txid = tx.id('hex')
    const getRawTx = vi.fn(async () => ({ rawTx: Array.from(tx.toBinary()) }))
    const proven = new Beef()
    proven.mergeRawTx(tx.toBinary())
    const getBeefForTxid = vi.fn(async () => {
      const copy = new Beef()
      copy.mergeRawTx(tx.toBinary())
      return copy
    })
    const wallet = {
      wallet: { storage: { isActiveStorageProvider: () => false } },
      services: { getRawTx, getBeefForTxid },
    } as unknown as ActiveWallet

    const beef = await getBeefForTxidCached(wallet, txid, {
      allowUnprovenRawTx: true,
    })
    expect(beef.findTxid(txid)?.tx).toBeTruthy()
    expect(getBeefForTxid).toHaveBeenCalledTimes(1)
    expect(getRawTx).not.toHaveBeenCalled()
  })

  it('falls back to raw when the indexer fails and allowUnprovenRawTx is set', async () => {
    const { getBeefForTxidCached, resetBeefCacheForTests } = await import('./beefCache')
    resetBeefCacheForTests()

    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const txid = tx.id('hex')
    const getRawTx = vi.fn(async () => ({ rawTx: Array.from(tx.toBinary()) }))
    const getBeefForTxid = vi.fn(async () => {
      throw new Error('indexer down')
    })
    // WoC proof fallback misses this regtest txid — exercise the raw path.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 404 }))
    try {
      const wallet = {
        wallet: { storage: { isActiveStorageProvider: () => false } },
        services: { getRawTx, getBeefForTxid },
      } as unknown as ActiveWallet

      const beef = await getBeefForTxidCached(wallet, txid, {
        allowUnprovenRawTx: true,
      })
      expect(beef.findTxid(txid)?.tx).toBeTruthy()
      expect(getBeefForTxid).toHaveBeenCalledTimes(1)
      expect(getRawTx).toHaveBeenCalledTimes(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('falls back to a proof-carrying WhatsOnChain BEEF when the indexer 404s (no raw flag)', async () => {
    const { getBeefForTxidCached, resetBeefCacheForTests } = await import('./beefCache')
    resetBeefCacheForTests()

    // A proven tip: parent with a merkle proof, spent by the subject.
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
    const tx = new Transaction()
    tx.addInput({
      sourceTXID: parentId,
      sourceOutputIndex: 0,
      unlockingScript: LockingScript.fromHex('51'),
    })
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const txid = tx.id('hex')
    const wocBeef = new Beef()
    wocBeef.mergeRawTx(parent.toBinary())
    wocBeef.mergeBump(parentProof)
    wocBeef.mergeTransaction(tx)
    const wocHex = Buffer.from(wocBeef.toBinary()).toString('hex')

    const getBeefForTxid = vi.fn(async () => {
      throw new Error('indexer 404')
    })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes('/tx/') && href.endsWith('/beef')) {
          return new Response(wocHex, { status: 200 })
        }
        return new Response('nope', { status: 404 })
      })

    try {
      const wallet = {
        chain: 'main',
        wallet: { storage: { isActiveStorageProvider: () => false } },
        services: { getBeefForTxid },
      } as unknown as ActiveWallet

      // No allowUnprovenRawTx — this is the BRC-150 proof path.
      const beef = await getBeefForTxidCached(wallet, txid)
      expect(beef.findTxid(txid)?.tx).toBeTruthy()
      expect(beef.findTxid(parentId)?.isTxidOnly).toBeFalsy()
      expect(fetchSpy).toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('times out a hung indexer fetch instead of hanging forever', async () => {
    const { getBeefForTxidCached, resetBeefCacheForTests } = await import('./beefCache')
    resetBeefCacheForTests()

    const getBeefForTxid = vi.fn(
      () =>
        new Promise<Beef>(() => {
          /* never resolves */
        }),
    )
    // The proof fallback must not turn a hung indexer into a hung test.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 404 }))
    try {
      const wallet = {
        wallet: { storage: { isActiveStorageProvider: () => false } },
        services: { getBeefForTxid },
      } as unknown as ActiveWallet

      await expect(getBeefForTxidCached(wallet, 'a'.repeat(64))).rejects.toThrow(
        /timed out/i,
      )
    } finally {
      fetchSpy.mockRestore()
    }
  }, 15_000)

  it('uses caller-ready BEEF without fetching when already broadcast-safe', async () => {
    const { hydrateInputBeef, resetBeefCacheForTests } = await import('./beefCache')
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

    const ready = new Beef()
    ready.mergeRawTx(parent.toBinary())
    ready.mergeBump(parentProof)
    ready.mergeTransaction(tip)
    expect(ready.verifyValid(false).valid).toBe(true)

    const getBeefForTxid = vi.fn(async () => {
      throw new Error('indexer should not be called')
    })
    const wallet = {
      wallet: { storage: { isActiveStorageProvider: () => false } },
      services: { getBeefForTxid },
    } as unknown as ActiveWallet

    const shaped = await hydrateInputBeef(wallet, ready)
    expect(shaped).toBeTruthy()
    expect(getBeefForTxid).not.toHaveBeenCalled()
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

  it('remembers a just-created settle BEEF so the next send skips the indexer', async () => {
    const { getBeefForTxidCached, rememberBeefBinary, resetBeefCacheForTests } =
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
    rememberBeefBinary(txid, beef.toBinary())

    const getBeefForTxid = vi.fn(async () => {
      throw new Error('indexer should not be called')
    })
    const wallet = {
      wallet: { storage: { isActiveStorageProvider: () => false } },
      services: { getBeefForTxid },
    } as unknown as ActiveWallet

    const got = await getBeefForTxidCached(wallet, txid)
    expect(got.findTxid(txid)?.tx).toBeTruthy()
    expect(getBeefForTxid).not.toHaveBeenCalled()
  })

  it('reloads a persisted settle BEEF after the session cache is cleared', async () => {
    const {
      getBeefForTxidCached,
      rememberBeefBinary,
      resetBeefCacheForTests,
      resetDurableBeefForTests,
    } = await import('./beefCache')
    resetDurableBeefForTests()
    resetBeefCacheForTests()

    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()),
    })
    tx.addOutput({
      satoshis: 2,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash()),
    })
    const txid = tx.id('hex')
    const beef = new Beef()
    beef.mergeRawTx(tx.toBinary())
    rememberBeefBinary(txid, beef.toBinary())
    resetBeefCacheForTests()

    const getBeefForTxid = vi.fn(async () => {
      throw new Error('indexer should not be called')
    })
    const wallet = {
      wallet: { storage: { isActiveStorageProvider: () => false } },
      services: { getBeefForTxid },
    } as unknown as ActiveWallet

    const got = await getBeefForTxidCached(wallet, txid)
    expect(got.findTxid(txid)?.tx).toBeTruthy()
    expect(getBeefForTxid).not.toHaveBeenCalled()
  })
})
