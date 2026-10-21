/**
 * The signed-in device's side: claim a request (send rB), show the code once the
 * new device reveals, then send the vault encrypted to the new device's key.
 *
 * The code uses the rB this device generated, never the relay's copy: a relay
 * that could pick rB after seeing the new device's reveal could make the codes
 * match for a key of its own.
 */
import { PrivateKey } from '@bsv/sdk'
import { getEmailRecoveryEnrollment } from '../brc250/store'
import { deviceAuthStatus, deviceAuthUnlock } from '../deviceAuth'
import {
  approvalComparisonCode,
  randomHex,
  sealVaultTransfer,
  vaultTransferOf,
} from '../deviceTransfer'
import { getOrCreateDeviceId } from '../deviceWallets'
import { accountRootKeyHex } from '../vaultMaster'
import { requireWalletRuntime } from '../walletRuntime'
import {
  challengeSignin,
  completeSignin,
  refuseSignin,
  type SigninRequest,
} from './api'

const ownRB = new Map<string, string>()

export function walletSigninKeyHex(): string {
  return accountRootKeyHex(requireWalletRuntime().instance.vaultMaster, 0)
}

export function claimedHere(request: SigninRequest, deviceId = getOrCreateDeviceId()): boolean {
  return request.deviceId === deviceId && ownRB.has(request.binding)
}

export async function claimSigninRequest(request: SigninRequest): Promise<void> {
  if (request.state !== 'open' || ownRB.has(request.binding)) return
  const rB = randomHex(32)
  ownRB.set(request.binding, rB)
  try {
    await challengeSignin(walletSigninKeyHex(), request.binding, rB, getOrCreateDeviceId())
  } catch (error) {
    ownRB.delete(request.binding)
    throw error
  }
}

/** The 8-digit code to compare, once the new device revealed against this device's rB. */
export function signinApprovalCode(request: SigninRequest, deviceId = getOrCreateDeviceId()): string | null {
  const rB = ownRB.get(request.binding)
  if (!rB || request.state !== 'revealed' || request.deviceId !== deviceId) return null
  return approvalComparisonCode(request, rB)
}

/** Touch ID right before the key leaves, when this device has it set up. */
export async function confirmPresence(reason: string): Promise<void> {
  const status = await deviceAuthStatus()
  if (!status.enrolled) return
  const result = await deviceAuthUnlock(reason)
  if (!result.ok) throw new Error(`${status.label} was not confirmed`)
}

export async function approveSigninRequest(request: SigninRequest): Promise<void> {
  if (!signinApprovalCode(request)) throw new Error('Compare the codes before approving')
  await confirmPresence(`approve sign-in on ${request.label}`)
  const active = requireWalletRuntime().instance
  const sealed = sealVaultTransfer(
    vaultTransferOf(active.vaultMaster, getEmailRecoveryEnrollment()),
    PrivateKey.fromRandom(),
    request.loginKey,
  )
  await completeSignin(walletSigninKeyHex(), request.binding, getOrCreateDeviceId(), sealed)
  ownRB.delete(request.binding)
}

export async function refuseSigninRequest(request: SigninRequest): Promise<void> {
  await refuseSignin(walletSigninKeyHex(), request.binding)
  ownRB.delete(request.binding)
}

/** Test seam: forget claims made in this session. */
export function resetSigninClaims(): void {
  ownRB.clear()
}
