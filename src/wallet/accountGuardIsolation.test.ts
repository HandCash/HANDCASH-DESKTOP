/**
 * Two vault accounts on one device do not share a basket, so they must not
 * share the marks that hide outpoints from a basket.
 */
import { PrivateKey } from '@bsv/sdk'
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

vi.mock('./session', () => ({ getActiveWallet: () => null }))

vi.mock('./token/icons/cache', () => ({ getTokenIconDataUrl: () => undefined }))

vi.mock('./token/list', () => ({ forgetFungibleToken: vi.fn() }))

const TIP = `${'9d'.repeat(32)}.0`
const TOKEN_ID = `${'11'.repeat(32)}_0`

function heldTipWallet(args: {
  address: string
  outpoint: string
  lockingScript: string
}) {
  return {
    address: args.address,
    chain: 'main',
    wallet: {
      listOutputs: async (q: { basket?: string }) => ({
        outputs:
          q.basket === 'bsv21'
            ? [
                {
                  outpoint: args.outpoint,
                  satoshis: 1,
                  lockingScript: args.lockingScript,
                  tags: [],
                },
              ]
            : [],
      }),
    },
  } as never
}

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

  /**
   * The precise heal for a wallet that received before the guards were
   * scoped: the tip pays us and the hiding transaction is the tip's own, so
   * the mark cannot describe anything this account did.
   */
  it('lists a held tip whose hide mark names the tip own transaction', async () => {
    const { buildBsv21ValueLock } = await import('./token')
    const { isItemSent, markItemsSent } = await import('./sentItemGuard')
    const { listBsv21BinaryTips } = await import('./token/listTips')
    const mine = PrivateKey.fromRandom().toAddress()
    const txid = 'ab'.repeat(32)
    const lockingScript = buildBsv21ValueLock({
      tokenId: TOKEN_ID,
      amount: 7n,
      address: mine,
    })
    markItemsSent([{ outpoint: `${txid}.0`, txid }])

    const tips = await listBsv21BinaryTips(
      heldTipWallet({ address: mine, outpoint: `${txid}.0`, lockingScript }),
    )

    expect(tips.map((t) => t.outpoint)).toEqual([`${txid}_0`])
    expect(isItemSent(`${txid}.0`)).toBe(false)
  })

  it('keeps hiding a tip a later transaction spent', async () => {
    const { buildBsv21ValueLock } = await import('./token')
    const { markItemsSent } = await import('./sentItemGuard')
    const { listBsv21BinaryTips } = await import('./token/listTips')
    const mine = PrivateKey.fromRandom().toAddress()
    const tipTxid = 'cd'.repeat(32)
    const lockingScript = buildBsv21ValueLock({
      tokenId: TOKEN_ID,
      amount: 7n,
      address: mine,
    })
    markItemsSent([{ outpoint: `${tipTxid}.0`, txid: 'ef'.repeat(32) }])

    const tips = await listBsv21BinaryTips(
      heldTipWallet({ address: mine, outpoint: `${tipTxid}.0`, lockingScript }),
    )

    expect(tips).toEqual([])
  })
})
