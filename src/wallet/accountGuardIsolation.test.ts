/**
 * Two vault accounts on one device do not share a basket, so they must not
 * share the marks that hide outpoints from a basket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./marketListing', () => ({
  invalidateMarketListingsForSpentOutpoints: () => {},
}))

const TIP = `${'9d'.repeat(32)}.0`

describe('per-account outpoint guards', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('does not hide the payee tip from the account that received it', async () => {
    const { bindAccountLocalKeyScope } = await import('./accountLocalKeys')
    const { isItemSent, markItemsSent, rebindSentItemGuardForAccount } =
      await import('./sentItemGuard')

    // Account 0 sends to account 1 on the same device.
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'ik-sender' })
    rebindSentItemGuardForAccount()
    markItemsSent([{ outpoint: TIP, txid: '9d'.repeat(32) }])
    expect(isItemSent(TIP)).toBe(true)

    bindAccountLocalKeyScope({ accountIndex: 1, identityKey: 'ik-payee' })
    rebindSentItemGuardForAccount()
    expect(isItemSent(TIP)).toBe(false)

    // The sender still hides its own spent tip.
    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'ik-sender' })
    rebindSentItemGuardForAccount()
    expect(isItemSent(TIP)).toBe(true)
  })

  /**
   * Wallets upgraded from a build that wrote these marks device-wide still
   * carry the other account's marks under the primary account's key.
   */
  it('forgets a stale hide mark for a tip this account internalizes', async () => {
    const { isItemSent, markItemsSent, forgetItemsSent } = await import(
      './sentItemGuard'
    )
    markItemsSent([{ outpoint: TIP, txid: '9d'.repeat(32) }])
    expect(isItemSent(TIP)).toBe(true)

    forgetItemsSent([TIP])
    expect(isItemSent(TIP)).toBe(false)
  })

  it('lets the receiving account internalize an outpoint the sender imported', async () => {
    const { bindAccountLocalKeyScope } = await import('./accountLocalKeys')
    const {
      beginOneSatImport,
      markOneSatImported,
      rebindOneSatImportGuardForAccount,
    } = await import('./oneSatImportGuard')

    bindAccountLocalKeyScope({ accountIndex: 0, identityKey: 'ik-sender' })
    rebindOneSatImportGuardForAccount()
    markOneSatImported([TIP])
    expect(beginOneSatImport([TIP])).toEqual([])

    bindAccountLocalKeyScope({ accountIndex: 1, identityKey: 'ik-payee' })
    rebindOneSatImportGuardForAccount()
    expect(beginOneSatImport([TIP])).toEqual([TIP])
  })
})
