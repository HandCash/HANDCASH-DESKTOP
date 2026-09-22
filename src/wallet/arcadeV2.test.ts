import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ARCADE_V2_DEV_PROXY_MAIN,
  ARCADE_V2_DEV_PROXY_TEST,
  arcadeV2BaseUrl,
  classifyArcadeTxStatus,
  fetchArcadeTxFate,
  stripArcadeCorsForbiddenHeaders,
} from './arcadeV2'

describe('arcadeV2BaseUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses Vite dev proxy paths in DEV', () => {
    expect(arcadeV2BaseUrl('main')).toBe(ARCADE_V2_DEV_PROXY_MAIN)
    expect(arcadeV2BaseUrl('test')).toBe(ARCADE_V2_DEV_PROXY_TEST)
    expect(arcadeV2BaseUrl('reg')).toBeNull()
  })
})

describe('stripArcadeCorsForbiddenHeaders', () => {
  it('drops XDeployment-ID so Arcade preflight from localhost succeeds', () => {
    expect(
      stripArcadeCorsForbiddenHeaders({
        'Content-Type': 'application/json',
        'XDeployment-ID': 'abc',
        'X-CallbackToken': 'tok',
      }),
    ).toEqual({
      'Content-Type': 'application/json',
      'X-CallbackToken': 'tok',
    })
  })
})

describe('classifyArcadeTxStatus', () => {
  it.each([
    'RECEIVED',
    'STORED',
    'ACCEPTED',
    'ANNOUNCED_TO_NETWORK',
    'ACCEPTED_BY_NETWORK',
    'SEEN_ON_NETWORK',
    'SEEN_MULTIPLE_NODES',
    'IMMUTABLE',
    'MINED',
  ])('treats Arcade propagation status %s as accepted', (txStatus) => {
    expect(classifyArcadeTxStatus({ txStatus })).toEqual({
      kind: 'accepted',
      status: txStatus,
    })
  })

  it('treats parent rejection as an authoritative SPV failure', () => {
    expect(
      classifyArcadeTxStatus({
        txStatus: 'REJECTED',
        extraInfo: 'parent rejected (ancestor abc)',
      }),
    ).toEqual({
      kind: 'rejected',
      status: 'REJECTED',
      reason: 'parent rejected (ancestor abc)',
    })
  })

  it('keeps an explicitly retryable parent rejection out of the hard-reject path', () => {
    const ancestor = 'ab'.repeat(32)
    expect(
      classifyArcadeTxStatus({
        txStatus: 'REJECTED',
        extraInfo: `parent rejected (ancestor ${ancestor}): retryable — resubmit`,
      }),
    ).toEqual({
      kind: 'retryable',
      status: 'REJECTED',
      reason: `parent rejected (ancestor ${ancestor}): retryable — resubmit`,
      ancestorTxid: ancestor,
    })
  })

  it('resolves a retryable parent chain to its hard-rejected root', async () => {
    const child = '11'.repeat(32)
    const parent = '22'.repeat(32)
    const root = '33'.repeat(32)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const txid = String(url).split('/').at(-1)
      const body =
        txid === child
          ? {
              txStatus: 'REJECTED',
              extraInfo: `parent rejected (ancestor ${parent}): retryable — resubmit`,
            }
          : txid === parent
            ? {
                txStatus: 'REJECTED',
                extraInfo: `parent rejected (ancestor ${root}): retryable — resubmit`,
              }
            : {
                txStatus: 'REJECTED',
                extraInfo: 'UTXO_SPENT: already spent',
              }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    try {
      const fate = await fetchArcadeTxFate('main', child)
      expect(fate.kind).toBe('rejected')
      expect(fate.kind === 'rejected' && fate.reason).toContain(root)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('does not turn an unknown response into a failure', () => {
    expect(classifyArcadeTxStatus({ txStatus: 'UNKNOWN' })).toEqual({
      kind: 'unknown',
    })
    expect(classifyArcadeTxStatus(null)).toEqual({ kind: 'unknown' })
  })
})
