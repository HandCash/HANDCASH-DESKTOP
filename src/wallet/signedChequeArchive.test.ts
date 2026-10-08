import { Beef, LockingScript, Transaction, Utils } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storageRegistry } from '../storage/registry'
import { bindAccountLocalKeyScope } from './accountLocalKeys'

const store = new Map<string, string>()
const INDEX_KEY = storageRegistry.signedChequeIndex.key
const BODY_PREFIX = storageRegistry.signedChequeBodyPrefix.key
const LEGACY_KEY = storageRegistry.signedChequeArchive.key
const MINER_KEY = storageRegistry.pendingMinerOutbox.key

function signedTx(satoshis: number, payloadBytes = 0): Transaction {
  const tx = new Transaction()
  tx.addOutput({
    satoshis,
    lockingScript: LockingScript.fromHex(payloadBytes ? `6a${'ab'.repeat(payloadBytes)}` : '51'),
  })
  return tx
}

function atomicBeefFor(tx: Transaction): number[] {
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return beef.toBinaryAtomic(tx.id('hex'))
}

/** Per-value cap, the way a store refuses an oversized write. */
let storeByteCap = Number.POSITIVE_INFINITY
let shell = true
/** Keys whose writes the store refuses. */
const refuseKeys = new Set<string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) || null,
  durableSetItem: (key: string, value: string) => {
    if (value.length > storeByteCap) return false
    if ([...refuseKeys].some((prefix) => key.startsWith(prefix))) return false
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
  durableStoreIsShell: () => shell,
}))

function bodyKeys(): string[] {
  return [...store.keys()].filter((key) => key.startsWith(BODY_PREFIX))
}

describe('signedChequeArchive', () => {
  beforeEach(() => {
    store.clear()
    refuseKeys.clear()
    storeByteCap = Number.POSITIVE_INFINITY
    shell = true
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'identity-main', chain: 'main' })
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
    expect(bodyKeys()).toHaveLength(1)
  })

  // 0.1.671: a nine-item import sweep's Atomic BEEF (~850KB) was over the old
  // 1MB single-value cap once base64'd, so it was refused however much was evicted.
  it('stores a sweep cheque larger than the whole old archive', async () => {
    const { archiveSignedCheque, signedChequeAtomic } = await import('./signedChequeArchive')
    for (const sats of [1, 2, 3]) {
      const tx = signedTx(sats, 200_000)
      expect(archiveSignedCheque(tx.id('hex'), atomicBeefFor(tx))).toBe(true)
    }
    const sweep = signedTx(9, 850_000)
    const atomic = atomicBeefFor(sweep)
    expect(archiveSignedCheque(sweep.id('hex'), atomic, { flow: 'payment' })).toBe(true)
    expect(signedChequeAtomic(sweep.id('hex'))).toEqual(atomic)
    expect(bodyKeys()).toHaveLength(4)
  })

  it('refuses a body over the outbox ceiling with a named reason', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { archiveSignedCheque } = await import('./signedChequeArchive')
    const tx = signedTx(1, 2 * 1024 * 1024 + 1)
    expect(archiveSignedCheque(tx.id('hex'), atomicBeefFor(tx))).toBe(false)
    expect(String(error.mock.calls[0]?.[0])).toMatch(/over 2MB/)
    error.mockRestore()
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
    expect(archiveSignedCheque(txid, thin)).toBe(true)
    expect(signedChequeAtomic(txid)?.length).toBe(thick.length)
  })

  it('moves the v1 archive and inline outbox bodies into per-cheque keys on first read', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const v1 = signedTx(10)
    const inline = signedTx(20_000)
    const [v1Id, inlineId] = [v1.id('hex'), inline.id('hex')]
    const scoped = (base: string) => `${base}:wallet:main:0:identity-main`
    store.set(
      scoped(LEGACY_KEY),
      JSON.stringify([
        { txid: v1Id, atomicB64: Utils.toBase64(atomicBeefFor(v1)), createdAt: 1, flow: 'payment' },
      ]),
    )
    store.set(
      scoped(MINER_KEY),
      JSON.stringify([
        { txid: inlineId, atomic: atomicBeefFor(inline), createdAt: 2, attempts: 0, nextAttemptAt: 2, flow: 'item_transfer' },
      ]),
    )

    const { listSignedCheques } = await import('./signedChequeArchive')
    const rows = listSignedCheques()
    expect(rows.map((row) => row.txid)).toEqual([v1Id, inlineId])
    expect(rows[1]).toEqual(expect.objectContaining({ flow: 'item_transfer', atomic: atomicBeefFor(inline) }))
    expect(bodyKeys()).toHaveLength(2)
    expect(store.has(scoped(INDEX_KEY))).toBe(true)
    expect(store.has(scoped(LEGACY_KEY))).toBe(false)
    info.mockRestore()
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

  it('decodes each stored body once while lookups alternate between accounts', async () => {
    const { archiveSignedCheque, signedChequeAtomic } = await import('./signedChequeArchive')
    const a = { accountIndex: 0, identityKey: 'identity-a', chain: 'main' as const }
    const b = { accountIndex: 1, identityKey: 'identity-b', chain: 'main' as const }
    const txA = signedTx(11)
    const txB = signedTx(22)
    archiveSignedCheque(txA.id('hex'), atomicBeefFor(txA), { owner: a })
    archiveSignedCheque(txB.id('hex'), atomicBeefFor(txB), { owner: b })

    const fromBinary = vi.spyOn(Beef, 'fromBinary')
    for (let i = 0; i < 3; i++) {
      expect(signedChequeAtomic(txA.id('hex'), a)).toEqual(atomicBeefFor(txA))
      expect(signedChequeAtomic(txB.id('hex'), b)).toEqual(atomicBeefFor(txB))
      expect(signedChequeAtomic(txA.id('hex'), b)).toBeNull()
    }
    expect(fromBinary.mock.calls.length).toBeLessThanOrEqual(2)
    fromBinary.mockRestore()

    const lookedUp = signedChequeAtomic(txA.id('hex'), a)!
    lookedUp[0] = 0xff
    expect(signedChequeAtomic(txA.id('hex'), a)).toEqual(atomicBeefFor(txA))
  })

  it('evicts the oldest cheques past the origin budget, never one the outbox needs', async () => {
    shell = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { archiveSignedCheque, listSignedChequeTxids } = await import('./signedChequeArchive')
    const cheques = [1, 2, 3, 4].map((sats) => {
      const tx = signedTx(sats, 300_000)
      return { txid: tx.id('hex'), atomic: atomicBeefFor(tx) }
    })
    store.set(
      `${MINER_KEY}:wallet:main:0:identity-main`,
      JSON.stringify([{ txid: cheques[0]!.txid, bodyInArchive: true }]),
    )
    for (const cheque of cheques) {
      expect(archiveSignedCheque(cheque.txid, cheque.atomic)).toBe(true)
    }
    // 400KB of base64 each against a 1MB budget: two fit beside the protected first.
    expect(listSignedChequeTxids()).toEqual([cheques[0]!.txid, cheques[3]!.txid])
    expect(bodyKeys()).toHaveLength(2)
    warn.mockRestore()
  })

  it('refuses only when the store rejects the cheque itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { archiveSignedCheque, listSignedChequeTxids } = await import('./signedChequeArchive')
    const tx = signedTx(99)
    refuseKeys.add(BODY_PREFIX)
    expect(archiveSignedCheque(tx.id('hex'), atomicBeefFor(tx))).toBe(false)
    expect(listSignedChequeTxids()).toEqual([])
    error.mockRestore()
  })

  it('leaves no orphaned body when the index write is refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { archiveSignedCheque, listSignedChequeTxids } = await import('./signedChequeArchive')
    const first = signedTx(5)
    expect(archiveSignedCheque(first.id('hex'), atomicBeefFor(first))).toBe(true)
    const second = signedTx(6)
    refuseKeys.add(INDEX_KEY)
    expect(archiveSignedCheque(second.id('hex'), atomicBeefFor(second))).toBe(false)
    expect(bodyKeys()).toHaveLength(1)
    expect(listSignedChequeTxids()).toEqual([first.id('hex')])
    error.mockRestore()
  })
})
