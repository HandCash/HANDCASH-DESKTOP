import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetArcadeSubmitGuardForTests,
  postBeefResultsArcadeAccepted,
  postBeefResultsArcadeHardReject,
  postBeefResultsHitArcade,
  rememberArcadeSubmitContact,
  signedTxMayBeRemoved,
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

  it('treats Arcade success / alreadyKnown as accepted without explorers', () => {
    expect(
      postBeefResultsArcadeAccepted([
        { name: 'Bitails', status: 'error' },
        { name: 'ArcadeBeef', status: 'success' },
      ]),
    ).toBe(true)
    expect(
      postBeefResultsArcadeAccepted([
        {
          name: 'Arcade',
          status: 'error',
          txidResults: [{ status: 'success', alreadyKnown: true }],
        },
      ]),
    ).toBe(true)
    expect(
      postBeefResultsArcadeAccepted([
        { name: 'ArcadeBeef', status: 'error', txidResults: [{ status: 'error' }] },
      ]),
    ).toBe(false)
  })

  it('treats Arcade missing-inputs / error as hard reject (drop funds)', () => {
    expect(
      postBeefResultsArcadeHardReject([
        {
          name: 'ArcadeBeef',
          status: 'error',
          txidResults: [
            { status: 'error', doubleSpend: true, notes: [{ what: 'MissingInputs' }] },
          ],
        },
      ]),
    ).toBe(true)
    expect(
      postBeefResultsArcadeHardReject([
        { name: 'ArcadeBeef', status: 'success' },
        { name: 'Bitails', status: 'error' },
      ]),
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

  it('keeps a pin while the chain has not seen the tx yet', async () => {
    rememberArcadeSubmitContact(TX)
    await expect(
      signedTxMayBeRemoved({ txid: TX, chain: 'main' }),
    ).resolves.toBe(false)
  })

  it('does not undo a cheque because explorers have not seen it', async () => {
    rememberArcadeSubmitContact(TX)
    await expect(
      signedTxMayBeRemoved({ txid: TX, chain: 'main' }),
    ).resolves.toBe(false)
  })

  it('keeps a pin when no provider can speak for the tx', async () => {
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValueOnce(null)
    rememberArcadeSubmitContact(TX)
    await expect(
      signedTxMayBeRemoved({ txid: TX, chain: 'main' }),
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
