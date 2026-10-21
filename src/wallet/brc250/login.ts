import { PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import { recoverRootKeyFromBrc140Shares } from '../brc140Backup'
import {
  approvalComparisonCode as sharedComparisonCode,
  commitmentFor,
  comparisonCode,
  freshLoginKey,
  localDeviceLabel,
  openVaultTransfer,
  randomHex,
  sealVaultTransfer,
  vaultTransferOf,
  type VaultTransfer,
} from '../deviceTransfer'
import { getOrCreateDeviceId } from '../deviceWallets'
import { requireWalletRuntime } from '../walletRuntime'
import {
  createGoogleAttempt,
  readLoginStatus,
  signedBrc250Fetch,
  startLoginRequest,
  verifiedGoogleProof,
} from './api'
import { authorityPrivateKey } from './crypto'
import { getEmailRecoveryEnrollment } from './store'
import {
  BRC250_HOST,
  type GoogleAttempt,
  type LoginStart,
  type LoginStatus,
} from './types'

export type NewDeviceLogin = {
  host: string
  key: PrivateKey
  rA: string
  commitment: string
  attempt: GoogleAttempt
  start?: LoginStart
}

export type PendingDeviceApproval = {
  binding: string
  state: 'open' | 'challenged' | 'revealed'
  context: string
  commitment: string
  loginKey: string
  rB: string | null
  rA: string | null
  deviceId: string | null
  releaseAt: number | null
  createdAt: number
  expiresAt: number
}

export type { VaultTransfer }

export async function beginNewDeviceGoogleLogin(
  host = BRC250_HOST,
): Promise<NewDeviceLogin> {
  const key = freshLoginKey()
  const rA = randomHex(32)
  const context = `Sign in to HandCash on ${localDeviceLabel()}`
  const commitment = commitmentFor(key.toPublicKey(), rA)
  const attempt = await createGoogleAttempt({
    host,
    purpose: 'login',
    loginKey: key.toPublicKey().toString(),
    commitment,
    context,
  })
  return { host, key, rA, commitment, attempt }
}

export async function finishGoogleLoginProof(
  login: NewDeviceLogin,
): Promise<LoginStart | null> {
  const proof = await verifiedGoogleProof(login.attempt.binding, login.host, {
    loginKey: login.key.toPublicKey().toString(),
    commitment: login.commitment,
    purpose: 'login',
  })
  if (!proof) return null
  const start = await startLoginRequest(
    login.key,
    login.attempt.binding,
    login.host,
  )
  login.start = start
  return start
}

export function pollNewDeviceLogin(
  login: NewDeviceLogin,
): Promise<LoginStatus> {
  return readLoginStatus(login.key, login.attempt.binding, login.host)
}

export async function revealNewDeviceCode(
  login: NewDeviceLogin,
  status: LoginStatus,
): Promise<string> {
  if (!status.rB) throw new Error('An existing device has not challenged this login')
  await signedBrc250Fetch({
    host: login.host,
    path: '/v1/login/reveal',
    key: login.key,
    body: { binding: login.attempt.binding, rA: login.rA },
  })
  return comparisonCode(login.attempt.binding, login.rA, status.rB)
}

export async function listPendingDeviceApprovals(): Promise<PendingDeviceApproval[]> {
  const enrollment = getEmailRecoveryEnrollment()
  if (!enrollment) return []
  const key = currentAuthorityKey()
  const result = await signedBrc250Fetch<{ requests: PendingDeviceApproval[] }>({
    host: enrollment.host,
    path: '/v1/login/pending',
    key,
    method: 'GET',
  })
  return result.requests
}

export async function challengeDeviceLogin(
  request: PendingDeviceApproval,
): Promise<{ rB: string }> {
  const enrollment = getEmailRecoveryEnrollment()
  if (!enrollment) throw new Error('Google recovery is not configured')
  const rB = randomHex(32)
  await signedBrc250Fetch({
    host: enrollment.host,
    path: '/v1/login/challenge',
    key: currentAuthorityKey(),
    body: {
      binding: request.binding,
      rB,
      deviceId: getOrCreateDeviceId(),
    },
  })
  return { rB }
}

export function approvalComparisonCode(
  request: PendingDeviceApproval,
  rB: string,
): string {
  return sharedComparisonCode(request, rB)
}

export async function approveDeviceLogin(
  request: PendingDeviceApproval,
): Promise<void> {
  const active = requireWalletRuntime().instance
  const enrollment = getEmailRecoveryEnrollment()
  if (!enrollment) throw new Error('Unlock this vault to approve login')
  if (!request.rA || !request.rB) {
    throw new Error('Compare the device codes before approving')
  }
  const authority = authorityPrivateKey(active)
  const sealedVault = sealVaultTransfer(
    vaultTransferOf(active.vaultMaster, enrollment),
    authority,
    request.loginKey,
  )
  await signedBrc250Fetch({
    host: enrollment.host,
    path: '/v1/login/complete',
    key: authority,
    body: { binding: request.binding, sealedVault },
  })
}

export async function refuseDeviceLogin(
  request: PendingDeviceApproval,
): Promise<void> {
  const enrollment = getEmailRecoveryEnrollment()
  if (!enrollment) throw new Error('Google recovery is not configured')
  await signedBrc250Fetch({
    host: enrollment.host,
    path: '/v1/login/refuse',
    key: currentAuthorityKey(),
    body: { binding: request.binding },
  })
}

export function openApprovedVault(
  login: NewDeviceLogin,
  sealedVault: string,
): VaultTransfer {
  return openVaultTransfer(sealedVault, login.key)
}

export async function requestDelayedRecoveryShare(
  login: NewDeviceLogin,
): Promise<{
  hostShare: string
  master: { derivation: 'brc-42' } | { derivation: 'brc-157'; entropyLength: number }
}> {
  const result = await signedBrc250Fetch<{
    state: 'released'
    sealedShare: {
      v: 1
      ephemeralKey: string
      iv: string
      ciphertext: string
    }
    master:
      | { derivation: 'brc-42' }
      | { derivation: 'brc-157'; entropyLength: number }
  }>({
    host: login.host,
    path: '/v1/login/release',
    key: login.key,
    body: { binding: login.attempt.binding },
  })
  return {
    hostShare: await openHostShare(login.key, result.sealedShare),
    master: result.master,
  }
}

export function recoverDelayedVault(
  hostShare: string,
  mailboxText: string,
): string {
  return recoverRootKeyFromBrc140Shares([hostShare, mailboxText]).rootKeyHex
}

export async function sendDevicePresence(
  signedOut = false,
): Promise<void> {
  const enrollment = getEmailRecoveryEnrollment()
  if (!enrollment) return
  await signedBrc250Fetch({
    host: enrollment.host,
    path: '/v1/presence',
    key: currentAuthorityKey(),
    body: {
      deviceId: getOrCreateDeviceId(),
      label: localDeviceLabel(),
      state: signedOut ? 'signedOut' : 'active',
    },
  })
}

async function openHostShare(
  key: PrivateKey,
  sealed: {
    v: 1
    ephemeralKey: string
    iv: string
    ciphertext: string
  },
): Promise<string> {
  if (sealed.v !== 1) throw new Error('Unsupported recovery-share envelope')
  const shared = key.deriveSharedSecret(PublicKey.fromString(sealed.ephemeralKey))
  const encoded = shared.encode(true)
  const compressed =
    typeof encoded === 'string' ? Utils.toArray(encoded, 'hex') : encoded
  const raw = Uint8Array.from(compressed.slice(1))
  const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, [
    'deriveKey',
  ])
  const aes = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('brc250-host-share-v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufferOf(base64urlBytes(sealed.iv)) },
    aes,
    bufferOf(base64urlBytes(sealed.ciphertext)),
  )
  return new TextDecoder().decode(plain)
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function base64urlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '=',
  )
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
}

function currentAuthorityKey(): PrivateKey {
  return authorityPrivateKey(requireWalletRuntime().instance)
}
