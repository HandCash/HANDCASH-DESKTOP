import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveHandle, resolveHandleByIdentityKey } from './handleResolve'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveHandle messagebox', () => {
  it('persists the messagebox URL from a BRC-169 resolve response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            handle: 'alice',
            domain: 'handcash.io',
            identityKey: '02' + 'ab'.repeat(32),
            certificate: { type: 'test' },
            messagebox: 'https://mb.alice.example/v1/messagebox/',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const resolved = await resolveHandle('$alice')
    expect(resolved.messagebox).toBe('https://mb.alice.example/v1/messagebox')
    expect(resolved.identityKey).toMatch(/^02/)
  })

  it('returns null messagebox when the resolve host omits it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            handle: 'bob',
            domain: 'handcash.io',
            identityKey: '03' + 'cd'.repeat(32),
            certificate: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const resolved = await resolveHandle('$bob')
    expect(resolved.messagebox).toBeNull()
  })
})

describe('resolveHandleByIdentityKey', () => {
  it('asks resolve with identityKey — not a forged handle query', async () => {
    const key = '02' + 'ab'.repeat(32)
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain(`identityKey=${encodeURIComponent(key)}`)
      expect(String(url)).not.toContain('handle=')
      return new Response(
        JSON.stringify({
          handle: 'alice',
          domain: 'handcash.io',
          identityKey: key,
          certificate: { type: 'test' },
          messagebox: 'https://mb.example/v1/messagebox',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await resolveHandleByIdentityKey(key)
    expect(results).toHaveLength(1)
    expect(results[0]?.handle).toBe('alice')
    expect(results[0]?.display).toBe('@alice@handcash.io')
  })

  it('returns an empty list when the registry has no binding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    )
    await expect(
      resolveHandleByIdentityKey('03' + 'cd'.repeat(32)),
    ).resolves.toEqual([])
  })

  it('expands a multi-handle reverse response', async () => {
    const key = '02' + 'ee'.repeat(32)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            metanetHandles: '1.0',
            identityKey: key,
            handles: [
              {
                handle: 'one',
                domain: 'handcash.io',
                identityKey: key,
                certificate: {},
              },
              {
                handle: 'two',
                domain: 'handcash.io',
                identityKey: key,
                certificate: {},
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const results = await resolveHandleByIdentityKey(key)
    expect(results.map((r) => r.handle)).toEqual(['one', 'two'])
  })

  it('refuses a malformed identity key without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveHandleByIdentityKey('nope')).rejects.toThrow(/identity key/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
