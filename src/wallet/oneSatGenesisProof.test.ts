import {
  Beef,
  LockingScript,
  MerklePath,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { proveGenesisLineage } from './oneSatGenesisProof'

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

/** A transfer: spends the sat, pays it on, plus an unrelated funding input. */
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
    const tip = transfer(origin, 0, fundingTx())
    const getBeef = service([origin, tip, tip.inputs[0]!.sourceTransaction!])

    const proof = await proveGenesisLineage({
      tipOutpoint: `${tip.id('hex')}.0`,
      getBeef,
    })

    expect(proof?.origin).toBe(`${origin.id('hex')}_0`)
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
