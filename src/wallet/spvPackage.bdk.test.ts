import {
  Beef,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  Transaction,
  registerScriptVerificationBackend,
  type ChainTracker,
} from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resetSpvPackageForTests, verifySignedPackage } from './spvPackage'

const key = PrivateKey.fromRandom()
const p2pkh = new P2PKH().lock(key.toAddress())
const HEIGHT = 900_000

function push(data: Uint8Array): string {
  const n = data.length
  const hex = Buffer.from(data).toString('hex')
  if (n <= 75) return n.toString(16).padStart(2, '0') + hex
  if (n <= 255) return `4c${n.toString(16).padStart(2, '0')}${hex}`
  return `4d${(n & 0xff).toString(16).padStart(2, '0')}${((n >> 8) & 0xff).toString(16).padStart(2, '0')}${hex}`
}

const text = (s: string) => push(new TextEncoder().encode(s))

/** What Mint Studio inscribes: ord envelope ‖ P2PKH ‖ OP_RETURN MAP. */
function mintedItemLock(bodyBytes: number): LockingScript {
  const envelope = `0063${text('ord')}51${text('image/png')}00${push(new Uint8Array(bodyBytes).fill(7))}68`
  const map = `6a${text('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5')}${text('SET')}${text('app')}${text('studio')}`
  return LockingScript.fromHex(envelope + p2pkh.toHex() + map)
}

function atomicOf(tx: Transaction): number[] {
  return Array.from(Beef.fromBinary(tx.toBEEF()).toBinaryAtomic(tx.id('hex')))
}

function trackerFor(mined: Transaction): ChainTracker {
  const root = mined.merklePath!.computeRoot(mined.id('hex'))
  return {
    isValidRootForHeight: async (r, height) => height === HEIGHT && r === root,
    currentHeight: async () => HEIGHT + 500,
  }
}

describe('verifySignedPackage on the BDK script engine', () => {
  beforeAll(async () => {
    const verifier = new BdkVerifier({ network: 'main' })
    await verifier.preload()
    registerScriptVerificationBackend(verifier)
  })
  afterEach(() => resetSpvPackageForTests())

  it.each([200, 20_000])(
    'lists a mint already verified here (%i-byte inscription with a MAP suffix)',
    async (bodyBytes) => {
      const funding = new Transaction()
      funding.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: p2pkh })
      funding.addOutput({ lockingScript: p2pkh, satoshis: 50_000 })
      funding.merklePath = MerklePath.fromCoinbaseTxidAndHeight(funding.id('hex'), HEIGHT)
      const tracker = trackerFor(funding)

      const lock = mintedItemLock(bodyBytes)
      const mint = new Transaction()
      mint.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
      mint.addOutput({ lockingScript: lock, satoshis: 1 })
      mint.addOutput({ lockingScript: p2pkh, satoshis: 40_000 })
      await mint.sign()
      // Broadcasting the mint verifies it here; the listing package then
      // carries the mint behind its stand-in proof.
      expect(await verifySignedPackage(atomicOf(mint), mint.id('hex'), tracker)).toEqual({ kind: 'verified' })

      const listing = new Transaction()
      listing.addInput({
        sourceTransaction: mint,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(key, 'all', false, 1, lock),
      })
      listing.addInput({ sourceTransaction: mint, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(key) })
      listing.addOutput({ lockingScript: p2pkh, satoshis: 1 })
      listing.addOutput({ lockingScript: p2pkh, satoshis: 30_000 })
      await listing.sign()

      expect(await verifySignedPackage(atomicOf(listing), listing.id('hex'), tracker)).toEqual({
        kind: 'verified',
      })
    },
  )
})
