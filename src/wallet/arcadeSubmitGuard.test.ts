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

  it('lets an explicit UTXO_SPENT row override Arcade envelope success', () => {
    const results = [
      {
        name: 'ArcadeBeef',
        status: 'success',
        txidResults: [{ status: 'UTXO_SPENT' }],
      },
    ]
    expect(postBeefResultsArcadeAccepted(results)).toBe(false)
    expect(postBeefResultsArcadeHardReject(results)).toBe(true)
  })

  it('treats a rejected parent as a hard reject instead of pinning the child', () => {
    const results = [
      {
        name: 'ArcadeBeef',
        status: 'success',
        txidResults: [{ status: 'PARENT_REJECTED' }],
      },
    ]
    expect(postBeefResultsArcadeAccepted(results)).toBe(false)
    expect(postBeefResultsArcadeHardReject(results)).toBe(true)
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

/**
 * The field case: a collectable send funded by change from an earlier spend
 * that never landed. Neither transaction has a raw body in storage, so the
 * inputs come from our own seal records and the unlanded parent reads phantom.
 */
describe('signedTxLooksAbandoned', () => {
  const OLD = Date.now() - 24 * 60 * 60_000
  const PHANTOM_PARENT = 'cc'.repeat(32)
  const REAL_PARENT = 'dd'.repeat(32)

  async function guard() {
    vi.resetModules()
    return import('./arcadeSubmitGuard')
  }

  beforeEach(async () => {
    const legacyScan = await import('./legacyScan')
    vi.mocked(legacyScan.txExistsOnChain).mockImplementation(
      async (txid: string) => (txid === REAL_PARENT ? true : false),
    )
    vi.mocked(legacyScan.spentStatusOfOutpoint).mockImplementation(
      async (outpoint: string) =>
        outpoint.startsWith(PHANTOM_PARENT) ? ('unknown' as const) : ('unspent' as const),
    )
  })

  it('reclaims a send whose funding change never landed', async () => {
    const { signedTxLooksAbandoned } = await guard()
    await expect(
      signedTxLooksAbandoned({
        txid: TX,
        chain: 'main',
        createdAt: OLD,
        knownOnChain: false,
        knownInputs: [`${PHANTOM_PARENT}.0`, `${REAL_PARENT}.1`],
      }),
    ).resolves.toBe(true)
  })

  it('keeps a cheque a broadcaster accepted, without probing the chain', async () => {
    const { rememberArcadeSubmitContact, signedTxLooksAbandoned } = await guard()
    rememberArcadeSubmitContact(TX)
    await expect(
      signedTxLooksAbandoned({
        txid: TX,
        chain: 'main',
        createdAt: OLD,
        knownOnChain: false,
        knownInputs: [`${REAL_PARENT}.1`],
      }),
    ).resolves.toBe(false)
  })

  it('keeps a spend still inside the grace window', async () => {
    const { signedTxLooksAbandoned } = await guard()
    await expect(
      signedTxLooksAbandoned({
        txid: TX,
        chain: 'main',
        createdAt: Date.now() - 60_000,
        knownOnChain: false,
        knownInputs: [`${REAL_PARENT}.1`],
      }),
    ).resolves.toBe(false)
  })

  it('keeps a spend it cannot enumerate the inputs of', async () => {
    const { signedTxLooksAbandoned } = await guard()
    await expect(
      signedTxLooksAbandoned({
        txid: TX,
        chain: 'main',
        createdAt: OLD,
        knownOnChain: false,
        knownInputs: [],
      }),
    ).resolves.toBe(false)
  })
})
