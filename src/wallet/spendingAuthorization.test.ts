import { beforeEach, describe, expect, it, vi } from 'vitest'

const durableStore = new Map<string, string>()
const getSpentSatsSince = vi.fn((_origin?: string, _since?: number) => 0)

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

describe('spendingAuthorization', () => {
  beforeEach(() => {
    durableStore.clear()
    getSpentSatsSince.mockReset()
    getSpentSatsSince.mockReturnValue(0)
  })

  it('parses metanet and babbage groupPermissions', async () => {
    const { parseSpendingAuthorizationFromManifest } = await import('./spendingAuthorization')
    expect(
      parseSpendingAuthorizationFromManifest({
        metanet: {
          schemaVersion: 1,
          groupPermissions: {
            spendingAuthorization: {
              amount: 50_000,
              description: 'Plinko bets',
            },
          },
        },
      }),
    ).toEqual({ amountSats: 50_000, description: 'Plinko bets' })

    expect(
      parseSpendingAuthorizationFromManifest({
        babbage: {
          groupPermissions: {
            spendingAuthorization: { amount: 1000, description: 'legacy' },
          },
        },
      }),
    ).toEqual({ amountSats: 1000, description: 'legacy' })
  })

  it('enforces a calendar-month satoshis cap', async () => {
    const {
      grantSpendingAuthorization,
      spendingAuthorizationAllowsPayment,
      startOfUtcMonth,
    } = await import('./spendingAuthorization')

    grantSpendingAuthorization('https://plinko.example', {
      amountSats: 10_000,
      description: 'bets',
    })

    getSpentSatsSince.mockImplementation((_o, since) => {
      expect(since).toBe(startOfUtcMonth())
      return 9_000
    })
    expect(spendingAuthorizationAllowsPayment('plinko.example', 500)).toBe(true)
    expect(spendingAuthorizationAllowsPayment('plinko.example', 1_500)).toBe(false)
  })

  it('clears grants on disconnect', async () => {
    const {
      grantSpendingAuthorization,
      getSpendingAuthorizationGrant,
      clearSpendingAuthorization,
    } = await import('./spendingAuthorization')
    grantSpendingAuthorization('app.example', { amountSats: 100, description: '' })
    expect(getSpendingAuthorizationGrant('app.example')?.amountSats).toBe(100)
    clearSpendingAuthorization('app.example')
    expect(getSpendingAuthorizationGrant('app.example')).toBeNull()
  })
})
