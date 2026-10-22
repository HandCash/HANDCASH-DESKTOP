import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storageRegistry } from '../storage/registry'
import { accountLocalKey, accountLocalKeyFor } from './accountLocalKeys'
import {
  TEST_CERTIFIER_PUB,
  testIdentityKey,
  useTestHandleCertifier,
  walletHandleCertificate,
} from './handleCertificate.fixture'

useTestHandleCertifier()

const OWN_KEY = testIdentityKey(21)
const OWN_ROOT = (21).toString(16).padStart(64, '0')
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
    rootKeyHex: OWN_ROOT,
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
  display: '@alice@brc-cloud.bcryderman.workers.dev',
  certificate: publicCertificate,
  walletCertificate: null,
}))

const resolveHandle = vi.fn(async (): Promise<Record<string, unknown>> => ({
  handle: 'alice',
  domain: 'brc-cloud.bcryderman.workers.dev',
  identityKey: walletState.identityKey,
  certificate: publicCertificate,
  walletCertificate: null,
  display: '@alice@brc-cloud.bcryderman.workers.dev',
  messagebox: null,
}))

const releaseHandle = vi.fn(async (_args: Record<string, unknown>) => ({ forwarding: null }))

vi.mock('./handleResolve', () => ({
  HandleNotFoundError: class HandleNotFoundError extends Error {},
  claimHandle: (...args: unknown[]) => claimHandle(...(args as [])),
  resolveHandle: (...args: unknown[]) => resolveHandle(...(args as [])),
  releaseHandle: (args: Record<string, unknown>) => releaseHandle(args),
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
  releaseHandle.mockClear()
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
      display: '@alice@brc-cloud.bcryderman.workers.dev',
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
      display: '@alice@brc-cloud.bcryderman.workers.dev',
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
      domain: 'brc-cloud.bcryderman.workers.dev',
      identityKey: OWN_KEY,
      certificate: publicCertificate,
      walletCertificate: current,
      display: '@alice@brc-cloud.bcryderman.workers.dev',
      messagebox: null,
    })
    store.set(
      accountLocalKey('handcash.brc169.claimedHandle.v1'),
      JSON.stringify({ handle: 'alice', display: '@alice@brc-cloud.bcryderman.workers.dev', identityKey: OWN_KEY, claimedAt: 1 }),
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

describe('releaseCloudHandle', () => {
  it('releases with a record this key signed, then drops the claim and its certificate', async () => {
    const { claimCloudHandlePayload, readClaimedCloudHandle, releaseCloudHandle } = await import('./handleClaim')
    const { verifiedForwarding } = await import('./handleForwarding')
    await claimCloudHandlePayload({ handle: 'alice', claimTicket: 'ticket' })
    held.push({ serialNumber: 'c2VyaWFs' })
    const next = testIdentityKey(22)
    resolveHandle.mockResolvedValueOnce({ handle: 'alice', domain: 'other.example', identityKey: next })

    await releaseCloudHandle({ forwardTo: '@alice@other.example' })

    const sent = releaseHandle.mock.calls[0]![0] as { handle: string; rootKeyHex: string; forwarding: unknown }
    expect(sent.handle).toBe('alice')
    expect(sent.rootKeyHex).toBe(OWN_ROOT)
    expect(verifiedForwarding(sent.forwarding, OWN_KEY)).toMatchObject({
      from: '@alice@brc-cloud.bcryderman.workers.dev',
      toIdentityKey: next,
      toHandle: '@alice@other.example',
    })
    expect(readClaimedCloudHandle()).toBeNull()
    expect(relinquishCertificate).toHaveBeenCalledWith(expect.objectContaining({ serialNumber: 'c2VyaWFs' }))
  })

  it('keeps the claim when the host refuses the release', async () => {
    const { claimCloudHandlePayload, readClaimedCloudHandle, releaseCloudHandle } = await import('./handleClaim')
    await claimCloudHandlePayload({ handle: 'alice', claimTicket: 'ticket' })
    releaseHandle.mockRejectedValueOnce(new Error('Handle release failed (503)'))
    await expect(releaseCloudHandle()).rejects.toThrow(/503/)
    expect(readClaimedCloudHandle()?.handle).toBe('alice')
  })
})

describe('getClaimedCloudHandleVerified', () => {
  it('returns the certificate so an app can verify without listCertificates', async () => {
    store.set(
      accountLocalKey('handcash.brc169.claimedHandle.v1'),
      JSON.stringify({
        handle: 'alice',
        display: '@alice@brc-cloud.bcryderman.workers.dev',
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
        display: '@alice@brc-cloud.bcryderman.workers.dev',
        identityKey: walletState.identityKey,
        claimedAt: 1,
      }),
    )
    resolveHandle.mockResolvedValueOnce({
      handle: 'alice',
      domain: 'brc-cloud.bcryderman.workers.dev',
      identityKey: testIdentityKey(77),
      certificate: publicCertificate,
      display: '@alice@brc-cloud.bcryderman.workers.dev',
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
      display: '@alice@brc-cloud.bcryderman.workers.dev',
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

describe('claimedHandleForAccount', () => {
  it("reads another vault account's claim, only when it names that account's key", async () => {
    const { claimedHandleForAccount } = await import('./handleClaim')
    const other = testIdentityKey(22)
    const scope = { identityKey: other, accountIndex: 2, chain: 'main' as const }
    const key = accountLocalKeyFor(storageRegistry.claimedHandle.key, scope)
    expect(claimedHandleForAccount(scope)).toBeNull()
    store.set(key, JSON.stringify({ handle: 'bob', display: '@bob@brc-cloud.bcryderman.workers.dev', identityKey: other, claimedAt: 1 }))
    expect(claimedHandleForAccount(scope)).toMatchObject({ handle: 'bob', display: '@bob@brc-cloud.bcryderman.workers.dev' })
    store.set(key, JSON.stringify({ handle: 'bob', display: '@bob@brc-cloud.bcryderman.workers.dev', identityKey: OWN_KEY, claimedAt: 1 }))
    expect(claimedHandleForAccount(scope)).toBeNull()
  })
})
