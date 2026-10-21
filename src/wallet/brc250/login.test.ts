import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { commitmentFor } from '../deviceTransfer'
import {
  approvalComparisonCode,
  recoverDelayedVault,
  type PendingDeviceApproval,
} from './login'
import { createBrc140Shares } from '../brc140Backup'

function request(overrides: Partial<PendingDeviceApproval> = {}): PendingDeviceApproval {
  const loginKey = PrivateKey.fromRandom().toPublicKey()
  const rA = 'aa'.repeat(32)
  return {
    binding: 'binding',
    state: 'revealed',
    context: 'Sign in',
    commitment: commitmentFor(loginKey, rA),
    loginKey: loginKey.toString(),
    rB: 'bb'.repeat(32),
    rA,
    deviceId: 'device',
    releaseAt: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

describe('BRC-250 login', () => {
  it('shows a comparison code only after the reveal matches its commitment', () => {
    expect(approvalComparisonCode(request(), 'bb'.repeat(32))).toMatch(/^\d{8}$/)
    expect(() =>
      approvalComparisonCode(request({ rA: 'cc'.repeat(32) }), 'bb'.repeat(32)),
    ).toThrow(/does not match/)
  })

  it('delayed recovery needs the host and mailbox shares', () => {
    const key = PrivateKey.fromRandom()
    const shares = createBrc140Shares(key.toHex())
    expect(recoverDelayedVault(shares.shares[0]!, shares.shares[1]!)).toBe(
      key.toHex(),
    )
    expect(() => recoverDelayedVault(shares.shares[0]!, '')).toThrow()
  })
})
