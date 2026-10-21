import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SigninRequest } from './api'

const pending: Array<(value: { registered: boolean; requests: SigninRequest[] }) => void> = []

vi.mock('./api', () => ({
  listSigninRequests: vi.fn(
    () => new Promise((resolve) => pending.push(resolve as (typeof pending)[number])),
  ),
  reportSigninPresence: vi.fn(async () => ({ ok: true })),
}))
vi.mock('./approver', () => ({
  walletSigninKeyHex: () => '11'.repeat(32),
  claimedHere: () => false,
  signinApprovalCode: () => null,
  approveSigninRequest: vi.fn(),
  claimSigninRequest: vi.fn(),
  refuseSigninRequest: vi.fn(),
}))
vi.mock('../deviceWallets', () => ({ getOrCreateDeviceId: () => 'this-device' }))
vi.mock('../deviceTransfer', () => ({ localDeviceLabel: () => 'Mac' }))

const { startDeviceSigninService, stopDeviceSigninService, subscribeDeviceSignin } = await import('./service')

const openRequest: SigninRequest = {
  binding: 'b'.repeat(32),
  state: 'open',
  label: 'Windows PC',
  location: 'Lisbon, PT',
  loginKey: '02'.padEnd(66, '0'),
  commitment: 'c'.repeat(64),
  rB: null,
  rA: null,
  deviceId: null,
  approverLabel: null,
  createdAt: 1,
  expiresAt: 2,
}

afterEach(() => stopDeviceSigninService())

describe('device sign-in service', () => {
  it('drops a poll that returns after the wallet locked', async () => {
    const rows: number[] = []
    const off = subscribeDeviceSignin((snapshot) => rows.push(snapshot.rows.length))
    startDeviceSigninService()
    expect(pending).toHaveLength(1)
    stopDeviceSigninService()
    pending.shift()!({ registered: true, requests: [openRequest] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rows.every((count) => count === 0)).toBe(true)
    off()
  })

  it('publishes requests the relay returns while unlocked', async () => {
    let last = -1
    const off = subscribeDeviceSignin((snapshot) => (last = snapshot.rows.length))
    startDeviceSigninService()
    pending.shift()!({ registered: true, requests: [openRequest] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(last).toBe(1)
    off()
  })
})
