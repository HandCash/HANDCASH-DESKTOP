import { describe, expect, it } from 'vitest'
import {
  formatReviewActionsError,
  isReviewActionsError,
  sendWithHasFailure,
} from './actionReview'

describe('actionReview', () => {
  it('detects WERR_REVIEW_ACTIONS by name and shape', () => {
    expect(
      isReviewActionsError({
        name: 'WERR_REVIEW_ACTIONS',
        message: 'Undelayed createAction or signAction results require review.',
        reviewActionResults: [{ status: 'doubleSpend' }],
      }),
    ).toBe(true)
    expect(isReviewActionsError(new Error('network down'))).toBe(false)
  })

  it('formats doubleSpend as a retry hint', () => {
    expect(
      formatReviewActionsError({
        reviewActionResults: [{ status: 'doubleSpend', competingTxs: ['aa'] }],
        sendWithResults: [{ status: 'failed' }],
      }),
    ).toMatch(/previous failed send/i)
  })

  it('flags failed sendWith rows', () => {
    expect(sendWithHasFailure([{ status: 'unproven' }])).toBe(false)
    expect(sendWithHasFailure([{ status: 'doubleSpend' }])).toBe(true)
    expect(sendWithHasFailure([])).toBe(false)
  })
})
