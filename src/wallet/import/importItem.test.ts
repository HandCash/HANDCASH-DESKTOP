import { describe, expect, it } from 'vitest'
import { compareImportGroups, importItemFacts, importItemGroup } from './importItem'

const op = (c: string) => `${c.repeat(64)}_0`
const SIGNER = '1BHLmsoMt4J4oyKbpPu2PoBDiP8C5h2sQx'

const row = (outpoint: string, origin: string, sigma: unknown, own?: unknown) => ({
  outpoint,
  origin: { outpoint: origin, data: { map: { app: 'zoo', name: 'Fox #2' }, insc: { file: { type: 'image/png' } }, sigma } },
  data: own === undefined ? null : { sigma: own },
})

describe('importItemFacts signer', () => {
  it('takes the first BSM signer the index did not mark invalid', () => {
    const sigma = [
      { algorithm: 'BSM', address: '1Bad1111111111111111111111111', valid: false },
      { algorithm: 'ECDSA', address: SIGNER },
      { algorithm: 'BSM', address: SIGNER, valid: true },
    ]
    expect(importItemFacts(row(op('b'), op('a'), sigma), op('b')).signer).toBe(SIGNER)
    expect(importItemFacts(row(op('b'), op('a'), [{ address: 'not-an-address' }]), op('b')).signer).toBeNull()
  })

  it('never reads a transfer’s own signature as the creator’s', () => {
    expect(importItemFacts(row(op('b'), op('a'), undefined, [{ address: SIGNER }]), op('b')).signer).toBeNull()
    expect(importItemFacts(row(op('a'), op('a'), undefined, [{ address: SIGNER }]), op('a')).signer).toBe(SIGNER)
  })
})

describe('importItemGroup', () => {
  it('shelves by signer, then app, then collection, else none', () => {
    const base = { signer: null, app: null, collectionId: null, name: 'Fox #2' }
    expect(importItemGroup({ ...base, signer: SIGNER, app: 'Zoo' })).toMatchObject({ key: `signer:${SIGNER}`, label: 'Zoo' })
    expect(importItemGroup({ ...base, signer: SIGNER })).toMatchObject({ kind: 'signer', label: 'Signed items' })
    expect(importItemGroup({ ...base, app: 'Zoo', collectionId: 'c' })).toMatchObject({ key: 'app:zoo', label: 'Zoo' })
    expect(importItemGroup({ ...base, collectionId: 'C9' })).toMatchObject({ key: 'collection:c9', label: 'Fox' })
    expect(importItemGroup(base)).toMatchObject({ key: 'none', label: 'No issuer' })
  })

  it('orders shelves signer, app, collection, none, then by label', () => {
    const groups = [
      importItemGroup({ signer: null, app: null, collectionId: null, name: null }),
      importItemGroup({ signer: null, app: 'beta', collectionId: null, name: null }),
      importItemGroup({ signer: SIGNER, app: 'zeta', collectionId: null, name: null }),
      importItemGroup({ signer: null, app: 'Alpha', collectionId: null, name: null }),
      importItemGroup({ signer: null, app: null, collectionId: 'c', name: 'Fox #1' }),
    ]
    expect(groups.sort(compareImportGroups).map((g) => g.label)).toEqual(['zeta', 'Alpha', 'beta', 'Fox', 'No issuer'])
  })
})
