import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveHandle } from './handleResolve'

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
