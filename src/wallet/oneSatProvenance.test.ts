import {
  Beef,
  LockingScript,
  MerklePath,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountLocalKey,
  bindAccountLocalKeyScope,
} from './accountLocalKeys'

const durableStore = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durableStore.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durableStore.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    durableStore.delete(key)
  },
  durableForgetCached: () => {},
}))

import {
  parseProvenanceV2,
  clearRememberedProvenanceRemittances,
  deriveOneSatPathFromBeef,
  findOrdinalParentVin,
  getRememberedProvenanceRemittance,
  rebuildProvenanceV2FromBeef,
  provenanceFitsBudget,
  rememberProvenLineage,
  encodeRemittanceForPeerBox,
  rememberPeerRemittanceForHeldTips,
  rebindOneSatProvenanceForAccount,
  compactStoredRemittances,
  REMITTANCE_DURABLE_MAX_BYTES,
  REMITTANCE_MAX_BEEF_B64_CHARS,
  REMITTANCE_MAX_BEEF_BYTES,
  verifyProvenanceV2,
  extendProvenanceV2,
  type ProvenanceV2,
} from './oneSatProvenance'

describe('durable remittance retention', () => {
  it('keeps the newest complete cache entries within its byte budget', () => {
    const source = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => {
        const tip = `${i.toString(16).padStart(64, '0')}_0`
        return [
          tip,
          {
            tip,
            origin: `${'f'.repeat(64)}_0`,
            path: [tip],
            beefB64: 'A'.repeat(40_000),
            at: i,
          },
        ]
      }),
    )

    const compacted = compactStoredRemittances(source)

    expect(compacted.body.length).toBeLessThanOrEqual(
      REMITTANCE_DURABLE_MAX_BYTES,
    )
    expect(compacted.dropped).toBeGreaterThan(0)
    expect(compacted.map[`${(19).toString(16).padStart(64, '0')}_0`]).toBeDefined()
    expect(compacted.map[`${(0).toString(16).padStart(64, '0')}_0`]).toBeUndefined()
  })
})

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

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

function buildV2Fixture(args?: {
  breakParent?: boolean
  tipSats?: number
  originScript?: string
}): { provenance: ProvenanceV2; held: string } {
  const origin = new Transaction()
  origin.addOutput({
    satoshis: 1,
    lockingScript: LockingScript.fromHex(args?.originScript ?? ORD_ENVELOPE),
  })

  const unrelated = new Transaction()
  unrelated.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })

  const tip = new Transaction()
  tip.addInput({
    sourceTransaction: args?.breakParent ? unrelated : origin,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
  })
  tip.addOutput({
    satoshis: args?.tipSats ?? 1,
    lockingScript: LockingScript.fromHex('51'),
  })

  const beef = new Beef()
  const originEntry = beef.mergeRawTx(origin.toBinary())
  originEntry.bumpIndex = beef.mergeBump(provenAt(origin))
  if (args?.breakParent) {
    const unrelatedEntry = beef.mergeRawTx(unrelated.toBinary())
    unrelatedEntry.bumpIndex = beef.mergeBump(provenAt(unrelated, 900_001))
  }
  beef.mergeRawTx(tip.toBinary())

  const originOutpoint = `${origin.id('hex')}_0`
  const tipOutpoint = `${tip.id('hex')}_0`
  return {
    held: tipOutpoint.replace('_0', '.0'),
    provenance: {
      v: 2,
      origin: originOutpoint,
      tip: tipOutpoint,
      path: [tipOutpoint, originOutpoint],
      beefB64: toBase64(beef.toBinaryAtomic(tip.id('hex'))),
    },
  }
}

describe('BRC-150 remittance budget (isolated edge case)', () => {
  it('rejects oversized beefB64 instead of truncating', () => {
    const p: ProvenanceV2 = {
      v: 2,
      origin: 'aa_0',
      tip: 'bb_0',
      path: ['bb_0', 'aa_0'],
      beefB64: 'x'.repeat(REMITTANCE_MAX_BEEF_B64_CHARS + 1),
    }
    expect(provenanceFitsBudget(p)).toBe(false)
    expect(verifyProvenanceV2(p, 'bb.0').proven).toBe(false)
  })

  it('parses only v2 objects with beefB64', () => {
    expect(parseProvenanceV2({ v: 1, origin: 'a_0', tip: 'a_0', path: ['a_0'] })).toBeNull()
    expect(
      parseProvenanceV2({
        v: 2,
        origin: 'aa_0',
        tip: 'aa_0',
        path: ['aa_0'],
        beefB64: 'QQ==',
      }),
    ).toMatchObject({ v: 2, tip: 'aa_0' })
  })

  it('requires tip to match held outpoint', () => {
    const p: ProvenanceV2 = {
      v: 2,
      origin: 'aa_0',
      tip: 'bb_0',
      path: ['bb_0', 'aa_0'],
      beefB64: 'QQ==',
    }
    expect(verifyProvenanceV2(p, 'cc.0').reason).toMatch(/tip does not match/i)
  })

  it('proves a complete one-sat spend path to an ord origin', () => {
    const { provenance, held } = buildV2Fixture()
    expect(verifyProvenanceV2(provenance, held)).toEqual({ proven: true, reason: null })
  })

  it('rejects a path whose child does not spend the claimed parent', () => {
    const { provenance, held } = buildV2Fixture({ breakParent: true })
    expect(verifyProvenanceV2(provenance, held).reason).toMatch(
      /path transaction missing|does not spend parent/i,
    )
  })

  it('rejects any non-one-sat output in the claimed path', () => {
    const { provenance, held } = buildV2Fixture({ tipSats: 2 })
    expect(verifyProvenanceV2(provenance, held).reason).toMatch(/not one satoshi/i)
  })

  it('rejects an origin without a complete ord envelope', () => {
    const { provenance, held } = buildV2Fixture({ originScript: '51' })
    expect(verifyProvenanceV2(provenance, held).reason).toMatch(/no valid ord envelope/i)
  })

  it('derives every hop instead of inventing a direct tip-to-origin path', () => {
    const origin = new Transaction()
    origin.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(ORD_ENVELOPE) })
    const middle = new Transaction()
    middle.addInput({
      sourceTransaction: origin,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    middle.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const tip = new Transaction()
    tip.addInput({
      sourceTransaction: middle,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })

    const beef = new Beef()
    const originEntry = beef.mergeRawTx(origin.toBinary())
    originEntry.bumpIndex = beef.mergeBump(provenAt(origin))
    beef.mergeRawTx(middle.toBinary())
    beef.mergeRawTx(tip.toBinary())

    expect(
      deriveOneSatPathFromBeef(
        beef,
        `${tip.id('hex')}_0`,
        `${origin.id('hex')}_0`,
      ),
    ).toEqual([
      `${tip.id('hex')}_0`,
      `${middle.id('hex')}_0`,
      `${origin.id('hex')}_0`,
    ])
    expect(rebuildProvenanceV2FromBeef(beef, `${tip.id('hex')}.0`)).toMatchObject({
      v: 2,
      origin: `${origin.id('hex')}_0`,
      path: [
        `${tip.id('hex')}_0`,
        `${middle.id('hex')}_0`,
        `${origin.id('hex')}_0`,
      ],
    })
  })

  it('extends a prior remittance by one hop without a lineage walk', async () => {
    const { provenance: parentProv, held: parentHeld } = buildV2Fixture()
    const parentTxid = parentHeld.replace('.', '_').slice(0, 64)
    const parentBeef = Beef.fromBinary(
      Uint8Array.from(atob(parentProv.beefB64), (c) => c.charCodeAt(0)),
    )
    const parentTipTx = parentBeef.findTxid(parentTxid)?.tx
    expect(parentTipTx).toBeTruthy()

    const child = new Transaction()
    child.addInput({
      sourceTransaction: parentTipTx!,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    child.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })

    const childBeef = new Beef()
    childBeef.mergeBeef(parentBeef)
    childBeef.mergeRawTx(child.toBinary())

    const extended = await extendProvenanceV2({
      prior: parentProv,
      heldOutpoint: `${child.id('hex')}_0`,
      tipBeef: childBeef,
    })
    expect(extended).toMatchObject({
      v: 2,
      tip: `${child.id('hex')}_0`,
      origin: parentProv.origin,
    })
    expect(extended!.path[0]).toBe(`${child.id('hex')}_0`)
    expect(extended!.path[1]).toBe(parentProv.tip)
    expect(verifyProvenanceV2(extended!, `${child.id('hex')}.0`).proven).toBe(true)
  })

  it('maps i0 1-sat onto o0 without extra input sources', () => {
    const origin = new Transaction()
    origin.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(ORD_ENVELOPE) })
    const tip = new Transaction()
    tip.addInput({
      sourceTXID: origin.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })

    const beef = new Beef()
    beef.mergeRawTx(origin.toBinary())
    beef.mergeRawTx(tip.toBinary())
    expect(findOrdinalParentVin(beef, tip, 0)).toBe(0)
  })

  it('requires the preceding funding source when the ordinal lands on o1', () => {
    const origin = new Transaction()
    origin.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(ORD_ENVELOPE) })
    const funding = new Transaction()
    funding.addOutput({ satoshis: 5_000, lockingScript: LockingScript.fromHex('51') })
    const tip = new Transaction()
    tip.addInput({
      sourceTXID: funding.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addInput({
      sourceTXID: origin.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addOutput({ satoshis: 5_000, lockingScript: LockingScript.fromHex('51') })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })

    const withoutFunding = new Beef()
    withoutFunding.mergeRawTx(origin.toBinary())
    withoutFunding.mergeRawTx(tip.toBinary())
    expect(findOrdinalParentVin(withoutFunding, tip, 1)).toBeNull()

    const withFunding = new Beef()
    withFunding.mergeRawTx(funding.toBinary())
    withFunding.mergeRawTx(origin.toBinary())
    withFunding.mergeRawTx(tip.toBinary())
    expect(findOrdinalParentVin(withFunding, tip, 1)).toBe(1)
    expect(findOrdinalParentVin(withFunding, tip, 0)).toBeNull()
  })

  it('rejects a path that spends the ordinal input but pays a funding sat on the claimed vout', () => {
    const origin = new Transaction()
    origin.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(ORD_ENVELOPE) })
    const funding = new Transaction()
    funding.addOutput({ satoshis: 5_000, lockingScript: LockingScript.fromHex('51') })
    const tip = new Transaction()
    tip.addInput({
      sourceTXID: funding.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addInput({
      sourceTXID: origin.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    tip.addOutput({ satoshis: 5_000, lockingScript: LockingScript.fromHex('51') })

    const beef = new Beef()
    const originEntry = beef.mergeRawTx(origin.toBinary())
    originEntry.bumpIndex = beef.mergeBump(provenAt(origin))
    beef.mergeRawTx(funding.toBinary())
    beef.mergeRawTx(tip.toBinary())

    const originOutpoint = `${origin.id('hex')}_0`
    const tipOutpoint = `${tip.id('hex')}_0`
    const provenance: ProvenanceV2 = {
      v: 2,
      origin: originOutpoint,
      tip: tipOutpoint,
      path: [tipOutpoint, originOutpoint],
      beefB64: toBase64(beef.toBinary()),
    }
    expect(verifyProvenanceV2(provenance, `${tip.id('hex')}.0`).reason).toMatch(
      /does not receive the ordinal sat/i,
    )
  })

  it('proves funding-first hops when o1 is the ordinal and funding is in the BEEF', () => {
    const origin = new Transaction()
    origin.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(ORD_ENVELOPE) })
    const funding = new Transaction()
    funding.addOutput({ satoshis: 5_000, lockingScript: LockingScript.fromHex('51') })
    const tip = new Transaction()
    tip.addInput({
      sourceTXID: funding.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addInput({
      sourceTXID: origin.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    tip.addOutput({ satoshis: 5_000, lockingScript: LockingScript.fromHex('51') })
    tip.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })

    const beef = new Beef()
    const originEntry = beef.mergeRawTx(origin.toBinary())
    originEntry.bumpIndex = beef.mergeBump(provenAt(origin))
    beef.mergeRawTx(funding.toBinary())
    beef.mergeRawTx(tip.toBinary())

    const originOutpoint = `${origin.id('hex')}_0`
    const tipOutpoint = `${tip.id('hex')}_1`
    const provenance: ProvenanceV2 = {
      v: 2,
      origin: originOutpoint,
      tip: tipOutpoint,
      path: [tipOutpoint, originOutpoint],
      beefB64: toBase64(beef.toBinary()),
    }
    expect(verifyProvenanceV2(provenance, `${tip.id('hex')}.1`)).toEqual({
      proven: true,
      reason: null,
    })
    expect(rebuildProvenanceV2FromBeef(beef, tipOutpoint)).toMatchObject({
      v: 2,
      origin: originOutpoint,
      path: [tipOutpoint, originOutpoint],
    })
  })
})

describe('keeping a proven lineage for the next send', () => {
  beforeEach(() => {
    durableStore.clear()
    clearRememberedProvenanceRemittances()
  })

  function bytesOf(b64: string): number[] {
    return Array.from(atob(b64), (c) => c.charCodeAt(0))
  }

  // Walking is how a wallet learns ancestry the hard way; remittance is how it
  // tells the next holder. Dropping the walk's result on the floor is what made
  // a send of an already-proven item arrive unproven.
  it('files it under the tip so the next send attaches it instead of walking', () => {
    const { provenance, held } = buildV2Fixture()

    const kept = rememberProvenLineage({
      tipOutpoint: provenance.tip,
      origin: provenance.origin,
      path: provenance.path,
      beef: bytesOf(provenance.beefB64),
    })

    expect(kept).toBe(true)
    const found = getRememberedProvenanceRemittance(provenance.tip)
    expect(found).not.toBeNull()
    expect(verifyProvenanceV2(found, held).proven).toBe(true)
  })

  it('finds it whichever way the caller spells the outpoint', () => {
    const { provenance, held } = buildV2Fixture()
    rememberProvenLineage({
      tipOutpoint: held,
      origin: provenance.origin,
      path: provenance.path,
      beef: bytesOf(provenance.beefB64),
    })

    expect(getRememberedProvenanceRemittance(provenance.tip)).not.toBeNull()
  })

  it('declines a walk that kept no bytes', () => {
    expect(
      rememberProvenLineage({
        tipOutpoint: 'aa_0',
        origin: 'aa_0',
        path: ['aa_0'],
        beef: [],
      }),
    ).toBe(false)
  })

  // Storing one would only produce a remittance that every send has to reject.
  it('declines a lineage too large to travel', () => {
    const { provenance } = buildV2Fixture()

    expect(
      rememberProvenLineage({
        tipOutpoint: provenance.tip,
        origin: provenance.origin,
        path: provenance.path,
        beef: new Array(REMITTANCE_MAX_BEEF_BYTES + 1).fill(0),
      }),
    ).toBe(false)
    expect(getRememberedProvenanceRemittance(provenance.tip)).toBeNull()
  })

  it('reloads a kept remittance from durable storage after a cold start', async () => {
    const { provenance, held } = buildV2Fixture()
    rememberProvenLineage({
      tipOutpoint: provenance.tip,
      origin: provenance.origin,
      path: provenance.path,
      beef: bytesOf(provenance.beefB64),
    })

    vi.resetModules()
    const fresh = await import('./oneSatProvenance')
    const found = fresh.getRememberedProvenanceRemittance(provenance.tip)
    expect(found).not.toBeNull()
    expect(fresh.verifyProvenanceV2(found, held).proven).toBe(true)
    fresh.clearRememberedProvenanceRemittances()
  })

  it('rebinds remittance memory without deleting the prior account', () => {
    const { provenance } = buildV2Fixture()
    rememberProvenLineage({
      tipOutpoint: provenance.tip,
      origin: provenance.origin,
      path: provenance.path,
      beef: bytesOf(provenance.beefB64),
    })
    const primaryKey = accountLocalKey('handcash.brc150.remittance.v1')

    bindAccountLocalKeyScope({
      accountIndex: 1,
      identityKey: 'vitest-secondary-identity',
      chain: 'main',
    })
    rebindOneSatProvenanceForAccount()

    expect(getRememberedProvenanceRemittance(provenance.tip)).toBeNull()
    expect(durableStore.has(primaryKey)).toBe(true)
    expect(
      durableStore.has(accountLocalKey('handcash.brc150.remittance.v1')),
    ).toBe(false)
  })
})

describe('peer-box remittance', () => {
  beforeEach(() => {
    durableStore.clear()
    clearRememberedProvenanceRemittances()
  })

  it('files a parent remittance under the held tip the hop created', () => {
    const { provenance } = buildV2Fixture()
    const held = `${'ab'.repeat(32)}_0`
    rememberPeerRemittanceForHeldTips([held], provenance)
    expect(getRememberedProvenanceRemittance(held)?.origin).toBe(provenance.origin)
    expect(getRememberedProvenanceRemittance(provenance.tip)?.tip).toBe(provenance.tip)
  })

  it('refuses a remittance that cannot fit the peer-box budget even lean', () => {
    const p: ProvenanceV2 = {
      v: 2,
      origin: `${'aa'.repeat(32)}_0`,
      tip: `${'bb'.repeat(32)}_0`,
      path: [`${'bb'.repeat(32)}_0`, `${'aa'.repeat(32)}_0`],
      beefB64: 'x'.repeat(500),
    }
    expect(encodeRemittanceForPeerBox(p, 8)).toBeNull()
    const { provenance } = buildV2Fixture()
    expect(encodeRemittanceForPeerBox(provenance, provenance.beefB64.length)?.v).toBe(2)
  })
})

describe('hydrating lean remittance path bodies', () => {
  it('overlaps the fetches it already knows about and merges them in path order', async () => {
    const { hydrateMissingPathTxs } = await import('./oneSatProvenance')

    // Three independent bodies the receiver has to pull for itself.
    const bodies = [0, 1, 2].map((i) => {
      const tx = new Transaction()
      tx.addOutput({ satoshis: 1 + i, lockingScript: LockingScript.fromHex('51') })
      return tx
    })
    const path = bodies.map((tx) => `${tx.id('hex')}_0`)

    const lean = new Beef()
    for (const tx of bodies) lean.mergeTxidOnly(tx.id('hex'))

    let inFlight = 0
    let peakInFlight = 0
    const getBeef = vi.fn(async (txid: string) => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inFlight -= 1
      const tx = bodies.find((b) => b.id('hex') === txid)
      const piece = new Beef()
      if (tx) piece.mergeRawTx(tx.toBinary())
      return piece
    })

    const started = Date.now()
    const { beef, fetched } = await hydrateMissingPathTxs(lean, path, getBeef)
    const elapsed = Date.now() - started

    expect(getBeef).toHaveBeenCalledTimes(3)
    // The whole missing set is known up front, so the round trips must overlap.
    expect(peakInFlight).toBe(3)
    expect(elapsed).toBeLessThan(90)
    expect(fetched).toEqual(bodies.map((tx) => tx.id('hex')))
    for (const tx of bodies) {
      expect(beef.findTxid(tx.id('hex'))?.isTxidOnly).toBeFalsy()
    }
  })

  it('keeps a failed body missing so verification still fails closed', async () => {
    const { hydrateMissingPathTxs } = await import('./oneSatProvenance')

    const ok = new Transaction()
    ok.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex('51') })
    const gone = new Transaction()
    gone.addOutput({ satoshis: 2, lockingScript: LockingScript.fromHex('51') })
    const path = [`${ok.id('hex')}_0`, `${gone.id('hex')}_0`]

    const lean = new Beef()
    lean.mergeTxidOnly(ok.id('hex'))
    lean.mergeTxidOnly(gone.id('hex'))

    const { beef, fetched } = await hydrateMissingPathTxs(lean, path, async (txid) => {
      if (txid === gone.id('hex')) throw new Error('indexer 404')
      const piece = new Beef()
      piece.mergeRawTx(ok.toBinary())
      return piece
    })

    expect(fetched).toEqual([ok.id('hex')])
    expect(beef.findTxid(ok.id('hex'))?.isTxidOnly).toBeFalsy()
    expect(beef.findTxid(gone.id('hex'))?.isTxidOnly).toBe(true)
  })
})
