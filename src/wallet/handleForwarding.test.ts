import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { parseForwardingRecord, signForwardingRecord, verifiedForwarding } from './handleForwarding'

// BRC-169 Appendix A.8.
const VECTOR = {
  from: '@deggen@lkup.net',
  toIdentityKey: '033cef496cd596a9dab13b36335cf51383322056f118c91e71d80be69b87e5db66',
  toHandle: '@deggen@nexus.example',
  created: '2027-01-15T00:00:00Z',
  signature:
    '3045022100ca5e7b3d97bd589c6b248f789ecef175f8d673631a5a6f653be0c9693ee1b9050220528235f3a2d27334afedcd25f745b1d445cbb746a07919addbf4dd4137f4b048',
}
const VECTOR_SUBJECT = '0359c5f3bfe249f6c0ca99d0e9cc1517da51a511f3d04f18e47a5d7ae55f04008c'

describe('forwarding records', () => {
  it('verifies the BRC-169 A.8 vector against the previous subject only', () => {
    expect(verifiedForwarding(VECTOR, VECTOR_SUBJECT)).toEqual(VECTOR)
    expect(verifiedForwarding(VECTOR, VECTOR.toIdentityKey)).toBeNull()
    expect(verifiedForwarding({ ...VECTOR, toHandle: '@deggen@evil.example' }, VECTOR_SUBJECT)).toBeNull()
    expect(verifiedForwarding({ ...VECTOR, created: '2027-01-16T00:00:00Z' }, VECTOR_SUBJECT)).toBeNull()
  })

  it('signs a record its own identity key verifies', () => {
    const root = PrivateKey.fromRandom()
    const next = PrivateKey.fromRandom().toPublicKey().toString()
    const record = signForwardingRecord(root.toHex(), {
      from: '@Alice@brc-cloud.bcryderman.workers.dev',
      toIdentityKey: next,
      toHandle: '@alice2@brc-cloud.bcryderman.workers.dev',
    })
    expect(record.from).toBe('@alice@brc-cloud.bcryderman.workers.dev')
    expect(record.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(verifiedForwarding(record, root.toPublicKey().toString())).toEqual(record)
    expect(verifiedForwarding(record, next)).toBeNull()
  })

  it('refuses malformed records', () => {
    expect(parseForwardingRecord(null)).toBeNull()
    expect(parseForwardingRecord({ ...VECTOR, toHandle: VECTOR.from })).toBeNull()
    expect(parseForwardingRecord({ ...VECTOR, toHandle: '$deggen' })).toBeNull()
    expect(parseForwardingRecord({ ...VECTOR, toIdentityKey: '04ab' })).toBeNull()
    expect(parseForwardingRecord({ ...VECTOR, created: 'yesterday' })).toBeNull()
    expect(parseForwardingRecord({ ...VECTOR, signature: 'zz' })).toBeNull()
    expect(() =>
      signForwardingRecord(PrivateKey.fromRandom().toHex(), {
        from: '@a1@x.example',
        toIdentityKey: VECTOR.toIdentityKey,
        toHandle: 'not a handle',
      }),
    ).toThrow(/fully-qualified/)
  })
})
