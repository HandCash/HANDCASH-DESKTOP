import { describe, expect, it } from 'vitest'
import {
  decideChequeBroadcast,
  interpretMissingInputs,
} from './chequeBroadcast'

describe('decideChequeBroadcast', () => {
  it('refuses a package with no subject body', () => {
    expect(
      decideChequeBroadcast({
        subjectBodyPresent: false,
        gap: 'none',
      }),
    ).toEqual({ kind: 'refuse', reason: 'subject-missing' })
  })

  it('refuses stub parents instead of treating them as spent', () => {
    const decision = decideChequeBroadcast({
      subjectBodyPresent: true,
      gap: 'missing-bodies',
    })
    expect(decision).toEqual({ kind: 'refuse', reason: 'missing-bodies' })
    expect(interpretMissingInputs(decision)).toBe('incomplete-package')
  })

  it('fires chained unconfirmed parents and labels MissingInputs as unconfirmed', () => {
    const decision = decideChequeBroadcast({
      subjectBodyPresent: true,
      gap: 'unconfirmed-parents',
    })
    expect(decision).toEqual({
      kind: 'broadcast',
      parents: 'unconfirmed-bodies',
    })
    expect(interpretMissingInputs(decision)).toBe('still-unconfirmed')
  })

  it('fires header-proven parents; MissingInputs may then be a spent coin', () => {
    const decision = decideChequeBroadcast({
      subjectBodyPresent: true,
      gap: 'none',
    })
    expect(decision).toEqual({
      kind: 'broadcast',
      parents: 'header-proven',
    })
    expect(interpretMissingInputs(decision)).toBe('possible-spent')
  })
})
