import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetArcadeSubmitGuardForTests,
  postBeefResultsHitArcade,
  rememberArcadeSubmitContact,
  signedTxSpendConflictIsProven,
  txHadArcadeSubmitContact,
} from './arcadeSubmitGuard'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
  },
}))

vi.mock('./legacyScan', () => ({
  txExistsOnChain: vi.fn(async () => false),
  spentStatusOfOutpoint: vi.fn(async () => 'unspent' as const),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => null,
}))

vi.mock('./txOutpoints', () => ({
  inputOutpointsFromAtomicBeef: () => ['bb'.repeat(32) + '.0'],
  inputOutpointsFromRawTx: () => [],
}))

const TX = 'aa'.repeat(32)

beforeEach(() => {
  store.clear()
  __resetArcadeSubmitGuardForTests()
})

describe('arcadeSubmitGuard', () => {
  it('detects Arcade in postBeef service names', () => {
    expect(
      postBeefResultsHitArcade([
        { name: 'GorillaPoolArcBeef', status: 'success' },
        { name: 'ArcadeBeef', status: 'error' },
      ]),
    ).toBe(true)
    expect(
      postBeefResultsHitArcade([{ name: 'Bitails', status: 'error' }]),
    ).toBe(false)
  })

  it('pins txids that contacted Arcade', () => {
    rememberArcadeSubmitContact(TX)
    expect(txHadArcadeSubmitContact(TX)).toBe(true)
  })

  it('does not treat ghost doubleSpend as proven when inputs are unspent', async () => {
    rememberArcadeSubmitContact(TX)
    await expect(
      signedTxSpendConflictIsProven({ txid: TX, chain: 'main' }),
    ).resolves.toBe(false)
  })

  it('treats spent inputs as proven conflict', async () => {
    const { spentStatusOfOutpoint } = await import('./legacyScan')
    vi.mocked(spentStatusOfOutpoint).mockResolvedValueOnce('spent')
    rememberArcadeSubmitContact(TX)
    await expect(
      signedTxSpendConflictIsProven({
        txid: TX,
        atomic: [1, 2, 3],
        chain: 'main',
      }),
    ).resolves.toBe(true)
  })
})
