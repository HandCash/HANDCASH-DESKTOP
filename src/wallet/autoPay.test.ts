import { beforeEach, describe, expect, it, vi } from 'vitest'

const durableStore = new Map<string, string>()
const getSpentSatsSince = vi.fn((_origin?: string, _since?: number) => 0)
const getCachedUsdPerBsv = vi.fn((): number | null => 50)
const getSpendingAuthorizationGrant = vi.fn((_origin?: string) => null)

vi.mock('./durableStorage.js', () => ({
  durableGetItem: (key: string) => durableStore.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durableStore.set(key, value)
  },
}))

vi.mock('./appActivity', () => ({
  getSpentSatsSince: (origin?: string, since?: number) => getSpentSatsSince(origin, since),
}))

vi.mock('./appIdentity', () => ({
  normalizeAppHost: (origin?: string) => {
    if (!origin) return 'unknown'
    try {
      return new URL(origin.includes('://') ? origin : `https://${origin}`).host.toLowerCase()
    } catch {
      return origin.toLowerCase()
    }
  },
}))

vi.mock('./fx', () => ({
  getCachedUsdPerBsv: () => getCachedUsdPerBsv(),
  satsToUsd: (sats: number, usdPerBsv: number | null) => {
    if (!usdPerBsv || !Number.isFinite(sats)) return 0
    return (Math.max(0, sats) / 1e8) * usdPerBsv
  },
}))

vi.mock('./spendingAuthorization', () => ({
  getSpendingAuthorizationGrant: (origin?: string) => getSpendingAuthorizationGrant(origin),
  spendingAuthorizationAllowsPayment: () => false,
}))

describe('autoPay', () => {
  beforeEach(() => {
    durableStore.clear()
    getSpentSatsSince.mockReset()
    getSpentSatsSince.mockReturnValue(0)
    getCachedUsdPerBsv.mockReset()
    getCachedUsdPerBsv.mockReturnValue(50)
    getSpendingAuthorizationGrant.mockReset()
    getSpendingAuthorizationGrant.mockReturnValue(null)
    vi.resetModules()
  })

  it('caches maxSats from FX when enabling Auto-pay', async () => {
    const { setAutoPaySettings, getAutoPaySettings } = await import('./autoPay')
    setAutoPaySettings('game.example', { enabled: true, maxUsd: 10, windowHours: 24 })
    const row = getAutoPaySettings('game.example')
    expect(row?.maxUsd).toBe(10)
    // $10 at $50/BSV → 0.2 BSV → 20_000_000 sats
    expect(row?.maxSats).toBe(20_000_000)
  })

  it('allows silent pay via live FX path', async () => {
    const { setAutoPaySettings, canAutoProcessPayment } = await import('./autoPay')
    setAutoPaySettings('game.example', { enabled: true, maxUsd: 10, windowHours: 24 })
    // $1 at $50/BSV
    expect(canAutoProcessPayment('game.example', 'createAction', 2_000_000)).toBe(true)
  })

  it('falls back to cached maxSats when FX is missing', async () => {
    const { setAutoPaySettings, canAutoProcessPayment } = await import('./autoPay')
    setAutoPaySettings('game.example', { enabled: true, maxUsd: 10, windowHours: 24 })
    getCachedUsdPerBsv.mockReturnValue(null)

    expect(canAutoProcessPayment('game.example', 'createAction', 2_000_000)).toBe(true)
    expect(canAutoProcessPayment('game.example', 'createAction', 20_000_001)).toBe(false)

    getSpentSatsSince.mockReturnValue(19_000_000)
    expect(canAutoProcessPayment('game.example', 'createAction', 2_000_000)).toBe(false)
  })

  it('refuses FX-less Auto-pay when no maxSats snapshot exists', async () => {
    const { setAutoPaySettings, canAutoProcessPayment } = await import('./autoPay')
    getCachedUsdPerBsv.mockReturnValue(null)
    setAutoPaySettings('game.example', { enabled: true, maxUsd: 10, windowHours: 24 })
    expect(getCachedUsdPerBsv()).toBe(null)
    const { getAutoPaySettings } = await import('./autoPay')
    expect(getAutoPaySettings('game.example')?.maxSats).toBeUndefined()
    expect(canAutoProcessPayment('game.example', 'createAction', 1_000)).toBe(false)
  })

  it('keeps prior maxSats when re-saving the same USD without FX', async () => {
    const { setAutoPaySettings, getAutoPaySettings } = await import('./autoPay')
    setAutoPaySettings('game.example', { enabled: true, maxUsd: 10, windowHours: 24 })
    expect(getAutoPaySettings('game.example')?.maxSats).toBe(20_000_000)

    getCachedUsdPerBsv.mockReturnValue(null)
    setAutoPaySettings('game.example', { enabled: true, maxUsd: 10, windowHours: 12 })
    expect(getAutoPaySettings('game.example')?.maxSats).toBe(20_000_000)
    expect(getAutoPaySettings('game.example')?.windowHours).toBe(12)
  })
})
