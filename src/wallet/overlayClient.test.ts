import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SLAP_TRACKERS,
  discoverSlapHosts,
  hostProvidesLookupService,
  postOverlayLookup,
  queryOverlayWithFailover,
  resolveOverlayLookupHosts,
} from './overlayClient'

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`
    const body =
      init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null
    if (routes[key]) {
      return new Response(JSON.stringify(routes[key]), { status: 200 })
    }
    if (method === 'POST' && url.endsWith('/lookup')) {
      const service = body?.service
      if (service === 'ls_slap') {
        return new Response(
          JSON.stringify({
            type: 'output-list',
            outputs: [
              {
                outputIndex: 0,
                context: 'https://overlay.example',
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (service === 'ls_demo') {
        return new Response(
          JSON.stringify({
            type: 'output-list',
            outputs: [{ outputIndex: 0, beef: [1, 2, 3] }],
          }),
          { status: 200 },
        )
      }
    }
    if (url.endsWith('/listLookupServiceProviders')) {
      return new Response(JSON.stringify(['ls_demo']), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

describe('overlayClient', () => {
  it('discovers hosts from SLAP trackers', async () => {
    const fetchImpl = mockFetch({})
    const hosts = await discoverSlapHosts('ls_demo', fetchImpl, [DEFAULT_SLAP_TRACKERS[0]!])
    expect(hosts).toContain('https://overlay.example')
  })

  it('checks listLookupServiceProviders', async () => {
    const fetchImpl = mockFetch({})
    const ok = await hostProvidesLookupService('https://overlay.example', 'ls_demo', fetchImpl)
    expect(ok).toBe(true)
  })

  it('failovers across hosts until lookup succeeds', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/listLookupServiceProviders')) {
        return new Response(JSON.stringify(['ls_demo']), { status: 200 })
      }
      if (url.includes('bad.example')) {
        return new Response('fail', { status: 503 })
      }
      if (url.endsWith('/lookup') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ type: 'output-list', outputs: [] }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const hosts = await resolveOverlayLookupHosts(
      {
        lookupService: 'ls_demo',
        overlayBaseUrl: 'https://bad.example',
        extraHosts: ['https://good.example'],
        discovery: 'auto',
      },
      fetchImpl,
    )
    expect(hosts.length).toBeGreaterThan(0)

    const result = await queryOverlayWithFailover(
      {
        lookupService: 'ls_demo',
        overlayBaseUrl: 'https://bad.example',
        extraHosts: ['https://good.example'],
        discovery: 'url',
      },
      fetchImpl,
    )
    expect(result.host).toBe('https://good.example')
    expect(result.answer.type).toBe('output-list')
  })

  it('postOverlayLookup throws on HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as typeof fetch
    await expect(
      postOverlayLookup('https://overlay.example', 'ls_demo', {}, fetchImpl),
    ).rejects.toThrow(/failed/i)
  })
})
