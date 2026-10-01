import { beforeEach, describe, expect, it, vi } from 'vitest'
import { accountLocalKey } from './accountLocalKeys'
import {
  TEST_CERTIFIER_PUB,
  testIdentityKey,
  useTestHandleCertifier,
  walletHandleCertificate,
} from './handleCertificate.fixture'

useTestHandleCertifier()

const OWN_KEY = testIdentityKey(21)
const store = new Map<string, string>()
const acquireCertificate = vi.fn(async (_args: Record<string, unknown>) => ({ type: 'ok' }))
const held: Array<{ serialNumber: string }> = []
const listCertificates = vi.fn(async () => ({ totalCertificates: held.length, certificates: [...held] }))
const relinquishCertificate = vi.fn(async (_args: { serialNumber: string }) => ({ relinquished: true }))
const walletState = { identityKey: OWN_KEY }

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
    return true
  },
  durableRemoveItem: (k: string) => {
    store.delete(k)
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: walletState.identityKey,
    wallet: { acquireCertificate, listCertificates, relinquishCertificate },
  }),
}))

const publicCertificate = {
  type: 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=',
  subject: OWN_KEY,
  certifier: TEST_CERTIFIER_PUB,
  serialNumber: 'c2VyaWFs',
  fields: { handle: 'YWxpY2U=', domain: 'aGFuZGNhc2guaW8=' },
  revocationOutpoint: `${'00'.repeat(32)}.0`,
  signature: '3045',
}

const claimHandle = vi.fn(async (): Promise<Record<string, unknown>> => ({
  display: '@alice@handcash.io',
  certificate: publicCertificate,
  walletCertificate: null,
}))

const resolveHandle = vi.fn(async (): Promise<Record<string, unknown>> => ({
  handle: 'alice',
  domain: 'handcash.io',
  identityKey: walletState.identityKey,
  certificate: publicCertificate,
  walletCertificate: null,
  display: '@alice@handcash.io',
  messagebox: null,
}))

vi.mock('./handleResolve', () => ({
  HandleNotFoundError: class HandleNotFoundError extends Error {},
  claimHandle: (...args: unknown[]) => claimHandle(...(args as [])),
  resolveHandle: (...args: unknown[]) => resolveHandle(...(args as [])),
}))

vi.mock('./migration', () => ({
  isMigrationOrigin: (origin: string | undefined) => {
    const host = String(origin || '')
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      ?.split(':')[0]
      ?.toLowerCase()
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === 'handcash.io' ||
      host === 'market.handcash.io' ||
      host === 'preprod-market.handcash.io'
    )
  },
}))

beforeEach(() => {
  store.clear()
  held.length = 0
  acquireCertificate.mockClear()
  listCertificates.mockClear()
  relinquishCertificate.mockClear()
  claimHandle.mockClear()
  resolveHandle.mockClear()
  walletState.identityKey = OWN_KEY
})

describe('handle claim origin gates', () => {
  it('allows HandCash hosts to mint, and any app to read', async () => {
    const {
      isHandleClaimOrigin,
      isHandleClaimWriteMethod,
      isHandleClaimReadMethod,
    } = await import('./handleClaim')

    expect(isHandleClaimWriteMethod('claimCloudHandle')).toBe(true)
    expect(isHandleClaimWriteMethod('getClaimedCloudHandle')).toBe(false)
    expect(isHandleClaimReadMethod('getClaimedCloudHandle')).toBe(true)

    expect(isHandleClaimOrigin('https://market.handcash.io')).toBe(true)
    expect(isHandleClaimOrigin('http://localhost:3000')).toBe(true)
    // Free Radio must not mint, but read is no longer origin-gated.
    expect(isHandleClaimOrigin('https://freeradio.bsvb.net')).toBe(false)
  })
})

describe('claimCloudHandlePayload', () => {
  it('stores the verified public certificate and acquires the wallet copy', async () => {
    const walletCertificate = await walletHandleCertificate('alice', OWN_KEY)
    claimHandle.mockResolvedValueOnce({
      display: '@alice@handcash.io',
      certificate: publicCertificate,
      walletCertificate,
    })
    const { claimCloudHandlePayload, readClaimedCloudHandle } = await import('./handleClaim')
    const state = await claimCloudHandlePayload({ handle: 'alice', claimTicket: 'ticket' })

    expect(state.certificate).toEqual(publicCertificate)
    expect(readClaimedCloudHandle()?.certificate?.type).toContain('XgCFd')
    expect(acquireCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        acquisitionProtocol: 'direct',
        keyringRevealer: 'certifier',
        serialNumber: walletCertificate.serialNumber,
        keyringForSubject: walletCertificate.keyringForSubject,
      }),
    )
  })

  it('never acquires a wallet copy for another subject or certifier', async () => {
    const foreign = await walletHandleCertificate('alice', testIdentityKey(99))
    claimHandle.mockResolvedValueOnce({
      display: '@alice@handcash.io',
      certificate: publicCertificate,
      walletCertificate: foreign,
    })
    const { claimCloudHandlePayload } = await import('./handleClaim')
    await claimCloudHandlePayload({ handle: 'alice', claimTicket: 'ticket' })
    expect(acquireCertificate).not.toHaveBeenCalled()
  })

  it('holds only the current serial: relinquishes the old one, skips acquiring a held one', async () => {
    const current = await walletHandleCertificate('alice', OWN_KEY)
    held.push({ serialNumber: 'old-serial' }, { serialNumber: String(current.serialNumber) })
    resolveHandle.mockResolvedValueOnce({
      handle: 'alice',
      domain: 'handcash.io',
      identityKey: OWN_KEY,
      certificate: publicCertificate,
      walletCertificate: current,
      display: '@alice@handcash.io',
      messagebox: null,
    })
    store.set(
      accountLocalKey('handcash.brc169.claimedHandle.v1'),
      JSON.stringify({ handle: 'alice', display: '@alice@handcash.io', identityKey: OWN_KEY, claimedAt: 1 }),
    )
    const { getClaimedCloudHandleVerified } = await import('./handleClaim')
    await getClaimedCloudHandleVerified()
    await vi.waitFor(() => expect(relinquishCertificate).toHaveBeenCalledTimes(1))
    expect(relinquishCertificate.mock.calls[0]?.[0]).toMatchObject({ serialNumber: 'old-serial' })
    expect(acquireCertificate).not.toHaveBeenCalled()
  })

  it('refuses to claim without a ticket', async () => {
    const { claimCloudHandlePayload } = await import('./handleClaim')
    await expect(claimCloudHandlePayload({ handle: 'alice' })).rejects.toThrow(
      /claim ticket/i,
    )
  })
})

describe('getClaimedCloudHandleVerified', () => {
  it('returns the certificate so an app can verify without listCertificates', async () => {
    store.set(
      accountLocalKey('handcash.brc169.claimedHandle.v1'),
      JSON.stringify({
        handle: 'alice',
        display: '@alice@handcash.io',
        identityKey: walletState.identityKey,
        claimedAt: 1,
      }),
    )

    const { getClaimedCloudHandleVerified } = await import('./handleClaim')
    const state = await getClaimedCloudHandleVerified()

    expect(state?.handle).toBe('alice')
    expect(state?.certificate).toEqual(publicCertificate)
  })

  it('clears a stale claim when the registry binding moved', async () => {
    store.set(
      accountLocalKey('handcash.brc169.claimedHandle.v1'),
      JSON.stringify({
        handle: 'alice',
        display: '@alice@handcash.io',
        identityKey: walletState.identityKey,
        claimedAt: 1,
      }),
    )
    resolveHandle.mockResolvedValueOnce({
      handle: 'alice',
      domain: 'handcash.io',
      identityKey: testIdentityKey(77),
      certificate: publicCertificate,
      display: '@alice@handcash.io',
      messagebox: null,
    })
    held.push({ serialNumber: 'stale' })

    const { getClaimedCloudHandleVerified, readClaimedCloudHandle } =
      await import('./handleClaim')
    expect(await getClaimedCloudHandleVerified()).toBeNull()
    expect(readClaimedCloudHandle()).toBeNull()
    await vi.waitFor(() =>
      expect(relinquishCertificate).toHaveBeenCalledWith(
        expect.objectContaining({ serialNumber: 'stale', certifier: TEST_CERTIFIER_PUB }),
      ),
    )
  })

  it('keeps the claim while the registry is unreachable, and ends it on an answered not-found', async () => {
    const claim = {
      handle: 'alice',
      display: '@alice@handcash.io',
      identityKey: walletState.identityKey,
      claimedAt: 1,
    }
    store.set(accountLocalKey('handcash.brc169.claimedHandle.v1'), JSON.stringify(claim))
    const { HandleNotFoundError } = await import('./handleResolve')
    const { getClaimedCloudHandleVerified, readClaimedCloudHandle } =
      await import('./handleClaim')

    resolveHandle.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await getClaimedCloudHandleVerified()).toMatchObject({ handle: 'alice' })
    expect(readClaimedCloudHandle()?.handle).toBe('alice')

    resolveHandle.mockRejectedValueOnce(new HandleNotFoundError('$alice'))
    expect(await getClaimedCloudHandleVerified()).toBeNull()
    expect(readClaimedCloudHandle()).toBeNull()
  })
})
