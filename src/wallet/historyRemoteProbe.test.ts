import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>()
vi.mock('./identityRequestAuth', () => ({ signedIdentityFetch: (...args: unknown[]) => fetchMock(...args) }))
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import {
  holdHistoryHost,
  probeRemoteBrc39,
  releaseHistoryHost,
  resetHistoryRemoteProbeForTests,
  retryAfterMs,
} from './historyRemoteProbe'

const URL_A = 'https://box.test/v1/wallets/02aa/wallet.brc39'
const KEY = '11'.repeat(32)

function reply(status: number, headers: Record<string, string> = {}, body = ''): Response {
  return new Response(status === 204 || status === 404 ? null : body, { status, headers })
}

describe('probeRemoteBrc39', () => {
  beforeEach(() => {
    resetHistoryRemoteProbeForTests()
    fetchMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('maps present / absent / refused', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {
      ETag: '"e1"', 'X-HandCash-Exported-At': '1700', 'Content-Length': '0', 'X-HandCash-Spendable-Sats': '42',
    }))
    expect(await probeRemoteBrc39(KEY, URL_A)).toEqual({
      kind: 'present', etag: '"e1"', exportedAt: 1700, bytes: 0, spendableSats: 42, actionCount: null,
    })
    fetchMock.mockResolvedValueOnce(reply(404))
    expect(await probeRemoteBrc39(KEY, URL_A)).toEqual({ kind: 'absent' })
    fetchMock.mockResolvedValueOnce(reply(401, {}, '{"error":"auth-invalid"}'))
    expect(await probeRemoteBrc39(KEY, URL_A)).toEqual({ kind: 'refused', status: 401, reason: 'auth-invalid' })
  })

  it('shares one request between concurrent callers', async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r }))
    const all = Promise.all([probeRemoteBrc39(KEY, URL_A), probeRemoteBrc39(KEY, URL_A), probeRemoteBrc39(KEY, URL_A)])
    resolve(reply(404))
    expect((await all).map((h) => h.kind)).toEqual(['absent', 'absent', 'absent'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a 5xx holds every caller until Retry-After, without network', async () => {
    const now = Date.UTC(2026, 9, 5, 18, 0, 0)
    fetchMock.mockResolvedValueOnce(reply(503, { 'Retry-After': '120' }, '{"error":{"code":"store-unavailable"}}'))
    const first = await probeRemoteBrc39(KEY, URL_A, undefined, now)
    expect(first).toMatchObject({ kind: 'unavailable', status: 503, reason: 'store-unavailable' })
    expect(first.kind === 'unavailable' && first.retryAt).toBeGreaterThanOrEqual(now + 120_000)
    for (let i = 0; i < 50; i++) {
      expect((await probeRemoteBrc39(KEY, URL_A, undefined, now + 1000 + i)).kind).toBe('unavailable')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValueOnce(reply(404))
    expect((await probeRemoteBrc39(KEY, URL_A, undefined, now + 121_000)).kind).toBe('absent')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially without Retry-After and caps a far-off Retry-After', async () => {
    vi.useFakeTimers()
    const t0 = Date.UTC(2026, 9, 5, 18, 0, 0)
    vi.setSystemTime(t0)
    const a = holdHistoryHost(URL_A, 500, null, 'internal', t0)
    const b = holdHistoryHost(URL_A, 500, null, 'internal', t0)
    const c = holdHistoryHost(URL_A, 500, null, 'internal', t0)
    expect([a, b, c].map((h) => (h.kind === 'unavailable' ? h.retryAt - t0 : 0))).toEqual([30_000, 60_000, 120_000])
    const quota = holdHistoryHost(URL_A, 503, String(5 * 3600), 'store-unavailable', t0)
    expect(quota.kind === 'unavailable' && quota.retryAt - t0).toBe(60 * 60_000)
    releaseHistoryHost(URL_A)
    fetchMock.mockResolvedValueOnce(reply(404))
    expect((await probeRemoteBrc39(KEY, URL_A, undefined, t0 + 1)).kind).toBe('absent')
  })

  it('a network failure is unavailable, not refused', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await probeRemoteBrc39(KEY, URL_A)).toMatchObject({ kind: 'unavailable', status: null, reason: 'Failed to fetch' })
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(retryAfterMs('30')).toBe(30_000)
    const now = Date.UTC(2026, 9, 5, 18, 0, 0)
    expect(retryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000)
    expect(retryAfterMs(null)).toBeNull()
    expect(retryAfterMs('soon')).toBeNull()
  })
})
