import { describe, expect, it } from 'vitest'
import { classifyOwnedCash, txLivenessFromStatus } from './balanceView'

describe('txLivenessFromStatus', () => {
  it('treats sending / unproven / completed as live', () => {
    for (const status of ['sending', 'unproven', 'completed', 'nosend', 'nonfinal']) {
      expect(txLivenessFromStatus(status)).toBe('live')
    }
  })

  it('treats failed / missing as not live', () => {
    expect(txLivenessFromStatus('failed')).toBe('dead')
    expect(txLivenessFromStatus(undefined)).toBe('none')
  })
})

describe('classifyOwnedCash', () => {
  it('counts remaining spendable coins', () => {
    expect(
      classifyOwnedCash({ satoshis: 40_000, spendable: true }, 'live', 'none'),
    ).toEqual({ kind: 'count', as: 'spendable', satoshis: 40_000 })
  })

  it('credits unconfirmed change of a live send, even when not yet spendable', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 9_000, change: true, spendable: false },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'count', as: 'unconfirmedChange', satoshis: 9_000 })
  })

  it('drops inputs of a live send so the displayed total is not send+change', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 50_000, spendable: false, spentBy: 7 },
        'live',
        'live',
      ),
    ).toEqual({ kind: 'exclude', reason: 'spentLive' })
  })

  it('does not count the payment output going to someone else', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1_000, change: false, spendable: false },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })

  it('keeps items and tokens out of Pay', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 1, spendable: true, basket: '1sat' },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'item' })
    expect(
      classifyOwnedCash(
        { satoshis: 100, spendable: true, basket: 'bsv21' },
        'live',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'bsv21' })
  })

  it('does not credit written-off change of a failed send', () => {
    expect(
      classifyOwnedCash(
        { satoshis: 9_000, change: true, spendable: false },
        'dead',
        'none',
      ),
    ).toEqual({ kind: 'exclude', reason: 'notOurs' })
  })
})

describe('owned cash while sending', () => {
  it('equals leftover spendable plus in-flight change, not inputs minus nothing', () => {
    const input = classifyOwnedCash(
      { satoshis: 50_000, spendable: false, spentBy: 1 },
      'live',
      'live',
    )
    const payment = classifyOwnedCash(
      { satoshis: 1_000, change: false, spendable: false },
      'live',
      'none',
    )
    const change = classifyOwnedCash(
      { satoshis: 48_990, change: true, spendable: false },
      'live',
      'none',
    )
    const leftover = classifyOwnedCash(
      { satoshis: 10_000, spendable: true },
      'live',
      'none',
    )
    const coins = [input, payment, change, leftover]
    const owned = coins.reduce(
      (n, fate) => (fate.kind === 'count' ? n + fate.satoshis : n),
      0,
    )
    expect(owned).toBe(58_990)
  })
})
