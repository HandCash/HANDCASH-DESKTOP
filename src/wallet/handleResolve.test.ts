import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HandleNotFoundError,
  shouldResolveHandleInput,
  createHandleResolveDebouncer,
  resolveHandle,
  resolveHandleByIdentityKey,
  claimHandle,
} from './handleResolve'
import { HandleCertificateError } from './handleCertificate'
import {
  signedHandleCertificate,
  testIdentityKey,
  useTestHandleCertifier,
} from './handleCertificate.fixture'

useTestHandleCertifier()

const KEY_A = testIdentityKey(11)
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

const KEY_A_ROOT = '0'.repeat(62) + '0b'

/** Answers the challenge route with a fresh challenge and the claim route with `claimBody`. */
function answerClaim(claimBody: unknown) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const body = url.endsWith('/v1/claim/challenge')
      ? { handle: 'alice', identityKey: KEY_A, challenge: 'c'.repeat(64), expiresAt: Date.now() + 120_000 }
      : claimBody
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('claimHandle', () => {
  it('returns the verified certificate and refuses one for another key', async () => {
    answerClaim({ ...(await row('alice', KEY_A)), display: '@alice@brc-cloud.bcryderman.workers.dev' })
    const claimed = await claimHandle({ handle: 'alice', identityKey: KEY_A, rootKeyHex: KEY_A_ROOT })
    expect(claimed.certificate.subject).toBe(KEY_A)

    answerClaim({ ...(await row('alice', KEY_B)) })
    await expect(
      claimHandle({ handle: 'alice', identityKey: KEY_A, rootKeyHex: KEY_A_ROOT }),
    ).rejects.toThrow(/different identity key/)
  })

  it('fetches a fresh challenge per attempt and signs the claim without a ticket', async () => {
    const fetchMock = answerClaim(await row('alice', KEY_A))
    await claimHandle({ handle: 'alice', identityKey: KEY_A, rootKeyHex: KEY_A_ROOT })
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.endsWith('/v1/claim/challenge'))).toHaveLength(1)
    const claim = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v1/claim'))
    const sent = JSON.parse(String((claim?.[1] as RequestInit).body))
    expect(sent).toEqual({ handle: 'alice', identityKey: KEY_A, challenge: 'c'.repeat(64) })
    expect(sent).not.toHaveProperty('claimTicket')
    expect(new Headers((claim?.[1] as RequestInit).headers).get('X-HandCash-Request-Signature')).toBeTruthy()
  })
})
