import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approvalComparisonCode,
  commitmentFor,
  sealVaultTransfer,
  type VaultTransfer,
} from '../deviceTransfer'
import type { SigninRequest, SigninStatus } from './api'
import { advanceNewDeviceSignin, type NewDeviceSignin } from './newDevice'
import { signinAlertText, signinRowView } from './view'

const transfer: VaultTransfer = {
  v: 1,
  kind: 'handcash-brc250-vault',
  master: { derivation: 'brc-42', keyHex: PrivateKey.fromRandom().toHex() },
  enrollment: null,
  accounts: { version: 1 },
  sentAt: 1,
}

function newDevice(): NewDeviceSignin {
  const key = PrivateKey.fromRandom()
  const rA = 'aa'.repeat(32)
  return {
    key,
    rA,
    commitment: commitmentFor(key.toPublicKey(), rA),
    start: { binding: 'b'.repeat(32), expiresAt: Date.now() + 60_000, online: 1, devices: [] },
    revealedRB: null,
    code: null,
  }
}

const status = (over: Partial<SigninStatus>): SigninStatus => ({
  state: 'open',
  rB: null,
  sealedVault: null,
  approverLabel: null,
  expiresAt: Date.now() + 60_000,
  ...over,
})

const sent: string[] = []
beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('fetch', async (url: string) => {
    sent.push(String(url))
    return new Response('{"ok":true}', { status: 200 })
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('email sign-in on the new device', () => {
  it('reveals once and shows the code the approving device computes', async () => {
    const signin = newDevice()
    const rB = 'cc'.repeat(32)
    expect(await advanceNewDeviceSignin(signin, async () => status({}))).toMatchObject({ state: 'waiting' })
    const step = await advanceNewDeviceSignin(signin, async () => status({ state: 'challenged', rB }))
    expect(sent.filter((url) => url.endsWith('/v1/signin/reveal'))).toHaveLength(1)
    const approver = approvalComparisonCode(
      { binding: signin.start.binding, loginKey: signin.key.toPublicKey().toString(), commitment: signin.commitment, rA: signin.rA },
      rB,
    )
    expect(step).toEqual({ state: 'comparing', code: approver, expiresAt: expect.any(Number) })
    await advanceNewDeviceSignin(signin, async () => status({ state: 'revealed', rB }))
    expect(sent.filter((url) => url.endsWith('/v1/signin/reveal'))).toHaveLength(1)
  })

  it('stops when the relay swaps the approving device code after the reveal', async () => {
    const signin = newDevice()
    await advanceNewDeviceSignin(signin, async () => status({ state: 'challenged', rB: 'cc'.repeat(32) }))
    await expect(
      advanceNewDeviceSignin(signin, async () => status({ state: 'revealed', rB: 'dd'.repeat(32) })),
    ).rejects.toThrow(/changed/)
  })

  it('opens the vault the approving device sealed to this device', async () => {
    const signin = newDevice()
    const rB = 'cc'.repeat(32)
    await advanceNewDeviceSignin(signin, async () => status({ state: 'challenged', rB }))
    const sealedVault = sealVaultTransfer(transfer, PrivateKey.fromRandom(), signin.key.toPublicKey().toString())
    const step = await advanceNewDeviceSignin(signin, async () => status({ state: 'sent', rB, sealedVault, approverLabel: 'Mac' }))
    expect(step.state === 'approved' && step.transfer.master.keyHex).toBe(transfer.master.keyHex)
    expect(sent.some((url) => url.endsWith('/v1/signin/received'))).toBe(true)
  })

  it('reports refusal and expiry', async () => {
    expect(await advanceNewDeviceSignin(newDevice(), async () => status({ state: 'refused' }))).toEqual({ state: 'refused' })
    expect(await advanceNewDeviceSignin(newDevice(), async () => status({ state: 'expired' }))).toEqual({ state: 'expired' })
  })
})

function request(over: Partial<SigninRequest> = {}): SigninRequest {
  return {
    binding: 'b'.repeat(32),
    state: 'open',
    label: 'Windows PC',
    location: 'Lisbon, PT',
    loginKey: PrivateKey.fromRandom().toPublicKey().toString(),
    commitment: 'c'.repeat(64),
    rB: null,
    rA: null,
    deviceId: null,
    approverLabel: null,
    createdAt: 1,
    expiresAt: 2,
    ...over,
  }
}

describe('email sign-in rows on signed-in devices', () => {
  const here = { deviceId: 'mac-device', claimed: false, code: null }

  it('a new request names the device and what it waits on', () => {
    expect(signinRowView(request(), here)).toMatchObject({
      face: 'waiting',
      via: 'relay',
      title: 'Sign-in requested on Windows PC',
      detail: 'Near Lisbon, PT · waits on your approval',
      live: true,
    })
    expect(signinAlertText(request())).toEqual({
      title: 'Sign-in requested on Windows PC',
      body: 'Near Lisbon, PT. Approve or refuse it in Activity.',
    })
  })

  it('another device comparing codes shows where it waits', () => {
    const row = signinRowView(request({ state: 'challenged', deviceId: 'pc', approverLabel: 'iPhone' }), here)
    expect(row).toMatchObject({ face: 'elsewhere', detail: 'Waits on approval on iPhone' })
  })

  it('this device shows the code only once it claimed the request', () => {
    const mine = request({ state: 'revealed', deviceId: 'mac-device' })
    expect(signinRowView(mine, { ...here, claimed: true, code: '12345678' })).toMatchObject({ face: 'comparing', code: '12345678' })
    expect(signinRowView(mine, here).code).toBeNull()
  })

  it('outcomes stay on the row', () => {
    expect(signinRowView(request({ state: 'received', approverLabel: 'Mac' }), here)).toMatchObject({
      face: 'approved', title: 'Signed in on Windows PC', detail: 'Approved on Mac', live: false,
    })
    expect(signinRowView(request({ state: 'refused' }), here).face).toBe('refused')
    expect(signinRowView(request({ state: 'expired' }), here).face).toBe('expired')
  })
})
