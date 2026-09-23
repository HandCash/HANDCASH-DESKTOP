import { Beef, LockingScript, Transaction, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storageRegistry } from '../storage/registry'
import { bindAccountLocalKeyScope } from './accountLocalKeys'

const store = new Map<string, string>()
const ARCHIVE_KEY = storageRegistry.signedChequeArchive.key
const MINER_KEY = storageRegistry.pendingMinerOutbox.key

function signedTx(satoshis: number): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis, lockingScript: LockingScript.fromHex('51') })
  return tx
}

function atomicBeefFor(tx: Transaction): number[] {
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return beef.toBinaryAtomic(tx.id('hex'))
}

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

describe('signedChequeArchive', () => {
  beforeEach(() => {
    store.clear()
  })

  it('keeps the signed Atomic BEEF after the miner outbox would drop it', async () => {
    const { archiveSignedCheque, signedChequeAtomic, listSignedChequeTxids } =
      await import('./signedChequeArchive')
    const tx = signedTx(1_362)
    const txid = tx.id('hex')
    const atomic = atomicBeefFor(tx)

    expect(archiveSignedCheque(txid, atomic, { flow: 'payment' })).toBe(true)
    expect(listSignedChequeTxids()).toEqual([txid])
    expect(signedChequeAtomic(txid)).toEqual(atomic)
  })

  it('replaces a thinner archived body with a hydrated one', async () => {
    const { archiveSignedCheque, signedChequeAtomic } = await import(
      './signedChequeArchive'
    )
    const tx = signedTx(200)
    const txid = tx.id('hex')
    const thin = atomicBeefFor(tx)
    const parent = signedTx(1)
    const thickBeef = new Beef()
    thickBeef.mergeRawTx(parent.toBinary())
    thickBeef.mergeRawTx(tx.toBinary())
    const thick = thickBeef.toBinaryAtomic(txid)

    expect(archiveSignedCheque(txid, thin)).toBe(true)
    expect(archiveSignedCheque(txid, thick)).toBe(true)
    expect(signedChequeAtomic(txid)?.length).toBe(thick.length)
  })

  it('absorbs leftover miner-outbox bodies on first read', async () => {
    const tx = signedTx(20_000)
    const txid = tx.id('hex')
    const atomic = atomicBeefFor(tx)
    store.set(
      MINER_KEY,
      JSON.stringify([
        {
          txid,
          atomic,
          createdAt: Date.now(),
          attempts: 0,
          nextAttemptAt: Date.now(),
          flow: 'payment',
        },
      ]),
    )

    const { listSignedCheques } = await import('./signedChequeArchive')
    const rows = listSignedCheques()
    expect(rows).toEqual([
      expect.objectContaining({ txid, flow: 'payment', atomic }),
    ])
    const saved = JSON.parse(store.get(ARCHIVE_KEY) || '[]') as Array<{
      atomicB64: string
    }>
    expect(Utils.toArray(saved[0]!.atomicB64, 'base64')).toEqual(atomic)
  })

  it('writes to the captured derivation scope even after the global scope moves', async () => {
    const { archiveSignedCheque, listSignedChequeTxids } = await import(
      './signedChequeArchive'
    )
    const tx = signedTx(777)
    const txid = tx.id('hex')
    const owner = {
      accountIndex: 4,
      identityKey: 'identity-four',
      chain: 'main' as const,
    }

    bindAccountLocalKeyScope({
      accountIndex: 5,
      identityKey: 'identity-five',
      chain: 'main',
    })
    expect(
      archiveSignedCheque(txid, atomicBeefFor(tx), { flow: 'payment', owner }),
    ).toBe(true)
    expect(listSignedChequeTxids()).toEqual([])

    bindAccountLocalKeyScope(owner)
    expect(listSignedChequeTxids()).toEqual([txid])
  })
})
