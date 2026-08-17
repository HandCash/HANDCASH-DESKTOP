import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const acquireCertificate = vi.fn(async () => ({ type: 'ok' }))
const walletState = {
  identityKey: '03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
  },
  durableRemoveItem: (k: string) => {
    store.delete(k)
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: walletState.identityKey,
    wallet: { acquireCertificate },
  }),
}))

const claimHandle = vi.fn(async () => ({
  display: '@alice@handcash.io',
  certificate: {
    type: 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=',
    subject: walletState.identityKey,
    certifier: '02' + 'bb'.repeat(32),
    serialNumber: 'aa'.repeat(16),
    fields: { handle: 'alice', domain: 'handcash.io' },
    revocationOutpoint: null,
    signature: 'dev-placeholder:deadbeef',
    _dev: true,
  },
}))

const resolveHandle = vi.fn(async () => ({
  handle: 'alice',
  domain: 'handcash.io',
  identityKey: walletState.identityKey,
  certificate: {
    type: 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=',
    subject: walletState.identityKey,
    fields: { handle: 'alice', domain: 'handcash.io' },
    _dev: true,
  },
  display: '@alice@handcash.io',
  messagebox: null,
}))

vi.mock('./handleResolve', () => ({
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
  acquireCertificate.mockClear()
  claimHandle.mockClear()
  resolveHandle.mockClear()
  walletState.identityKey =
    '03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
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
  it('stores the registry certificate even when it is a lab placeholder', async () => {
    const { claimCloudHandlePayload, readClaimedCloudHandle } = await import(
      './handleClaim'
    )
    const state = await claimCloudHandlePayload({
      handle: 'alice',
      claimTicket: 'ticket',
    })

    expect(state.certificate?.fields?.handle).toBe('alice')
    expect(readClaimedCloudHandle()?.certificate?.type).toContain('XgCFd')
    // Placeholder signatures must not be stuffed into listCertificates.
    expect(acquireCertificate).not.toHaveBeenCalled()
  })

  it('acquires a real BRC-52 certificate into the wallet when present', async () => {
    claimHandle.mockResolvedValueOnce({
      display: '@bob@handcash.io',
      certificate: {
        type: 'XgCFdUfxEcI+3xtDjsIuSAjMl5EwzCUjsQc45ds1lC8=',
        subject: walletState.identityKey,
        certifier: '02' + 'cc'.repeat(32),
        serialNumber: 'bb'.repeat(16),
        fields: { handle: 'bob', domain: 'handcash.io' },
        revocationOutpoint: `${'ab'.repeat(32)}.0` as string | null,
        signature: 'a'.repeat(128),
      },
    } as never)

    const { claimCloudHandlePayload } = await import('./handleClaim')
    await claimCloudHandlePayload({ handle: 'bob', claimTicket: 'ticket' })

    expect(acquireCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        acquisitionProtocol: 'direct',
        fields: { handle: 'bob', domain: 'handcash.io' },
      }),
    )
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
      'handcash.brc169.claimedHandle.v1',
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
    expect(state?.certificate?.fields?.handle).toBe('alice')
  })

  it('clears a stale claim when the registry binding moved', async () => {
    store.set(
      'handcash.brc169.claimedHandle.v1',
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
      identityKey: '02' + 'ff'.repeat(32),
      certificate: undefined,
      display: '@alice@handcash.io',
      messagebox: null,
    } as never)

    const { getClaimedCloudHandleVerified, readClaimedCloudHandle } =
      await import('./handleClaim')
    expect(await getClaimedCloudHandleVerified()).toBeNull()
    expect(readClaimedCloudHandle()).toBeNull()
  })
})
