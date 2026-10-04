import { Beef, MerklePath, P2PKH, PrivateKey, Transaction, type ChainTracker } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSpvPackageForTests, spvVerifiedHere, verifySignedPackage } from './spvPackage'

const key = PrivateKey.fromRandom()
const lock = new P2PKH().lock(key.toAddress())
const HEIGHT = 900_000

function minedFunding(sats = 10_000): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: lock,
  })
  tx.addOutput({ lockingScript: lock, satoshis: sats })
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), HEIGHT)
  return tx
}

async function spend(parent: Transaction, sats: number): Promise<Transaction> {
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  })
  tx.addOutput({ lockingScript: lock, satoshis: sats })
  await tx.sign()
  return tx
}

function atomicOf(tx: Transaction): number[] {
  return Array.from(Beef.fromBinary(tx.toBEEF()).toBinaryAtomic(tx.id('hex')))
}

function trackerFor(parents: Transaction[]): ChainTracker & { roots: string[] } {
  const known = new Set(parents.map((p) => p.merklePath!.computeRoot(p.id('hex'))))
  const roots: string[] = []
  return {
    roots,
    isValidRootForHeight: vi.fn(async (root: string, height: number) => {
      roots.push(`${height}:${root}`)
      if (height !== HEIGHT) throw new Error(`no chain tracker could confirm the merkle root at height ${height}`)
      return known.has(root)
    }),
    currentHeight: async () => HEIGHT + 200,
  }
}

describe('verifySignedPackage', () => {
  afterEach(() => resetSpvPackageForTests())

  it('verifies a signed chain back to a proven parent', async () => {
    const funding = minedFunding()
    const first = await spend(funding, 9_000)
    const second = await spend(first, 8_000)
    const verdict = await verifySignedPackage(atomicOf(second), second.id('hex'), trackerFor([funding]))
    expect(verdict).toEqual({ kind: 'verified' })
    expect(spvVerifiedHere(first.id('hex'))).toBe(true)
  })

  it('calls a bad signature invalid', async () => {
    const funding = minedFunding()
    const signed = await spend(funding, 9_000)
    const forged = Transaction.fromBinary(signed.toBinary())
    forged.inputs[0]!.sourceTransaction = funding
    forged.outputs[0]!.satoshis = 9_500
    const verdict = await verifySignedPackage(atomicOf(forged), forged.id('hex'), trackerFor([funding]))
    expect(verdict.kind).toBe('invalid')
  })

  it('calls spending more than the inputs hold invalid', async () => {
    const funding = minedFunding(1_000)
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })
    tx.addOutput({ lockingScript: lock, satoshis: 5_000 })
    await tx.sign()
    const verdict = await verifySignedPackage(atomicOf(tx), tx.id('hex'), trackerFor([funding]))
    expect(verdict.kind).toBe('invalid')
  })

  it('holds a package whose header no source can serve', async () => {
    const funding = minedFunding()
    const signed = await spend(funding, 9_000)
    const tracker: ChainTracker = {
      isValidRootForHeight: async () => {
        throw new Error('no chain tracker could confirm the merkle root at height 900000')
      },
      currentHeight: async () => HEIGHT + 200,
    }
    const verdict = await verifySignedPackage(atomicOf(signed), signed.id('hex'), tracker)
    expect(verdict.kind).toBe('incomplete')
  })

  it('holds a package whose proof the chain disagrees with', async () => {
    const funding = minedFunding()
    const signed = await spend(funding, 9_000)
    const verdict = await verifySignedPackage(atomicOf(signed), signed.id('hex'), trackerFor([]))
    expect(verdict.kind).toBe('incomplete')
  })

  it('holds a package missing a parent body', async () => {
    const funding = minedFunding()
    const unmined = await spend(funding, 9_000)
    const child = await spend(unmined, 8_000)
    const beef = new Beef()
    beef.mergeTxidOnly(unmined.id('hex'))
    beef.mergeRawTx(child.toBinary())
    const verdict = await verifySignedPackage(
      Array.from(beef.toBinaryAtomic(child.id('hex'))),
      child.id('hex'),
      trackerFor([funding]),
    )
    expect(verdict.kind).toBe('incomplete')
  })

  it('does not re-walk a parent it already verified', async () => {
    const funding = minedFunding()
    const first = await spend(funding, 9_000)
    await verifySignedPackage(atomicOf(first), first.id('hex'), trackerFor([funding]))
    const second = await spend(first, 8_000)
    const tracker = trackerFor([funding])
    await expect(
      verifySignedPackage(atomicOf(second), second.id('hex'), tracker),
    ).resolves.toEqual({ kind: 'verified' })
    expect(tracker.roots).toEqual([])
  })

  it('verifies the same package again for a second account on this device', async () => {
    const funding = minedFunding()
    const token = await spend(funding, 9_000)
    const change = await spend(minedFunding(5_000), 4_900)
    const tx = new Transaction()
    for (const parent of [token, change]) {
      tx.addInput({
        sourceTransaction: parent,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(key),
      })
    }
    tx.addOutput({ lockingScript: lock, satoshis: 13_000 })
    await tx.sign()
    const atomic = atomicOf(tx)
    const tracker = (): ChainTracker => ({
      isValidRootForHeight: async () => true,
      currentHeight: async () => HEIGHT + 200,
    })
    await expect(verifySignedPackage(atomic, tx.id('hex'), tracker())).resolves.toEqual({ kind: 'verified' })
    await expect(verifySignedPackage(atomic, tx.id('hex'), tracker())).resolves.toEqual({ kind: 'verified' })
  })
})
