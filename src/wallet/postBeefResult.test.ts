import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  deliverSignedTxBestEffort,
  formatPostBeefFailure,
  postBeefConflictIsReal,
  postBeefResultsArcadeAccepted,
  postBeefResultsArcadeHardReject,
  summarizePostBeef,
} from './postBeefResult'

const postBeef = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    chain: 'main',
    services: { postBeef },
  }),
}))

vi.mock('./legacyScan', () => ({
  txExistsOnChain: vi.fn(),
}))

const INPUT = '12'.repeat(32) + '.0'
vi.mock('./signedTxInputs', () => ({
  inputOutpointsForSignedTx: vi.fn(async () => [INPUT]),
}))

const inputsSpentElsewhere = vi.fn(
  async (): Promise<Array<{ outpoint: string; spender: string }>> => [],
)
vi.mock('./createActionInputFate', () => ({
  inputsSpentElsewhere: (...args: unknown[]) => inputsSpentElsewhere(...(args as [])),
}))

vi.mock('@bsv/sdk', () => ({
  Beef: { fromBinary: vi.fn(() => ({})) },
}))

describe('postBeefResult', () => {
  beforeEach(async () => {
    postBeef.mockReset()
    postBeef.mockResolvedValue([
      { status: 'success', txidResults: [{ status: 'success' }] },
    ])
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValue(null)
    inputsSpentElsewhere.mockReset()
    inputsSpentElsewhere.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
  it('treats already-known / mempool as accepted', () => {
    expect(
      summarizePostBeef([
        {
          name: 'BitailsPostRaws',
          status: 'error',
          txidResults: [
            {
              status: 'success',
              alreadyKnown: true,
              notes: [{ what: 'postRawsSuccessAlreadyInMempool' }],
            },
          ],
        },
      ]).accepted,
    ).toBe(true)
  })

  it('detects missing-inputs as doubleSpend', () => {
    const s = summarizePostBeef([
      {
        name: 'BitailsPostRaws',
        status: 'error',
        txidResults: [
          {
            status: 'error',
            doubleSpend: true,
            notes: [{ what: 'postRawsErrorMissingInputs' }],
          },
        ],
      },
      { name: 'WoC', status: 'error', txidResults: [] },
    ])
    expect(s.accepted).toBe(false)
    expect(s.missingInputs).toBe(true)
    expect(s.doubleSpend).toBe(true)
    expect(formatPostBeefFailure(s)).toBe('Already spent')
  })

  it('does not throw when postBeef returns nothing', () => {
    const s = summarizePostBeef(undefined)
    expect(s.accepted).toBe(false)
    expect(s.serviceOnlyErrors).toBe(true)
  })

  it('classifies Arcade success independently of Bitails errors', () => {
    expect(
      postBeefResultsArcadeAccepted([
        { name: 'Bitails', status: 'error' },
        { name: 'ArcadeBeef', status: 'success' },
      ]),
    ).toBe(true)
    expect(
      postBeefResultsArcadeHardReject([
        { name: 'ArcadeBeef', status: 'success' },
        { name: 'Bitails', status: 'error' },
      ]),
    ).toBe(false)
  })

  it('treats doubleSpend as ghost when no input has a named spender', async () => {
    const txid = 'aa'.repeat(32)
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValue(false)
    await expect(
      postBeefConflictIsReal({ txid, chain: 'main' }),
    ).resolves.toBe(false)
    expect(inputsSpentElsewhere).toHaveBeenCalledWith(txid, [INPUT], 'main')
  })

  it('treats doubleSpend as real when another tx is named spending an input', async () => {
    const txid = 'ab'.repeat(32)
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValue(false)
    inputsSpentElsewhere.mockResolvedValueOnce([{ outpoint: INPUT, spender: 'cd'.repeat(32) }])
    await expect(
      postBeefConflictIsReal({ txid, chain: 'main' }),
    ).resolves.toBe(true)
  })

  it('treats doubleSpend as real when tx is on chain', async () => {
    const txid = 'bb'.repeat(32)
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValue(true)
    await expect(
      postBeefConflictIsReal({ txid, chain: 'main' }),
    ).resolves.toBe(true)
  })

  it('deliverSignedTxBestEffort accepts mempool success without blocking on proof', async () => {
    const txid = 'cc'.repeat(32)
    const result = await deliverSignedTxBestEffort({
      txid,
      atomic: [1, 2, 3],
      chain: 'main',
    })
    expect(result.outcome).toBe('accepted')
    expect(postBeef).toHaveBeenCalled()
  })

  it('deliverSignedTxBestEffort defers on transport failure — does not undo local spend', async () => {
    postBeef.mockRejectedValueOnce(new Error('provider down'))
    const txid = 'dd'.repeat(32)
    const result = await deliverSignedTxBestEffort({
      txid,
      atomic: [1, 2, 3],
      chain: 'main',
    })
    expect(result.outcome).toBe('deferred')
  })

  it('deliverSignedTxBestEffort defers on ghost doubleSpend', async () => {
    postBeef.mockResolvedValueOnce([
      {
        status: 'error',
        txidResults: [{ status: 'error', doubleSpend: true }],
      },
    ])
    const { txExistsOnChain } = await import('./legacyScan')
    vi.mocked(txExistsOnChain).mockResolvedValue(false)
    const txid = 'ee'.repeat(32)
    const result = await deliverSignedTxBestEffort({
      txid,
      atomic: [1, 2, 3],
      chain: 'main',
    })
    expect(result.outcome).toBe('deferred')
    expect(result.detail).toBe('ghost_conflict')
  })
})
