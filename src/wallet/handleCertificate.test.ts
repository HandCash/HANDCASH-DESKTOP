import { describe, expect, it } from 'vitest'
import { verifyHandleCertificate, HANDLE_CERTIFIERS } from './handleCertificate'
import {
  TEST_CERTIFIER_PUB,
  signedHandleCertificate,
  testIdentityKey,
} from './handleCertificate.fixture'

// BRC-169 Appendix A.3, verbatim.
const A3 = {
  type: 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=',
  serialNumber: 'JMNxKTvlkhOO88EJZRgnpTKL78dC1XwxQ9REUysjy08=',
  subject: '0359c5f3bfe249f6c0ca99d0e9cc1517da51a511f3d04f18e47a5d7ae55f04008c',
  certifier: TEST_CERTIFIER_PUB,
  revocationOutpoint: '2b09f724127b5213ead87842deade00ef6cb1a834c951d1612e162f5891fb3cb.0',
  fields: { domain: 'bGt1cC5uZXQ=', handle: 'ZGVnZ2Vu' },
  signature:
    '30450221008becb25058954be7cf6f8c46d3a0411a85a9aed55ef90466651fc75374e2bdcf02205a232796a1c2dd0bd7096428a5e6fb766eee404f441a93a261986486ba3b553c',
}
const lkup = { 'lkup.net': TEST_CERTIFIER_PUB }
const deggen = { handle: 'deggen', domain: 'lkup.net', identityKey: A3.subject }

describe('verifyHandleCertificate (BRC-169 §4.1)', () => {
  it('accepts the Appendix A.3 certificate under its pinned certifier', async () => {
    const verdict = await verifyHandleCertificate(A3, deggen, lkup)
    expect(verdict.kind).toBe('verified')
  })

  it('names the first check each forgery fails', async () => {
    const reason = async (cert: unknown, binding = deggen, pins: Record<string, string> = lkup) => {
      const v = await verifyHandleCertificate(cert, binding, pins)
      return v.kind === 'refused' ? v.reason : 'verified'
    }
    expect(await reason(null)).toBe('missing')
    expect(await reason({ ...A3, _dev: true })).toBe('placeholder')
    expect(await reason({ ...A3, signature: 'dev-placeholder:ab' })).toBe('placeholder')
    expect(await reason({ ...A3, fields: { handle: 7 } })).toBe('malformed')
    expect(await reason({ ...A3, type: 'AAAA' })).toBe('wrong-type')
    expect(await reason(A3, { ...deggen, domain: 'other.example' })).toBe('unknown-domain')
    expect(await reason(A3, deggen, { 'lkup.net': testIdentityKey(9) })).toBe('wrong-certifier')
    expect(await reason(A3, { ...deggen, identityKey: testIdentityKey(5) })).toBe('subject-mismatch')
    expect(await reason(A3, { ...deggen, handle: 'deggen2' })).toBe('field-mismatch')
    expect(await reason({ ...A3, fields: { ...A3.fields, handle: 'ZGVnZ2VuMg==' } }, { ...deggen, handle: 'deggen2' })).toBe('bad-signature')
  })

  it('refuses a certificate signed by any key but the pinned one', async () => {
    const subject = testIdentityKey(3)
    const forged = await signedHandleCertificate('alice', subject)
    const verdict = await verifyHandleCertificate(forged, {
      handle: 'alice',
      domain: 'handcash.io',
      identityKey: subject,
    })
    expect(verdict).toEqual({ kind: 'refused', reason: 'wrong-certifier' })
  })

  it('pins handcash.io to a real certifier, not a well-known key', () => {
    const pin = HANDLE_CERTIFIERS['handcash.io']
    expect(pin).toMatch(/^0[23][0-9a-f]{64}$/)
    // secp256k1 G is the public key of private key 1.
    expect(pin).not.toBe('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  })
})
