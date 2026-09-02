import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { refreshDependencyHealth } from './dependencyHealth'

vi.mock('./runtimePlatform', () => ({
  isViteDevBrowser: vi.fn(() => false),
}))

describe('dependencyHealth', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/v1/chain/health')) {
          return new Response(
            JSON.stringify({
              ok: true,
              upstream: [
                { id: 'kallubi', ok: true, latencyMs: 42 },
                { id: 'arcade-v2', ok: true, latencyMs: 55 },
              ],
            }),
            { status: 200 },
          )
        }
        if (
          url.includes('bitails') ||
          url.includes('bsvblockchain.tech') ||
          url.includes('bananablocks.com') ||
          url.includes('bsv.cx/a/')
        ) {
          return new Response('{}', { status: 200 })
        }
        return new Response(null, { status: 404 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks HandCash Chain ok and Bitails ok', async () => {
    const snap = await refreshDependencyHealth()
    expect(snap.probes.find((p) => p.id === 'handcash-chain')?.status).toBe('ok')
    expect(snap.probes.find((p) => p.id === 'bitails')?.status).toBe('ok')
    expect(snap.summary).toBe('All OK')
  })

  it('flags alert when a probe is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/v1/chain/health')) {
          throw new TypeError('Failed to fetch')
        }
        if (
          url.includes('bitails') ||
          url.includes('bsvblockchain.tech') ||
          url.includes('bananablocks.com') ||
          url.includes('bsv.cx/a/')
        ) {
          return new Response('{}', { status: 200 })
        }
        return new Response(null, { status: 404 })
      }),
    )
    const snap = await refreshDependencyHealth()
    expect(snap.probes.find((p) => p.id === 'handcash-chain')?.label).toBe('HandCash Chain')
    expect(snap.probes.find((p) => p.id === 'handcash-chain')?.status).toBe('down')
    expect(snap.summary).toBe('HandCash Chain down')
    const { dependencyHealthAlert } = await import('./dependencyHealth')
    expect(dependencyHealthAlert(snap)).toBe('error')
  })

  it('derives Kallubi status from HandCash Chain health in Vite dev browser', async () => {
    const { isViteDevBrowser } = await import('./runtimePlatform')
    vi.mocked(isViteDevBrowser).mockReturnValue(true)

    const snap = await refreshDependencyHealth()
    expect(snap.probes.find((p) => p.id === 'kallubi')?.status).toBe('ok')
    expect(snap.probes.find((p) => p.id === 'kallubi')?.detail).toBe('42ms')
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('bsv.cx/a/'),
      expect.anything(),
    )
  })
})
