import {
  Beef,
  LockingScript,
  MerklePath,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBeefCacheForTests } from './beefCache'
import { tryBuildProvenanceV2, verifyProvenanceV2 } from './oneSatProvenance'
import type { ActiveWallet } from './session'

const ORD_ENVELOPE =
  '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

function provenAt(tx: Transaction, height: number): MerklePath {
  return new MerklePath(height, [
    [
      { offset: 0, hash: tx.id('hex'), txid: true },
      { offset: 1, duplicate: true },
    ],
  ])
}

/**
 * What a service returns for a mined transaction: the transaction and its own
 * merkle proof, and nothing about where the satoshi came from.
 */
function minedBeef(tx: Transaction, height: number): Beef {
  const beef = new Beef()
  const entry = beef.mergeRawTx(tx.toBinary())
  entry.bumpIndex = beef.mergeBump(provenAt(tx, height))
  return beef
}

function inscription(): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(ORD_ENVELOPE) })
  return tx
}

function transfer(parent: Transaction): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
  })
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
  return tx
}

function walletServing(txs: Transaction[]) {
  const byId = new Map(
    txs.map((tx, i) => [tx.id('hex'), { tx, height: 900_000 + i }] as const),
  )
  const getBeefForTxid = vi.fn(async (txid: string) => {
    const hit = byId.get(txid.toLowerCase())
    if (!hit) throw new Error(`no such transaction ${txid}`)
    return minedBeef(hit.tx, hit.height)
  })
  return {
    wallet: { chain: 'main', services: { getBeefForTxid } } as unknown as ActiveWallet,
    getBeefForTxid,
  }
}

describe('tryBuildProvenanceV2', () => {
  beforeEach(() => {
    resetBeefCacheForTests()
  })

  it('hydrates the ancestry when the held BEEF stops at the tip', async () => {
    const origin = inscription()
    const hop = transfer(origin)
    const tip = transfer(hop)
    const { wallet, getBeefForTxid } = walletServing([origin, hop, tip])

    const provenance = await tryBuildProvenanceV2({
      tipOutpoint: `${tip.id('hex')}.0`,
      origin: `${origin.id('hex')}_0`,
      wallet,
      // A mined tip's BEEF depends on nothing, which is the whole trap: without
      // hydration there is no path to derive and the send goes out unprovable.
      inputBeef: minedBeef(tip, 900_002).toBinary(),
    })

    expect(provenance).not.toBeNull()
    expect(provenance!.path).toEqual([
      `${tip.id('hex')}_0`,
      `${hop.id('hex')}_0`,
      `${origin.id('hex')}_0`,
    ])
    // The receiver's own verifier must accept what we put on the wire.
    expect(
      verifyProvenanceV2(provenance, `${tip.id('hex')}.0`).proven,
    ).toBe(true)
    expect(getBeefForTxid).toHaveBeenCalled()
  })

  it('keeps a path that the held BEEF can already prove, without extra fetches', async () => {
    const origin = inscription()
    const tip = transfer(origin)
    const { wallet, getBeefForTxid } = walletServing([origin, tip])

    const full = minedBeef(origin, 900_000)
    full.mergeBeef(minedBeef(tip, 900_001).toBinary())

    const provenance = await tryBuildProvenanceV2({
      tipOutpoint: `${tip.id('hex')}.0`,
      origin: `${origin.id('hex')}_0`,
      wallet,
      inputBeef: full.toBinary(),
    })

    expect(provenance?.path).toEqual([`${tip.id('hex')}_0`, `${origin.id('hex')}_0`])
    expect(getBeefForTxid).not.toHaveBeenCalled()
  })

  it('omits provenance rather than claiming an origin the chain does not support', async () => {
    const origin = inscription()
    // A real inscription, just not this satoshi's — an extra output is enough to
    // make it a different transaction.
    const unrelated = inscription()
    unrelated.addOutput({ satoshis: 7, lockingScript: LockingScript.fromHex('51') })
    const tip = transfer(origin)
    const { wallet } = walletServing([origin, unrelated, tip])

    const provenance = await tryBuildProvenanceV2({
      tipOutpoint: `${tip.id('hex')}.0`,
      origin: `${unrelated.id('hex')}_0`,
      wallet,
      inputBeef: minedBeef(tip, 900_002).toBinary(),
    })

    expect(provenance).toBeNull()
  })
})
