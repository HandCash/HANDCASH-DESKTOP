import { describe, expect, it } from 'vitest'
import { redactAppLogMessage } from './appLog'

describe('redactAppLogMessage unlabelled fields', () => {
  it.each([
    'amount=500 fee=1',
    'value=true',
    'confirmed=3 unconfirmed=0',
    'available=yes',
    'utxo count=4 vout=1',
    'satoshis: 1000',
    'retry attempt 2 of 3',
  ])('leaves normal log text untouched: %s', (line) => {
    expect(redactAppLogMessage(line)).toBe(line)
  })

  it('redacts balance, txid and outpoint keys', () => {
    expect(redactAppLogMessage('balance=123 spendable: 9 txid=ab12 txhash=cd outpoint=ab12.0')).toBe(
      'balance=[REDACTED] spendable: [REDACTED] txid=[REDACTED] txhash=[REDACTED] outpoint=[REDACTED]',
    )
  })
})
