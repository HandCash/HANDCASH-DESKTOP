import { describe, expect, it, vi } from 'vitest'
import type { ActiveWallet } from '../session'

vi.mock('../walletCoordinator', () => ({
  spendNeedsStorage: () => false,
}))

import { readTokenFiling } from './filingStore'

const wallet = {
  chain: 'main',
  accountIndex: 0,
  identityKey: 'aa',
  wallet: {},
} as ActiveWallet

describe('token filing read', () => {
  it('lists p2pft and does not listOutputs the legacy bsv21 basket', async () => {
    const baskets: string[] = []
    const rows = await readTokenFiling(
      wallet,
      async (basket) => {
        baskets.push(basket)
        return [{ outpoint: `${basket}.0` }]
      },
      (row) => row.outpoint,
    )
    expect(baskets).toEqual(['p2pft'])
    expect(rows).toEqual([{ outpoint: 'p2pft.0' }])
  })
})
