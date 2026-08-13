import {
  Beef,
  LockingScript,
  MerklePath,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  describeGenesisWalk,
  proveGenesisLineage,
  walkGenesisLineage,
} from './oneSatGenesisProof'

const ORD_ENVELOPE =
  '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'

function provenAt(tx: Transaction, height = 900_000): MerklePath {
  return new MerklePath(height, [
    [
      { offset: 0, hash: tx.id('hex'), txid: true },
      { offset: 1, duplicate: true },
    ],
  ])
}

/** One mined transaction, carrying its own merkle proof, as a service would return it. */
function beefFor(tx: Transaction, height = 900_000): Beef {
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

/**
 * A transfer: spends the sat and pays it on.
 *
 * When `funding` is first, change is o0 and the ordinal is o1 — FIFO would
 * otherwise assign a funding sat to a 1-sat o0.
 */
function transfer(parent: Transaction, parentVout = 0, funding?: Transaction): Transaction {
  const tx = new Transaction()
  if (funding) {
    tx.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
  }
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: parentVout,
    unlockingScript: new UnlockingScript(),
  })
  if (funding) {
    tx.addOutput({
      satoshis: funding.outputs[0]!.satoshis,
      lockingScript: LockingScript.fromHex('51'),
    })
  }
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
  return tx
}

function fundingTx(): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 5_000, lockingScript: LockingScript.fromHex('51') })
  return tx
}

/**
 * Service stand-in: answers per txid, and counts what the walk actually costs.
 *
 * Each transaction is mined in its own block — two merkle proofs claiming the
 * same position in one block do not merge into a valid BEEF.
 */
function service(txs: Transaction[]) {
  const byId = new Map(
    txs.map((tx, i) => [tx.id('hex'), { tx, height: 900_000 + i }] as const),
  )
  const getBeef = vi.fn(async (txid: string) => {
    const hit = byId.get(txid)
    if (!hit) throw new Error(`no such transaction ${txid}`)
    return beefFor(hit.tx, hit.height)
  })
  return getBeef
}

describe('proveGenesisLineage', () => {
  it('walks an imported tip back to the inscription that created it', async () => {
    const origin = inscription()
    const hop1 = transfer(origin)
    const hop2 = transfer(hop1)
    const tip = transfer(hop2)
    const getBeef = service([origin, hop1, hop2, tip])

    const proof = await proveGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef,
    })

    expect(proof?.origin).toBe(`${origin.id('hex')}_0`)
    expect(proof?.path).toEqual([
      `${tip.id('hex')}_0`,
      `${hop2.id('hex')}_0`,
      `${hop1.id('hex')}_0`,
      `${origin.id('hex')}_0`,
    ])
    // One fetch per hop is the whole cost of earning the badge.
    expect(getBeef).toHaveBeenCalledTimes(4)
  })

  it('ignores funding inputs when picking the parent', async () => {
    const origin = inscription()
    const funding = fundingTx()
    const tip = transfer(origin, 0, funding)
    const getBeef = service([origin, tip, funding])

    const proof = await proveGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.1`,
      getBeef,
    })

    expect(proof?.origin).toBe(`${origin.id('hex')}_0`)
    expect(proof?.path).toEqual([`${tip.id('hex')}_1`, `${origin.id('hex')}_0`])
  })

  it('refuses a 1-sat vout that spends the ordinal input but does not receive that sat', async () => {
    const origin = inscription()
    const funding = fundingTx()
    const tip = new Transaction()
    tip.addInput({
      sourceTransaction: funding,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addInput({
      sourceTransaction: origin,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    tip.addOutput({
      satoshis: funding.outputs[0]!.satoshis,
      lockingScript: LockingScript.fromHex('51'),
    })
    const getBeef = service([origin, tip, funding])

    expect(
      await proveGenesisLineage({ tipOutpoint: `${tip.id('hex')}.0`, getBeef }),
    ).toBeNull()
  })

  it('proves a tip that is itself the inscription', async () => {
    const origin = inscription()
    const getBeef = service([origin])

    const proof = await proveGenesisLineage({
      tipOutpoint: `${origin.id('hex')}.0`,
      getBeef,
    })

    expect(proof?.origin).toBe(`${origin.id('hex')}_0`)
    expect(proof?.hops).toBe(0)
  })

  it('refuses a lineage whose ancestry cannot be fetched', async () => {
    const origin = inscription()
    const hop1 = transfer(origin)
    const tip = transfer(hop1)
    // The middle hop is unavailable — a partial chain must not pass as a proof.
    const getBeef = service([origin, tip])

    expect(
      await proveGenesisLineage({ tipOutpoint: `${tip.id('hex')}.0`, getBeef }),
    ).toBeNull()
  })

  it('refuses a chain that never reaches an inscription', async () => {
    const notAnOrdinal = new Transaction()
    notAnOrdinal.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const tip = transfer(notAnOrdinal)
    const getBeef = service([notAnOrdinal, tip])

    expect(
      await proveGenesisLineage({ tipOutpoint: `${tip.id('hex')}.0`, getBeef }),
    ).toBeNull()
  })

  it('gives up rather than walking forever', async () => {
    const origin = inscription()
    let current = transfer(origin)
    const chain: Transaction[] = [origin, current]
    for (let i = 0; i < 6; i++) {
      current = transfer(current)
      chain.push(current)
    }
    const getBeef = service(chain)

    const proof = await proveGenesisLineage({
      tipOutpoint: `${current.id('hex')}.0`,
      getBeef,
      maxHops: 3,
    })

    expect(proof).toBeNull()
    // The cap is what it claims: no fetch storm after giving up.
    expect(getBeef.mock.calls.length).toBeLessThanOrEqual(5)
  })
})

describe('walkGenesisLineage outcomes', () => {
  it('reports an unreachable hop as retryable, not as a verdict on the item', async () => {
    const origin = inscription()
    const hop1 = transfer(origin)
    const tip = transfer(hop1)
    const getBeef = service([origin, tip])

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef,
    })

    expect(outcome.kind).toBe('unavailable')
    expect(describeGenesisWalk(outcome)).toContain('no such transaction')
  })

  it('reports a chain that never reaches an inscription as invalid', async () => {
    const notAnOrdinal = new Transaction()
    notAnOrdinal.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex('51'),
    })
    const tip = transfer(notAnOrdinal)
    const getBeef = service([notAnOrdinal, tip])

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef,
      maxHops: 2,
    })

    expect(outcome.kind).toBe('invalid')
  })

  it('reports a hop cap as invalid rather than as a network miss', async () => {
    const origin = inscription()
    let current = transfer(origin)
    const chain: Transaction[] = [origin, current]
    for (let i = 0; i < 6; i++) {
      current = transfer(current)
      chain.push(current)
    }

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${current.id('hex')}.0`,
      getBeef: service(chain),
      maxHops: 3,
    })

    expect(outcome).toMatchObject({ kind: 'invalid' })
    expect(describeGenesisWalk(outcome)).toContain(
      'no inscription within 3 hops',
    )
  })

  it('reports yielding to the user as aborted, so nothing is recorded against the tip', async () => {
    const origin = inscription()
    const tip = transfer(origin)

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef: service([origin, tip]),
      shouldStop: () => true,
    })

    expect(outcome.kind).toBe('aborted')
  })

  it('carries the proof through on success', async () => {
    const origin = inscription()
    const tip = transfer(origin)

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef: service([origin, tip]),
    })

    expect(outcome.kind).toBe('proven')
    if (outcome.kind !== 'proven') throw new Error('expected a proof')
    expect(outcome.proof.origin).toBe(`${origin.id('hex')}_0`)
  })
})

describe('serializing the assembled lineage', () => {
  // Serializing a Pixel Foxes origin — one transaction carrying hundreds of
  // inscriptions — is seconds of blocked main thread on a phone. A background
  // verify pins a verdict and throws the BEEF away, so it must not pay for it.
  it('does not serialize the BEEF for a verify that only wants the verdict', async () => {
    const origin = inscription()
    const tip = transfer(origin)

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef: service([origin, tip]),
    })

    if (outcome.kind !== 'proven') throw new Error('expected a proof')
    expect(outcome.proof.beef).toEqual([])
  })

  it('serializes it for a sender putting the lineage on the wire', async () => {
    const origin = inscription()
    const tip = transfer(origin)

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef: service([origin, tip]),
      includeBeef: true,
    })

    if (outcome.kind !== 'proven') throw new Error('expected a proof')
    expect(outcome.proof.beef.length).toBeGreaterThan(0)
  })

  // A verify that keeps a sendable lineage saves the receiver the same walk.
  it('keeps the bytes for a verify when the lineage is small enough to travel', async () => {
    const origin = inscription()
    const tip = transfer(origin)

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef: service([origin, tip]),
      serializeIfUnder: 1_000_000,
    })

    if (outcome.kind !== 'proven') throw new Error('expected a proof')
    expect(outcome.proof.beef.length).toBeGreaterThan(0)
  })

  // Past the wire budget the bytes could never be attached to a send, so paying
  // to produce them buys nothing and costs the thread. The verdict still stands.
  it('proves without the bytes when the lineage is too big to travel', async () => {
    const origin = inscription()
    const tip = transfer(origin)

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef: service([origin, tip]),
      serializeIfUnder: 1,
    })

    expect(outcome.kind).toBe('proven')
    if (outcome.kind !== 'proven') throw new Error('expected a proof')
    expect(outcome.proof.beef).toEqual([])
  })

  it('still measures the wire budget, which implies serializing', async () => {
    const origin = inscription()
    const tip = transfer(origin)

    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef: service([origin, tip]),
      maxBeefBytes: 1,
    })

    expect(outcome.kind).toBe('overBudget')
  })

  it('abandons before the verification tail, the most expensive stretch', async () => {
    const origin = inscription()
    const tip = transfer(origin)
    const getBeef = service([origin, tip])
    // Let every hop through, then claim the thread. Without a check after the
    // walk reaches the origin this would run verification to completion — the
    // stretch that froze the phone for 33s.
    const outcome = await walkGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef,
      shouldStop: () => getBeef.mock.calls.length >= 2,
    })

    expect(outcome.kind).toBe('aborted')
  })
})
