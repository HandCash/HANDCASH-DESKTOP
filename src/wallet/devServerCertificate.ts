/**
 * BRC-52 certificate that authorizes a developer server key (BRC-100
 * acquire / prove / relinquish). The private server key stays a derived
 * wallet with an isolated balance; this certificate replaces handing out
 * the identity signing key. Verifiers stop trusting it when the ledger
 * marks it revoked (and when a non-null revocation outpoint is spent).
 */
import {
  Hash,
  MasterCertificate,
  PrivateKey,
  ProtoWallet,
  Utils,
} from '@bsv/sdk'
import { presentedIdentityMaterial } from './publicIdentities'
import type { WalletRuntime } from './walletRuntime'

/** SHA-256("HandCash developer server") as BRC-52 type id (base64). */
export const DEV_SERVER_CERT_TYPE = Utils.toBase64(
  Hash.sha256(Utils.toArray('HandCash developer server', 'utf8')),
)

/** Unfunded revoke outpoint — revoke is ledger + relinquish until a dust UTXO is wired. */
export const DEV_SERVER_NULL_OUTPOINT = `${'00'.repeat(32)}.0`

export type DevServerCertificate = {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  /** Keyring that reveals fields to anyone (server + verifiers). */
  keyring: Record<string, string>
  signature: string
}

function certifierFor(runtime: WalletRuntime): { wallet: ProtoWallet; identityKey: string } {
  const presented = presentedIdentityMaterial(runtime)
  if (presented?.kind === 'presented') {
    return {
      wallet: new ProtoWallet(presented.signingKey),
      identityKey: presented.identityKey.toLowerCase(),
    }
  }
  const key = PrivateKey.fromHex(runtime.instance.rootKeyHex.padStart(64, '0'))
  return {
    wallet: new ProtoWallet(key),
    identityKey: key.toPublicKey().toString().toLowerCase(),
  }
}

/**
 * Issue a BRC-52 certificate: certifier = presented identity (or account root),
 * subject = the server wallet public key. Fields name the isolated wallet role.
 */
export async function issueDevServerCertificate(
  runtime: WalletRuntime,
  args: { subjectPublicKey: string; keyN: number },
): Promise<DevServerCertificate> {
  const { wallet, identityKey } = certifierFor(runtime)
  const subject = args.subjectPublicKey.toLowerCase()
  const plain: Record<string, string> = {
    role: 'server-wallet',
    keyN: String(args.keyN),
    issuedAt: new Date().toISOString(),
  }
  const master = await MasterCertificate.issueCertificateForSubject(
    wallet,
    subject,
    plain,
    DEV_SERVER_CERT_TYPE,
    async () => DEV_SERVER_NULL_OUTPOINT,
  )
  const keyring = await MasterCertificate.createKeyringForVerifier(
    wallet,
    subject,
    'anyone',
    master.fields,
    Object.keys(plain),
    master.masterKeyring,
    master.serialNumber,
  )
  if (!master.signature) throw new Error('Developer certificate was not signed.')
  return {
    type: master.type,
    serialNumber: master.serialNumber,
    subject: master.subject.toLowerCase(),
    certifier: (master.certifier || identityKey).toLowerCase(),
    revocationOutpoint: master.revocationOutpoint || DEV_SERVER_NULL_OUTPOINT,
    fields: { ...master.fields },
    keyring: { ...keyring },
    signature: master.signature,
  }
}

/** Wire shape for env export / proveCertificate. */
export function serializeDevServerCertificate(cert: DevServerCertificate): string {
  return JSON.stringify({
    type: cert.type,
    serialNumber: cert.serialNumber,
    subject: cert.subject,
    certifier: cert.certifier,
    revocationOutpoint: cert.revocationOutpoint,
    fields: cert.fields,
    keyring: cert.keyring,
    signature: cert.signature,
  })
}

export function parseDevServerCertificate(raw: unknown): DevServerCertificate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const fields = row.fields
  const keyring = row.keyring
  if (
    typeof row.type !== 'string' ||
    typeof row.serialNumber !== 'string' ||
    typeof row.subject !== 'string' ||
    typeof row.certifier !== 'string' ||
    typeof row.revocationOutpoint !== 'string' ||
    typeof row.signature !== 'string' ||
    !fields ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    !keyring ||
    typeof keyring !== 'object' ||
    Array.isArray(keyring)
  ) {
    return null
  }
  return {
    type: row.type,
    serialNumber: row.serialNumber,
    subject: row.subject.toLowerCase(),
    certifier: row.certifier.toLowerCase(),
    revocationOutpoint: row.revocationOutpoint,
    fields: fields as Record<string, string>,
    keyring: keyring as Record<string, string>,
    signature: row.signature,
  }
}
