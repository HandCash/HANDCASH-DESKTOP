import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReviewSpendableOutputs = vi.fn()
const mockGetActiveWallet = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => mockGetActiveWallet(),
}))

const { isAlreadySpentInputError, isNoLongerSpendableError, releaseStaleSpendableOutputs } =
  await import('./staleOutputRelease')

describe('isAlreadySpentInputError', () => {
  it('accepts the rejections that prove an input is spent or gone', () => {
    for (const message of [
      'Missing inputs',
      'bad-txns-inputs-missingorspent',
      'txn-mempool-conflict',
      'input already spent',
      'double spend detected',
      'doubleSpend',
    ]) {
      expect(isAlreadySpentInputError(new Error(message))).toBe(true)
    }
  })

  it('rejects failures that say nothing about our outputs', () => {
    for (const message of [
      'fetch failed',
      'Wallet locked',
      'WALLET_BRIDGE_TIMEOUT',
      'Insufficient funds',
      'status=503',
      'input 09da14e3.1 is no longer spendable',
    ]) {
      expect(isAlreadySpentInputError(new Error(message))).toBe(false)
    }
  })
})

describe('isNoLongerSpendableError', () => {
  it('matches wallet-storage spendable false, not chain spent', () => {
    expect(
      isNoLongerSpendableError(
        new Error(
          'WERR_INVALID_OPERATION: input 09da14e3026e0435fcf8357fcef5fc3541ad5568eada24b19cb0be5cee57132f.1 is no longer spendable',
        ),
      ),
    ).toBe(true)
    expect(isNoLongerSpendableError(new Error('input already spent'))).toBe(false)
    expect(isNoLongerSpendableError(new Error('Insufficient funds'))).toBe(false)
  })
})

describe('releaseStaleSpendableOutputs', () => {
  beforeEach(() => {
    mockReviewSpendableOutputs.mockReset()
    mockGetActiveWallet.mockReset()
    mockGetActiveWallet.mockReturnValue({
      chain: 'main',
      wallet: { reviewSpendableOutputs: mockReviewSpendableOutputs },
    })
  })

  it('releases across every basket and reports the count', async () => {
    mockReviewSpendableOutputs.mockResolvedValue({
      totalOutputs: 2,
      outputs: [{ outpoint: 'aa.0' }, { outpoint: 'bb.1' }],
    })

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(2)
    expect(mockReviewSpendableOutputs).toHaveBeenCalledWith(true, true)
  })

  it('falls back to the default basket when the all-basket filter is unsupported', async () => {
    mockReviewSpendableOutputs
      .mockRejectedValueOnce(
        new Error('The args.partial.basketId parameter must be not undefined.'),
      )
      .mockResolvedValueOnce({ totalOutputs: 1, outputs: [{ outpoint: 'aa.0' }] })

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(1)
    expect(mockReviewSpendableOutputs).toHaveBeenNthCalledWith(2, false, true)
  })

  it('reports nothing released when the provider is down', async () => {
    mockReviewSpendableOutputs.mockRejectedValue(new Error('provider down'))

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(0)
  })

  it('does nothing without an unlocked wallet', async () => {
    mockGetActiveWallet.mockReturnValue(null)

    await expect(releaseStaleSpendableOutputs()).resolves.toBe(0)
    expect(mockReviewSpendableOutputs).not.toHaveBeenCalled()
  })
})
