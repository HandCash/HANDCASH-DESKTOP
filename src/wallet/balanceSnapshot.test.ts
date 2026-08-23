import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durable.set(key, value)
    return true
  },
}))

const {
  readTrustedBalance,
  shouldKeepDisplayBalanceOnConfirmedRead,
  shouldKeepTrustedBalance,
  writeTrustedBalance,
} = await import('./balanceSnapshot')

describe('cold-start trusted balance', () => {
  beforeEach(() => durable.clear())

  it('restores the last successfully read balance for the same identity', () => {
    writeTrustedBalance('identity-a', 'main', 710_091)

    expect(readTrustedBalance('identity-a', 'main')).toBe(710_091)
  })

  it('never paints another identity or chain balance', () => {
    writeTrustedBalance('identity-a', 'main', 710_091)

    expect(readTrustedBalance('identity-b', 'main')).toBeNull()
    expect(readTrustedBalance('identity-a', 'test')).toBeNull()
  })

  it('rejects malformed or unsafe cached values', () => {
    writeTrustedBalance('identity-a', 'main', -1)
    expect(readTrustedBalance('identity-a', 'main')).toBeNull()

    durable.set(
      'handcash.balance.lastTrusted',
      JSON.stringify({ identityKey: 'identity-a', chain: 'main', sats: 1.5 }),
    )
    expect(readTrustedBalance('identity-a', 'main')).toBeNull()
  })

  it('keeps a funded snapshot across a provisional empty recompose read only', () => {
    expect(shouldKeepTrustedBalance(710_091, 0, true)).toBe(true)
    expect(shouldKeepTrustedBalance(710_091, 0, false)).toBe(false)
    expect(shouldKeepTrustedBalance(710_091, 500_000, true)).toBe(false)
    expect(shouldKeepTrustedBalance(0, 0, true)).toBe(false)
  })

  it('blocks confirmed-only reads from downgrading a higher display balance', () => {
    expect(shouldKeepDisplayBalanceOnConfirmedRead(15_000, 3_000)).toBe(true)
    expect(shouldKeepDisplayBalanceOnConfirmedRead(15_000, 15_000)).toBe(false)
    expect(shouldKeepDisplayBalanceOnConfirmedRead(15_000, 20_000)).toBe(false)
    expect(shouldKeepDisplayBalanceOnConfirmedRead(0, 0)).toBe(false)
  })
})
