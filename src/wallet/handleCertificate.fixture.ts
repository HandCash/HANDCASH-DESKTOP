import { Certificate, MasterCertificate, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { afterEach, beforeEach } from 'vitest'
import { BRC169_HANDLE_CERT_TYPE, HANDLE_CERTIFIERS } from './handleCertificate'
import { HOME_HANDLE_DOMAIN } from './handleDomain'

/** BRC-169 Appendix A.1 `lkup.net certifier`. */
export const TEST_CERTIFIER = new ProtoWallet(
  PrivateKey.fromHex('2641016ccb8e5602f53467fd6a8d91e2c58d44b8f727bd843da3f5f71e79e4c8'),
)
export const TEST_CERTIFIER_PUB =
  '0371f0ec5992a9d38e09fe528e367890969c66eaebdb01b4d35a2fc0d61251b3f9'

export const NULL_OUTPOINT = `${'00'.repeat(32)}.0`

/** Valid compressed identity keys for test subjects. */
export function testIdentityKey(seed: number): string {
  return PrivateKey.fromHex(seed.toString(16).padStart(64, '0')).toPublicKey().toString()
}

const b64 = (s: string) => Utils.toBase64(Utils.toArray(s, 'utf8'))

export async function signedHandleCertificate(
  handle: string,
  identityKey: string,
  domain = HOME_HANDLE_DOMAIN,
  certifier: ProtoWallet = TEST_CERTIFIER,
  revocationOutpoint = NULL_OUTPOINT,
): Promise<Record<string, unknown>> {
  const cert = new Certificate(
    BRC169_HANDLE_CERT_TYPE,
    Utils.toBase64(Array.from({ length: 32 }, (_, i) => (i * 7 + handle.length) & 0xff)),
    identityKey,
    '',
    revocationOutpoint,
    { domain: b64(domain), handle: b64(handle) },
  )
  await cert.sign(certifier)
  return { ...cert, fields: { ...cert.fields } }
}

export async function walletHandleCertificate(
  handle: string,
  identityKey: string,
  domain = HOME_HANDLE_DOMAIN,
): Promise<Record<string, unknown>> {
  const master = await MasterCertificate.issueCertificateForSubject(
    TEST_CERTIFIER,
    identityKey,
    { domain, handle },
    BRC169_HANDLE_CERT_TYPE,
    async () => NULL_OUTPOINT,
  )
  return {
    type: master.type,
    serialNumber: master.serialNumber,
    subject: master.subject,
    certifier: master.certifier,
    revocationOutpoint: master.revocationOutpoint,
    fields: { ...master.fields },
    signature: master.signature,
    keyringForSubject: { ...master.masterKeyring },
  }
}

/** Pins the A.1 test certifier for the home handle domain around each test in the file. */
export function useTestHandleCertifier(): void {
  const pins = HANDLE_CERTIFIERS as Record<string, string>
  let previous: string | undefined
  beforeEach(() => {
    previous = pins[HOME_HANDLE_DOMAIN]
    pins[HOME_HANDLE_DOMAIN] = TEST_CERTIFIER_PUB
  })
  afterEach(() => {
    if (previous) pins[HOME_HANDLE_DOMAIN] = previous
  })
}
