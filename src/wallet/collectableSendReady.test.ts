import {
  Beef,
  LockingScript,
  MerklePath,
  Transaction,
} from '@bsv/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberBeef, resetBeefCacheForTests } from './beefCache'
import {
  inspectCollectableSendReady,
  resetCollectableSendReadyForTests,
} from './collectableSendReady'
import {
  rememberProvenLineage,
  clearRememberedProvenanceRemittances,
} from './oneSatProvenance'
import { rememberProvenVerdict, resetProvenCacheForTests } from './provenCache'

const ORD =
  '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

function provenAt(tx: Transaction, height: number): MerklePath {
  return new MerklePath(height, [
    [
      { offset: 0, hash: tx.id('hex'), txid: true },
      { offset: 1, duplicate: true },
    ],
  ])
}

function minedBeef(tx: Transaction, height: number): Beef {
  const beef = new Beef()
  const entry = beef.mergeRawTx(tx.toBinary())
  entry.bumpIndex = beef.mergeBump(provenAt(tx, height))
  return beef
}

function rawBeef(tx: Transaction): Beef {
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return beef
}

function tipTx(): Transaction {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(ORD),
  })
  return tx
}

describe('inspectCollectableSendReady', () => {
  beforeEach(() => {
    resetCollectableSendReadyForTests()
    resetProvenCacheForTests()
    resetBeefCacheForTests()
    clearRememberedProvenanceRemittances()
  })

  it('allows held tips while indexer and authenticity verification remain pending', () => {
    const tx = tipTx()
    const outpoint = `${tx.id('hex')}.0`
    expect(
      inspectCollectableSendReady({
        outpoint,
        proven: false,
        verifying: false,
      }),
    ).toEqual({ ready: true })
  })

  it('does not block sends while authenticity is still verifying', () => {
    const tx = tipTx()
    const outpoint = `${tx.id('hex')}.0`
    expect(
      inspectCollectableSendReady({
        outpoint,
        proven: false,
        verifying: true,
      }),
    ).toEqual({ ready: true })
  })

  it('allows a BRC-150 verified tip even when remittance BEEF was omitted', () => {
    const tx = tipTx()
    const outpoint = `${tx.id('hex')}.0`
    rememberProvenVerdict(outpoint, {
      tier: 'brc150',
      origin: `${tx.id('hex')}_0`,
      path: [`${tx.id('hex')}_0`],
      verifiedAt: Date.now(),
    })
    expect(
      inspectCollectableSendReady({
        outpoint,
        proven: true,
        verifying: false,
      }),
    ).toEqual({ ready: true })
  })

  it('allows a verified unconfirmed tip so Arcade can accept the chain', () => {
    const tx = tipTx()
    const outpoint = `${tx.id('hex')}.0`
    const origin = `${tx.id('hex')}_0`
    rememberProvenVerdict(outpoint, {
      tier: 'brc150',
      origin,
      path: [origin],
      verifiedAt: Date.now(),
    })
    rememberProvenLineage({
      tipOutpoint: outpoint,
      origin,
      path: [origin],
      beef: rawBeef(tx).toBinary(),
    })
    expect(
      inspectCollectableSendReady({
        outpoint,
        proven: true,
        verifying: false,
      }),
    ).toEqual({ ready: true })
  })

  it('allows a proven tip with stored remittance and a merkle bump', () => {
    const tx = tipTx()
    const outpoint = `${tx.id('hex')}.0`
    const origin = `${tx.id('hex')}_0`
    const beef = minedBeef(tx, 900_000)
    rememberProvenVerdict(outpoint, {
      tier: 'brc150',
      origin,
      path: [origin],
      verifiedAt: Date.now(),
    })
    rememberProvenLineage({
      tipOutpoint: outpoint,
      origin,
      path: [origin],
      beef: beef.toBinary(),
    })
    rememberBeef(tx.id('hex'), beef)
    expect(
      inspectCollectableSendReady({
        outpoint,
        proven: true,
        verifying: false,
      }),
    ).toEqual({ ready: true })
  })
})
