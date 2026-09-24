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

/** Origin-storage quota, the way a phone imposes it: refuse oversized writes. */
let storeByteCap = Number.POSITIVE_INFINITY
/** Serialize + write attempts, which is what the stall was made of. */
let writeAttempts = 0

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    writeAttempts += 1
    if (value.length > storeByteCap) return false
    store.set(key, value)
    return true
  },
}))

describe('signedChequeArchive', () => {
  beforeEach(() => {
    store.clear()
    storeByteCap = Number.POSITIVE_INFINITY
    writeAttempts = 0
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

  // A full archive refused every write, and because a refused archive fails
  // the send closed, the wallet stopped signing anything at all.
  it('evicts the oldest cheques rather than refuse a write to a full store', async () => {
    bindAccountLocalKeyScope({
      accountIndex: 0,
      identityKey: 'identity-quota',
      chain: 'main',
    })
    const { archiveSignedCheque, listSignedChequeTxids } = await import(
      './signedChequeArchive'
    )
    const cheques = [11, 22, 33].map((sats) => {
      const tx = signedTx(sats)
      return { txid: tx.id('hex'), atomic: atomicBeefFor(tx) }
    })

    expect(archiveSignedCheque(cheques[0]!.txid, cheques[0]!.atomic)).toBe(true)
    expect(archiveSignedCheque(cheques[1]!.txid, cheques[1]!.atomic)).toBe(true)
    // Room for two rows, not three.
    storeByteCap = (store.get(listArchiveKey()) ?? '').length

    expect(archiveSignedCheque(cheques[2]!.txid, cheques[2]!.atomic)).toBe(true)
    expect(listSignedChequeTxids()).toEqual([cheques[1]!.txid, cheques[2]!.txid])
  })

  // Shedding one cheque per pass meant a full store cost one megabyte-scale
  // `JSON.stringify` per archived row before it gave up — several seconds of
  // blocked main thread inside a send an app was waiting on, twice per send.
  it('gives up on a full store in a handful of passes, not one per cheque', async () => {
    bindAccountLocalKeyScope({
      accountIndex: 0,
      identityKey: 'identity-full',
      chain: 'main',
    })
    const { archiveSignedCheque } = await import('./signedChequeArchive')
    for (let index = 0; index < 120; index++) {
      const tx = signedTx(1_000 + index)
      expect(archiveSignedCheque(tx.id('hex'), atomicBeefFor(tx))).toBe(true)
    }

    storeByteCap = 0
    writeAttempts = 0
    const tx = signedTx(99_999)
    expect(archiveSignedCheque(tx.id('hex'), atomicBeefFor(tx))).toBe(false)
    // Halving 121 rows bottoms out in ~8 passes; one-at-a-time took 120.
    expect(writeAttempts).toBeLessThanOrEqual(12)
  })

  it('refuses only when the newest cheque alone cannot be stored', async () => {
    bindAccountLocalKeyScope({
      accountIndex: 0,
      identityKey: 'identity-tiny',
      chain: 'main',
    })
    const { archiveSignedCheque } = await import('./signedChequeArchive')
    const tx = signedTx(99)
    storeByteCap = 8

    expect(archiveSignedCheque(tx.id('hex'), atomicBeefFor(tx))).toBe(false)
  })
})

function listArchiveKey(): string {
  return [...store.keys()].find((key) => key.startsWith(ARCHIVE_KEY)) ?? ARCHIVE_KEY
}
