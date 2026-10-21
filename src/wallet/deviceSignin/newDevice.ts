/**
 * The new device's side of sign-in: email code, one-time key and commitment,
 * then wait for one signed-in device to approve and send the vault.
 */
import type { PrivateKey } from '@bsv/sdk'
import {
  commitmentFor,
  comparisonCode,
  freshLoginKey,
  localDeviceLabel,
  openVaultTransfer,
  randomHex,
  type VaultTransfer,
} from '../deviceTransfer'
import {
  confirmSigninReceived,
  openSigninRequest,
  readSigninStatus,
  revealSignin,
  type SigninStart,
  type SigninStatus,
} from './api'

export type NewDeviceSignin = {
  key: PrivateKey
  rA: string
  commitment: string
  start: SigninStart
  /** rB this device revealed against; a later, different rB is refused. */
  revealedRB: string | null
  code: string | null
}

export type SigninStep =
  | { state: 'waiting'; expiresAt: number }
  | { state: 'comparing'; code: string; expiresAt: number }
  | { state: 'approved'; transfer: VaultTransfer; approverLabel: string | null }
  | { state: 'refused' }
  | { state: 'expired' }

export async function startNewDeviceSignin(requestId: string, code: string): Promise<NewDeviceSignin> {
  const key = freshLoginKey()
  const rA = randomHex(32)
  const commitment = commitmentFor(key.toPublicKey(), rA)
  const start = await openSigninRequest({
    requestId,
    code,
    loginKey: key.toPublicKey().toString(),
    commitment,
    label: localDeviceLabel(),
  })
  return { key, rA, commitment, start, revealedRB: null, code: null }
}

/** Read the relay once and move the sign-in on: reveal rA once, open the vault once it arrives. */
export async function advanceNewDeviceSignin(
  signin: NewDeviceSignin,
  read: (keyHex: string, binding: string) => Promise<SigninStatus> = readSigninStatus,
): Promise<SigninStep> {
  const keyHex = signin.key.toHex()
  const { binding } = signin.start
  const status = await read(keyHex, binding)
  if (status.state === 'refused') return { state: 'refused' }
  if (status.state === 'expired') return { state: 'expired' }
  if (signin.revealedRB && status.rB !== signin.revealedRB) {
    throw new Error('The approving device code changed mid-way. Start again.')
  }
  if (status.state === 'sent' && status.sealedVault) {
    const transfer = openVaultTransfer(status.sealedVault, signin.key)
    await confirmSigninReceived(keyHex, binding).catch(() => undefined)
    return { state: 'approved', transfer, approverLabel: status.approverLabel }
  }
  if (status.state === 'challenged' && status.rB && !signin.code) {
    signin.revealedRB = status.rB
    await revealSignin(keyHex, binding, signin.rA)
    signin.code = comparisonCode(binding, signin.rA, status.rB)
  }
  if (status.state === 'revealed' && signin.revealedRB && !signin.code) {
    signin.code = comparisonCode(binding, signin.rA, signin.revealedRB)
  }
  if (signin.code) return { state: 'comparing', code: signin.code, expiresAt: status.expiresAt }
  return { state: 'waiting', expiresAt: status.expiresAt }
}
