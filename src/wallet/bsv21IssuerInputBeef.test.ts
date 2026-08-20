/**
 * A mint spends the auth tip of a genesis that was deployed seconds ago, so its
 * ancestry is unmined and no merkle proof for it exists anywhere. Hydration
 * cannot know that without asking, one indexer timeout per ancestor, and a
 * BSV-21 mint studio run lost a whole createAction to it: the bridge deadline
 * passed and the studio reported the mint as stopped while the wallet was still
 * building it.
 *
 * Enrichment must therefore sign against the raw BEEF the caller already
 * supplied rather than wait out the indexer.
 */

import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hydrateInputBeef = vi.fn()
const buildMergedInputBeef = vi.fn()
const rememberBeefBinary = vi.fn()

vi.mock('./beefCache', () => ({
  hydrateInputBeef: (...args: unknown[]) => hydrateInputBeef(...args),
  buildMergedInputBeef: (...args: unknown[]) => buildMergedInputBeef(...args),
  rememberBeefBinary: (...args: unknown[]) => rememberBeefBinary(...args),
}))

vi.mock('./oneSatImport', () => ({
  fetchRawTxHex: vi.fn(async () => undefined),
}))

const root = PrivateKey.fromRandom()
const address = root.toPublicKey().toAddress()

/** An unmined tip: raw body present, no proof — nothing can make it verify. */
function unminedTipBeef(): { binary: number[]; outpoint: string } {
  const tip = new Transaction()
  tip.addInput({
    sourceTXID: 'ab'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(address),
  })
  tip.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(address) })
  const beef = new Beef()
  beef.mergeTransaction(tip)
  beef.atomicTxid = undefined
  return { binary: beef.toBinary(), outpoint: `${tip.id('hex')}.0` }
}

function mintArgs(outpoint: string, inputBEEF: number[]) {
  return {
    description: 'Mint TEST',
    inputs: [{ outpoint, inputDescription: 'auth tip', unlockingScriptLength: 108 }],
    inputBEEF,
    outputs: [
      {
        lockingScript: new P2PKH().lock(address).toHex(),
        satoshis: 1,
        basket: 'bsv21',
        tags: ['bsv21', 'op:mint'],
        customInstructions: JSON.stringify({ p: 'bsv-20', op: 'mint', amt: '1000' }),
      },
    ],
  }
}

const active = {
  identityKey: root.toPublicKey().toString().toLowerCase(),
  rootKeyHex: root.toHex(),
  chain: 'main',
  wallet: { listOutputs: vi.fn(async () => ({ outputs: [] })) },
} as never

describe('BSV-21 mint inputBEEF', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('signs against the caller BEEF when the tip ancestry cannot be proven yet', async () => {
    const { enrichCreateActionForBsv21Issuer } = await import('./bsv21Issuer')
    const { binary, outpoint } = unminedTipBeef()
    // An indexer with no proof to give: hydration would never come back.
    hydrateInputBeef.mockImplementation(() => new Promise(() => {}))

    vi.useFakeTimers()
    try {
      const enriched = enrichCreateActionForBsv21Issuer(
        active,
        mintArgs(outpoint, binary),
      )
      await vi.advanceTimersByTimeAsync(10_000)
      const args = await enriched

      expect(args.inputBEEF).toBeDefined()
      expect(args.inputBEEF!.length).toBeGreaterThan(0)
      // The tip body is what signing needs, and it is there.
      const merged = Beef.fromBinary(args.inputBEEF!)
      expect(merged.findTxid(outpoint.split('.')[0]!)?.tx).toBeDefined()
      // Broadcast is the monitor's job once headers land.
      expect(args.options?.acceptDelayedBroadcast).toBe(true)
      expect(args.options?.knownTxids).toContain(outpoint.split('.')[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers hydrated BEEF when proofs are actually available', async () => {
    const { enrichCreateActionForBsv21Issuer } = await import('./bsv21Issuer')
    const { binary, outpoint } = unminedTipBeef()
    const hydrated = [...binary, 0]
    hydrateInputBeef.mockResolvedValue(hydrated)

    const args = await enrichCreateActionForBsv21Issuer(
      active,
      mintArgs(outpoint, binary),
    )

    expect(args.inputBEEF).toEqual(hydrated)
    expect(rememberBeefBinary).toHaveBeenCalledWith(
      outpoint.split('.')[0],
      hydrated,
    )
  })

  it('never waits on the indexer once the caller BEEF covers every spend', async () => {
    const { enrichCreateActionForBsv21Issuer } = await import('./bsv21Issuer')
    const { binary, outpoint } = unminedTipBeef()
    hydrateInputBeef.mockResolvedValue(undefined)

    await enrichCreateActionForBsv21Issuer(active, mintArgs(outpoint, binary))

    expect(buildMergedInputBeef).not.toHaveBeenCalled()
  })
})
