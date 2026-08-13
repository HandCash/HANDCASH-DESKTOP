import {
  Beef,
  LockingScript,
  MerklePath,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  parseProvenanceV2,
  deriveOneSatPathFromBeef,
  findOrdinalParentVin,
  rebuildProvenanceV2FromBeef,
  provenanceFitsBudget,
  REMITTANCE_MAX_BEEF_B64_CHARS,
  verifyProvenanceV2,
  extendProvenanceV2,
  type ProvenanceV2,
} from './oneSatProvenance'

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

  it('extends a prior remittance by one hop without a lineage walk', () => {
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

    const extended = extendProvenanceV2({
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
