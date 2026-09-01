import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { refreshDependencyHealth } from './dependencyHealth'

describe('dependencyHealth', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('chaintracks')) {
          throw new TypeError('Failed to fetch')
        }
        if (url.includes('bitails')) {
          return new Response('{}', { status: 200 })
        }
        return new Response(null, { status: 404 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks Chaintracks down and Bitails ok', async () => {
    const snap = await refreshDependencyHealth()
    expect(snap.probes.find((p) => p.id === 'chaintracks')?.status).toBe('down')
    expect(snap.probes.find((p) => p.id === 'bitails')?.status).toBe('ok')
    expect(snap.summary).toContain('Chaintracks')
  })
})
