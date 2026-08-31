import { describe, expect, it } from 'vitest'
import {
  insufficientFundsMessage,
  isInsufficientFundsError,
} from './insufficientFunds'

describe('isInsufficientFundsError', () => {
  it('matches the toolbox refusal by name and by wording', () => {
    const named = new Error('nope')
    named.name = 'WERR_INSUFFICIENT_FUNDS'
    expect(isInsufficientFundsError(named)).toBe(true)

    // The exact line users were shown before this was translated.
    expect(
      isInsufficientFundsError(
        new Error(
          'Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee (539816 more satoshis are needed, for a total of 539816)',
        ),
      ),
    ).toBe(true)
  })

  it('does not swallow unrelated send failures', () => {
    expect(isInsufficientFundsError(new Error('Already spent'))).toBe(false)
    expect(isInsufficientFundsError(new Error('No network'))).toBe(false)
    expect(isInsufficientFundsError('not an error')).toBe(false)
  })
})

describe('insufficientFundsMessage', () => {
  it('names chainable change when promotion has not caught up yet', () => {
    const message = insufficientFundsMessage({
      confirmedSats: 2,
      confirmingSats: 162_767,
      neededSats: 50_000,
    })
    expect(message).toContain('chains unconfirmed change')
    expect(message).not.toContain('still confirming')
  })

  it('refuses to promise a wait the balance cannot honour', () => {
    // Confirming money exists but still does not cover the spend — telling the
    // user to wait would have them waiting forever.
    const message = insufficientFundsMessage({
      confirmedSats: 1_000,
      confirmingSats: 2_000,
      neededSats: 539_816,
    })
    expect(message).toContain('Not enough spendable BSV')
    expect(message).not.toContain('confirming')
  })

  it('reports a plain shortfall when nothing is confirming', () => {
    const message = insufficientFundsMessage({
      confirmedSats: 100,
      confirmingSats: 0,
      neededSats: 539_816,
    })
    expect(message).toBe(
      'Not enough spendable BSV: 0.000001 spendable now, need 0.00539816 plus network fee.',
    )
  })

  it('never leaks the raw toolbox satoshi arithmetic', () => {
    const message = insufficientFundsMessage({
      confirmedSats: 2,
      confirmingSats: 162_767,
      neededSats: 50_000,
    })
    expect(message).not.toContain('more satoshis are needed')
    expect(message).not.toContain('50000')
  })
})
