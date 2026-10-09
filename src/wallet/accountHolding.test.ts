import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  UNPUBLISHED_HERE,
  decideHoldingStep,
  holdingFromRecord,
  parseHolderRecord,
  signHolderRecord,
  type AccountHolding,
  type HolderRead,
  type HolderRecord,
} from './accountHolding'

const ROOT = '1ad0895dd317163f0e83499c30bc593dbcc54cad96a5f57b065ce9f700513250'
const IDENTITY = PrivateKey.fromHex(ROOT).toPublicKey().toString()
const OTHER_ROOT = 'ba883e48fc890f89b6fee2c7f7f2ff727468c8bc525f364511ecbd5d90d619e5'
const ME = 'device-me'
const THEM = 'device-them'

function record(fields: Partial<Pick<HolderRecord, 'deviceId' | 'state' | 'seq'>> = {}): HolderRecord {
  return signHolderRecord(ROOT, { deviceId: THEM, state: 'held', seq: 1, at: 1_700_000_000_000, ...fields })
}

const read = (r: HolderRecord, etag = '"e1"'): HolderRead => ({ kind: 'record', record: r, etag })

describe('holder record', () => {
  it('round-trips signed by the account root', () => {
    const r = record({ seq: 4, state: 'released' })
    expect(r.identityKey).toBe(IDENTITY)
    expect(parseHolderRecord(JSON.parse(JSON.stringify(r)), IDENTITY)).toEqual(r)
  })

  it('refuses a record for another account, a changed field, or a foreign signer', () => {
    const r = record()
    const other = PrivateKey.fromHex(OTHER_ROOT).toPublicKey().toString()
    expect(parseHolderRecord(r, other)).toBeNull()
    expect(parseHolderRecord({ ...r, deviceId: ME }, IDENTITY)).toBeNull()
    expect(parseHolderRecord({ ...r, seq: 9 }, IDENTITY)).toBeNull()
    const forged = signHolderRecord(OTHER_ROOT, { deviceId: ME, state: 'held', seq: 2 })
    expect(parseHolderRecord({ ...forged, identityKey: IDENTITY }, IDENTITY)).toBeNull()
    expect(parseHolderRecord({ ...r, seq: 0 }, IDENTITY)).toBeNull()
    expect(parseHolderRecord(null, IDENTITY)).toBeNull()
  })

  it('maps a record onto this install', () => {
    expect(holdingFromRecord(record({ deviceId: ME, seq: 3 }), ME)).toEqual({ kind: 'here', seq: 3 })
    expect(holdingFromRecord(record({ seq: 3 }), ME)).toEqual({ kind: 'elsewhere', seq: 3, deviceId: THEM })
    expect(holdingFromRecord(record({ deviceId: ME, state: 'released', seq: 3 }), ME)).toEqual({
      kind: 'elsewhere',
      seq: 3,
      deviceId: null,
    })
  })
})

describe('decideHoldingStep', () => {
  const decide = (local: AccountHolding, r: HolderRead, takeover = false) =>
    decideHoldingStep({ local, read: r, deviceId: ME, takeover })

  it('changes nothing when the host cannot answer', () => {
    for (const r of [{ kind: 'unsupported' }, { kind: 'unreachable', reason: 'x' }] as HolderRead[]) {
      expect(decide(UNPUBLISHED_HERE, r)).toEqual({ kind: 'keep' })
      expect(decide({ kind: 'elsewhere', seq: 2, deviceId: THEM }, r, true)).toEqual({ kind: 'keep' })
    }
  })

  it('announces an account held here that no record names yet, create-only', () => {
    expect(decide(UNPUBLISHED_HERE, { kind: 'absent' })).toEqual({
      kind: 'publish',
      seq: 1,
      condition: { create: true },
    })
  })

  it('never claims a released or foreign account because its record vanished', () => {
    expect(decide({ kind: 'elsewhere', seq: 3, deviceId: null }, { kind: 'absent' })).toEqual({ kind: 'keep' })
  })

  it('gives way when another install announced the account first', () => {
    expect(decide(UNPUBLISHED_HERE, read(record({ seq: 1 })))).toEqual({
      kind: 'adopt',
      holding: { kind: 'elsewhere', seq: 1, deviceId: THEM },
    })
  })

  it('gives way to a later take-over', () => {
    expect(decide({ kind: 'here', seq: 2 }, read(record({ seq: 3 })))).toEqual({
      kind: 'adopt',
      holding: { kind: 'elsewhere', seq: 3, deviceId: THEM },
    })
  })

  it('ignores a record older than the one it acted on, and republishes its own', () => {
    expect(decide({ kind: 'here', seq: 4 }, read(record({ seq: 2 })))).toEqual({
      kind: 'publish',
      seq: 5,
      condition: { create: false, etag: '"e1"' },
    })
    expect(decide({ kind: 'elsewhere', seq: 4, deviceId: null }, read(record({ deviceId: ME, seq: 2 })))).toEqual({
      kind: 'keep',
    })
  })

  it('keeps an account its own record confirms', () => {
    expect(decide({ kind: 'here', seq: 2 }, read(record({ deviceId: ME, seq: 2 })))).toEqual({ kind: 'keep' })
    expect(decide(UNPUBLISHED_HERE, read(record({ deviceId: ME, seq: 2 })))).toEqual({
      kind: 'adopt',
      holding: { kind: 'here', seq: 2 },
    })
  })

  it('learns that an account moved here (a take written by this install)', () => {
    expect(decide({ kind: 'elsewhere', seq: 1, deviceId: THEM }, read(record({ deviceId: ME, seq: 2 })))).toEqual({
      kind: 'adopt',
      holding: { kind: 'here', seq: 2 },
    })
  })

  it('a replacing install claims every account it holds from whoever the record names', () => {
    expect(decide(UNPUBLISHED_HERE, read(record({ seq: 6 }), '"e6"'), true)).toEqual({
      kind: 'publish',
      seq: 7,
      condition: { create: false, etag: '"e6"' },
    })
    expect(decide(UNPUBLISHED_HERE, read(record({ seq: 6, state: 'released' })), true).kind).toBe('publish')
    expect(decide({ kind: 'here', seq: 6 }, read(record({ deviceId: ME, seq: 6 })), true)).toEqual({ kind: 'keep' })
  })
})
