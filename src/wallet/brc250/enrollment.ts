import { PrivateKey } from '@bsv/sdk'
import {
  createBrc140Shares,
  extractBrc140Shares,
  recoverRootKeyFromBrc140Shares,
} from '../brc140Backup'
import { getOrCreateDeviceId } from '../deviceWallets'
import { markManagedKeysBackupConfirmed } from '../backupStatus'
import { requireWalletRuntime } from '../walletRuntime'
import {
  createGoogleAttempt,
  fetchBrc250Manifest,
  googleEmailOf,
  signedBrc250Fetch,
  verifiedGoogleProof,
} from './api'
import { authorityPrivateKey } from './crypto'
import { freshLoginKey, randomHex } from '../deviceTransfer'
import { setEmailRecoveryEnrollment } from './store'
import {
  BRC250_HOST,
  type EmailRecoveryEnrollment,
  type GoogleAttempt,
} from './types'
import type { VaultMaster } from '../vaultMaster'

export type GoogleEnrollmentSession = {
  host: string
  attempt: GoogleAttempt
  authorityKey: PrivateKey
  hostShare: string
  mailboxShare: string
  vaultMasterHex: string
  master: VaultMaster
  loginKey: string
  commitment: string
}

export async function beginGoogleEnrollment(
  host = BRC250_HOST,
): Promise<GoogleEnrollmentSession> {
  const active = requireWalletRuntime().instance
  const authorityKey = authorityPrivateKey(active)
  const shares = createBrc140Shares(active.vaultMaster.keyHex, 2, 3)
  const loginKey = freshLoginKey()
  const commitment = randomHex(32)
  const loginPublicKey = loginKey.toPublicKey().toString()
  const attempt = await createGoogleAttempt({
    host,
    purpose: 'enroll',
    loginKey: loginPublicKey,
    commitment,
    context: 'Set up Google recovery for this HandCash vault',
  })
  return {
    host,
    attempt,
    authorityKey,
    hostShare: shares.shares[0]!,
    mailboxShare: shares.shares[1]!,
    vaultMasterHex: active.vaultMaster.keyHex,
    master: active.vaultMaster,
    loginKey: loginPublicKey,
    commitment,
  }
}

export function recoveryEmailUrl(
  email: string,
  mailboxShare: string,
): string {
  const subject = 'My HandCash recovery share'
  const body = [
    'Keep this email. It contains one of two shares needed for delayed HandCash recovery.',
    '',
    mailboxShare,
    '',
    'HandCash and Google cannot recover the vault from this share alone.',
  ].join('\n')
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export async function googleEnrollmentEmail(
  session: GoogleEnrollmentSession,
): Promise<string | null> {
  const proof = await verifiedGoogleProof(session.attempt.binding, session.host, {
    loginKey: session.loginKey,
    commitment: session.commitment,
    purpose: 'enroll',
  })
  return proof ? googleEmailOf(proof.idToken) : null
}

export async function completeGoogleEnrollment(
  session: GoogleEnrollmentSession,
  pastedMailboxCopy: string,
): Promise<EmailRecoveryEnrollment> {
  const proof = await verifiedGoogleProof(session.attempt.binding, session.host, {
    loginKey: session.loginKey,
    commitment: session.commitment,
    purpose: 'enroll',
  })
  if (!proof) throw new Error('Finish Google sign-in in the browser first')
  const pasted = extractBrc140Shares(pastedMailboxCopy)
  if (!pasted.includes(session.mailboxShare)) {
    throw new Error('Paste the recovery share from the email you sent yourself')
  }
  const recovered = recoverRootKeyFromBrc140Shares([
    session.hostShare,
    session.mailboxShare,
  ])
  if (recovered.rootKeyHex.toLowerCase() !== session.vaultMasterHex.toLowerCase()) {
    throw new Error('The mailbox recovery share does not match this vault')
  }
  const manifest = await fetchBrc250Manifest(session.host)
  const authorityKey = session.authorityKey
  const authorityPublicKey = authorityKey.toPublicKey().toString()
  const enrolled = await signedBrc250Fetch<{
    ok: true
    email: string
    mailboxConfirmed: boolean
  }>({
    host: session.host,
    path: '/v1/enroll',
    key: authorityKey,
    body: {
      binding: session.attempt.binding,
      authorityKey: authorityPublicKey,
      hostShare: session.hostShare,
      mailboxConfirmed: true,
      master:
        session.master.derivation === 'brc-157'
          ? {
              derivation: 'brc-157',
              entropyLength: session.master.entropyLength,
            }
          : { derivation: 'brc-42' },
      device: {
        deviceId: getOrCreateDeviceId(),
        label: localDeviceLabel(),
      },
    },
  })
  if (!enrolled.ok || !enrolled.mailboxConfirmed) {
    throw new Error('Recovery host did not confirm both recovery shares')
  }
  const record: EmailRecoveryEnrollment = {
    v: 1,
    host: session.host,
    email: enrolled.email.trim().toLowerCase(),
    authorityKey: authorityPublicKey,
    attesterKey: manifest.attesterKey,
    master:
      session.master.derivation === 'brc-157'
        ? {
            derivation: 'brc-157',
            entropyLength: session.master.entropyLength,
          }
        : { derivation: 'brc-42' },
    mailboxConfirmed: true,
    enrolledAt: Date.now(),
  }
  setEmailRecoveryEnrollment(record)
  markManagedKeysBackupConfirmed()
  return record
}

function localDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'HandCash device'
  if (/android/i.test(navigator.userAgent)) return 'Android phone'
  if (/iphone|ipad/i.test(navigator.userAgent)) return 'iPhone'
  if (/mac/i.test(navigator.userAgent)) return 'Mac'
  if (/win/i.test(navigator.userAgent)) return 'Windows PC'
  return 'HandCash device'
}
