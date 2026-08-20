import { describe, expect, it } from 'vitest'
import { redactAppLogMessage } from './appLog'

describe('redactAppLogMessage', () => {
  it('redacts JSON custody fields before durable or remote logging', () => {
    const message = JSON.stringify({
      rootKeyHex: '11'.repeat(32),
      mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
      ok: 'visible',
    })
    const redacted = redactAppLogMessage(message)
    expect(redacted).not.toContain('11'.repeat(32))
    expect(redacted).not.toContain('abandon ability')
    expect(redacted).toContain('"ok":"visible"')
  })

  it('redacts key-value password and secret forms', () => {
    expect(redactAppLogMessage('password=hunter2 failed')).toBe(
      'password=[REDACTED] failed',
    )
    expect(redactAppLogMessage('authorization: Bearer-token request')).not.toContain(
      'Bearer-token',
    )
  })
})
