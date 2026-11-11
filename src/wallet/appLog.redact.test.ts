import { describe, expect, it } from 'vitest'
import { redactAppLogMessage } from './appLog'

describe('redactAppLogMessage unlabelled fields', () => {
  it.each([
    'value=true',
    'confirmed=3 unconfirmed=0',
    'available=yes',
    'utxo count=4 vout=1',
    'retry attempt 2 of 3',
  ])('leaves normal log text untouched: %s', (line) => {
    expect(redactAppLogMessage(line)).toBe(line)
  })

  it('drops amounts, labelled or not', () => {
    expect(redactAppLogMessage('amount=500 fee=1 satoshis: 1000 balance=123 spendable: 9')).toBe(
      'amount=[amt] fee=[amt] satoshis: [amt] balance=[amt] spendable: [amt]',
    )
  })

  it('redacts txid and outpoint keys that are not identifiers', () => {
    expect(redactAppLogMessage('txid=ab12 txhash=cd outpoint=ab12.0')).toBe(
      'txid=[REDACTED] txhash=[REDACTED] outpoint=[REDACTED]',
    )
  })
})
