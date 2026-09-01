import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./session', () => ({
  getActiveWallet: vi.fn(() => ({
    wallet: {},
  })),
  fetchBalanceRead: vi.fn(async (_w: unknown, opts?: { creditUnconfirmed?: boolean }) =>
    opts?.creditUnconfirmed === false
      ? { kind: 'ok', sats: 2 }
      : { kind: 'ok', sats: 162769 },
  ),
}))

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
}))

describe('diagnosticLog', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('writes structured spend snapshots to the ring buffer', async () => {
    const { logSpendSnapshot } = await import('./diagnosticLog')
    const appLog = await import('./appLog')

    await logSpendSnapshot('test-gate', { needed: 1000 })

    const lines = appLog.getAppLogs().map((e) => e.message)
    expect(lines.some((line) => line.includes('[spend] test-gate'))).toBe(true)
    expect(lines.some((line) => line.includes('spendable=2'))).toBe(true)
    expect(lines.some((line) => line.includes('pendingChange=162767'))).toBe(true)
  })

  it('logs BRC-100 failures with origin host and code', async () => {
    const { logBrc100Response } = await import('./diagnosticLog')
    const appLog = await import('./appLog')

    logBrc100Response(
      'createAction',
      'https://market.handcash.io',
      {
        status: 400,
        body: JSON.stringify({
          status: 'error',
          code: 'INSUFFICIENT_OR_STALE_FUNDS',
          description: 'Not enough spendable balance',
        }),
      },
      42,
      { outputs: [{ satoshis: 5000 }] },
    )

    const line = appLog.getAppLogs().find((e) => e.message.includes('[brc100] failed'))
    expect(line?.message).toContain('method=createAction')
    expect(line?.message).toContain('origin=market.handcash.io')
    expect(line?.message).toContain('code=INSUFFICIENT_OR_STALE_FUNDS')
    expect(line?.message).toContain('sats=5000')
  })
})
