import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HandleNotFoundError,
  HandleRevokedError,
  shouldResolveHandleInput,
  createHandleResolveDebouncer,
  resolveHandle,
  resolveHandleByIdentityKey,
  claimHandle,
  releaseHandle,
} from './handleResolve'
import { HandleCertificateError } from './handleCertificate'
import { signForwardingRecord } from './handleForwarding'
import {
  signedHandleCertificate,
  testIdentityKey,
  useTestHandleCertifier,
} from './handleCertificate.fixture'

useTestHandleCertifier()

const KEY_A = testIdentityKey(11)
const ROOT_A = (11).toString(16).padStart(64, '0')
const KEY_B = testIdentityKey(12)

async function row(handle: string, identityKey: string, extra: Record<string, unknown> = {}) {
  return {
    handle,
    domain: 'brc-cloud.bcryderman.workers.dev',
    identityKey,
    certificate: await signedHandleCertificate(handle, identityKey),
    ...extra,
  }
}

function answerWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shouldResolveHandleInput', () => {
  it('waits until the local-part is at least three characters', () => {
    expect(shouldResolveHandleInput('s')).toBe(false)
    expect(shouldResolveHandleInput('si')).toBe(false)
    expect(shouldResolveHandleInput('$s')).toBe(false)
    expect(shouldResolveHandleInput('sam')).toBe(true)
    expect(shouldResolveHandleInput('$sam')).toBe(true)
  })
})

describe('createHandleResolveDebouncer', () => {
  it('debounces resolve calls', async () => {
    const fetchMock = answerWith(await row('samy', KEY_A))
    vi.useFakeTimers()
    try {
      const debouncer = createHandleResolveDebouncer(200)
      const resolved: string[] = []
      debouncer.schedule('$sam', { onResolved: (r) => resolved.push(r.handle), onError: () => {} })
      debouncer.schedule('$samy', { onResolved: (r) => resolved.push(r.handle), onError: () => {} })
      expect(fetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toContain('handle=samy')
      await vi.waitFor(() => expect(resolved).toEqual(['samy']))
      debouncer.cancel()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a late answer once the input became too short to resolve', async () => {
    vi.useFakeTimers()
    try {
      let answer!: (r: Awaited<ReturnType<typeof resolveHandle>>) => void
      const resolve = vi.fn(() => new Promise<Awaited<ReturnType<typeof resolveHandle>>>((r) => (answer = r)))
      const debouncer = createHandleResolveDebouncer(200, resolve)
      const resolved: string[] = []
      debouncer.schedule('$alice', { onResolved: (r) => resolved.push(r.handle), onError: () => {} })
      await vi.advanceTimersByTimeAsync(200)
      expect(resolve).toHaveBeenCalledTimes(1)
      debouncer.schedule('$a', { onResolved: (r) => resolved.push(r.handle), onError: () => {} })
      answer({ handle: 'alice' } as Awaited<ReturnType<typeof resolveHandle>>)
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resolveHandle answers only for what was asked', () => {
  it('refuses a key for another domain or another handle', async () => {
    answerWith(await row('alice', KEY_A))
    await expect(resolveHandle('alice@lkup.net')).rejects.toThrow(/not served by this resolver/)
    await expect(resolveHandle('@alice@handcash.io')).rejects.toThrow(/Handles on handcash\.io are not served/)
    await expect(resolveHandle('$bob')).rejects.toThrow(/different handle/)
    await expect(resolveHandle('@alice@brc-cloud.bcryderman.workers.dev')).resolves.toMatchObject({ identityKey: KEY_A })
    await expect(resolveHandle('$alice')).resolves.toMatchObject({ identityKey: KEY_A })
  })

  it('tells an answered not-found apart from an unreachable host', async () => {
    answerWith({ error: 'not found' }, 404)
    await expect(resolveHandle('$alice')).rejects.toBeInstanceOf(HandleNotFoundError)
    answerWith({ error: 'boom' }, 503)
    await expect(resolveHandle('$alice')).rejects.not.toBeInstanceOf(HandleNotFoundError)
  })

  it('fails closed on a placeholder, a swapped key, or a missing certificate', async () => {
    answerWith({ ...(await row('alice', KEY_A)), certificate: { _dev: true, signature: 'dev-placeholder:1' } })
    await expect(resolveHandle('$alice')).rejects.toBeInstanceOf(HandleCertificateError)

    // A resolver that rebinds alice to its own key cannot reuse alice's certificate.
    answerWith({ ...(await row('alice', KEY_A)), identityKey: KEY_B })
    await expect(resolveHandle('$alice')).rejects.toMatchObject({ reason: 'subject-mismatch' })

    answerWith({ handle: 'alice', domain: 'brc-cloud.bcryderman.workers.dev', identityKey: KEY_A })
    await expect(resolveHandle('$alice')).rejects.toMatchObject({ reason: 'missing' })
  })
})

describe('resolveHandle messagebox', () => {
  it('uses the Vite same-origin proxy when the configured base URL is empty', async () => {
    const fetchMock = answerWith(await row('alice', KEY_A))
    await resolveHandle('$alice', '')
    expect(fetchMock).toHaveBeenCalledWith(
      '/.well-known/metanet-handles/resolve?handle=alice',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('persists the messagebox URL from a BRC-169 resolve response', async () => {
    answerWith(await row('alice', KEY_A, { messagebox: 'https://mb.alice.example/v1/messagebox/' }))
    const resolved = await resolveHandle('$alice')
    expect(resolved.messagebox).toBe('https://mb.alice.example/v1/messagebox')
    expect(resolved.identityKey).toBe(KEY_A)
  })

  it('returns null messagebox when the resolve host omits it', async () => {
    answerWith(await row('bob', KEY_B))
    const resolved = await resolveHandle('$bob')
    expect(resolved.messagebox).toBeNull()
  })
})

describe('resolveHandleByIdentityKey', () => {
  it('asks resolve with identityKey — not a forged handle query', async () => {
    const fetchMock = answerWith(await row('alice', KEY_A, { messagebox: 'https://mb.example/v1/messagebox' }))
    const results = await resolveHandleByIdentityKey(KEY_A)
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain(`identityKey=${encodeURIComponent(KEY_A)}`)
    expect(url).not.toContain('handle=')
    expect(results).toHaveLength(1)
    expect(results[0]?.handle).toBe('alice')
    expect(results[0]?.display).toBe('@alice@brc-cloud.bcryderman.workers.dev')
  })

  it('returns an empty list when the registry has no binding', async () => {
    answerWith({}, 404)
    await expect(resolveHandleByIdentityKey(KEY_B)).resolves.toEqual([])
  })

  it('keeps only certified handles bound to the asked key', async () => {
    answerWith({
      metanetHandles: '1.0',
      identityKey: KEY_A,
      handles: [
        await row('one', KEY_A),
        await row('two', KEY_A),
        { ...(await row('three', KEY_A)), certificate: { _dev: true } },
        await row('four', KEY_B),
      ],
    })
    const results = await resolveHandleByIdentityKey(KEY_A)
    expect(results.map((r) => r.handle)).toEqual(['one', 'two'])
  })

  it('refuses a malformed identity key without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveHandleByIdentityKey('nope')).rejects.toThrow(/identity key/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('claimHandle', () => {
  it('returns the verified certificate and refuses one for another key', async () => {
    answerWith({ ...(await row('alice', KEY_A)), display: '@alice@brc-cloud.bcryderman.workers.dev' })
    const claimed = await claimHandle({ handle: 'alice', identityKey: KEY_A, rootKeyHex: ROOT_A, claimTicket: 't' })
    expect(claimed.certificate.subject).toBe(KEY_A)

    answerWith({ ...(await row('alice', KEY_B)) })
    await expect(
      claimHandle({ handle: 'alice', identityKey: KEY_A, rootKeyHex: ROOT_A, claimTicket: 't' }),
    ).rejects.toThrow(/different identity key/)
  })

  it('signs the claim with the key it binds', async () => {
    const fetchMock = answerWith({ ...(await row('alice', KEY_A)) })
    await claimHandle({ handle: 'alice', identityKey: KEY_A, rootKeyHex: ROOT_A, claimTicket: 't' })
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers)
    expect(headers.get('X-HandCash-Identity')).toBe(KEY_A)
    expect(headers.get('X-HandCash-Request-Signature')).toBeTruthy()
  })
})

describe('release and forwarding', () => {
  const from = '@alice@brc-cloud.bcryderman.workers.dev'

  it('carries the forwarding record of a released handle, only for the asked handle', async () => {
    const forwarding = signForwardingRecord(ROOT_A, {
      from,
      toIdentityKey: KEY_B,
      toHandle: '@alice@other.example',
    })
    answerWith({ error: { code: 'handle-revoked' }, revoked: true, forwarding }, 410)
    const err = await resolveHandle('$alice').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HandleRevokedError)
    expect(err).toBeInstanceOf(HandleNotFoundError)
    expect((err as HandleRevokedError).forwarding).toEqual(forwarding)

    answerWith({ revoked: true, forwarding }, 410)
    expect(((await resolveHandle('$bob').catch((e: unknown) => e)) as HandleRevokedError).forwarding).toBeNull()
  })

  it('releases with a signed request', async () => {
    const forwarding = signForwardingRecord(ROOT_A, { from, toIdentityKey: KEY_B, toHandle: '@bob@other.example' })
    const fetchMock = answerWith({ released: true, forwarding })
    const out = await releaseHandle({ handle: 'alice', rootKeyHex: ROOT_A, forwarding })
    expect(out.forwarding).toEqual(forwarding)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toMatch(/\/v1\/handles\/release$/)
    expect(new Headers(init!.headers).get('X-HandCash-Identity')).toBe(KEY_A)
    expect(JSON.parse(String(init!.body))).toEqual({ handle: 'alice', forwarding })

    answerWith({ error: { code: 'handle-not-found' } }, 404)
    await expect(releaseHandle({ handle: 'alice', rootKeyHex: ROOT_A })).rejects.toThrow(/handle-not-found/)
  })
})

describe('revocation outpoints', () => {
  const outpoint = `${'ab'.repeat(32)}.1`

  async function answerResolveThenSpent(status: string | null) {
    const body = {
      ...(await row('alice', KEY_A)),
      certificate: await signedHandleCertificate('alice', KEY_A, undefined, undefined, outpoint),
    }
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/v1/chain/spent/')
        ? status == null
          ? new Response('down', { status: 503 })
          : new Response(JSON.stringify({ status }), { status: 200 })
        : new Response(JSON.stringify(body), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('trusts an unspent outpoint and refuses a spent one', async () => {
    const fetchMock = await answerResolveThenSpent('unspent')
    expect((await resolveHandle('$alice')).identityKey).toBe(KEY_A)
    expect(fetchMock.mock.calls.some(([u]) => u.includes(`/v1/chain/spent/${'ab'.repeat(32)}/1`))).toBe(true)

    await answerResolveThenSpent('spent')
    await expect(resolveHandle('$alice')).rejects.toBeInstanceOf(HandleRevokedError)
  })

  it('does not take an unreadable status as valid, nor clear the claim over it', async () => {
    await answerResolveThenSpent(null)
    const err = await resolveHandle('$alice').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(HandleNotFoundError)
    expect(String(err)).toMatch(/Could not check whether/)
  })

  it('skips the chain for the null outpoint', async () => {
    const fetchMock = answerWith(await row('alice', KEY_A))
    await resolveHandle('$alice')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
