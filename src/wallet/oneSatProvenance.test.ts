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
  rebuildProvenanceV2FromBeef,
  provenanceFitsBudget,
  REMITTANCE_MAX_BEEF_B64_CHARS,
  verifyProvenance,
  verifyProvenanceV2,
  type ProvenanceV2,
} from './oneSatProvenance'
import { buildProvenanceV3 } from './oneSatLatch'

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

  it('verifyProvenance does not treat bare v3 soft-latch as authenticity', () => {
    const origin = 'aa'.repeat(32) + '_0'
    const tip = 'bb'.repeat(32) + '_1'
    const v3 = buildProvenanceV3({
      origin,
      tip,
      latch: 'cc'.repeat(32) + '_0',
      parentLatch: 'dd'.repeat(32) + '_0',
    })
    const r = verifyProvenance(v3, 'bb'.repeat(32) + '.1')
    expect(r.proven).toBe(false)
    expect(r.reason).toMatch(/not authenticity|v2|hardened/i)
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
})
