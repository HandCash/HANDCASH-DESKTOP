import { describe, expect, it } from 'vitest'
import { classifySpvThrow } from './spvVerdict'

describe('classifySpvThrow', () => {
  it('calls a defect of the tx itself invalid', () => {
    for (const message of [
      'Script evaluation error: The top stack element must be truthy after script evaluation.',
      'Verification failed because transaction ab spends outpoint cd:0 more than once.',
      'Verification failed because input 0 of transaction ab references a source output that does not exist.',
    ]) {
      expect(classifySpvThrow(new Error(message)).kind).toBe('invalid')
    }
  })

  it('holds anything that only says the package cannot be judged yet', () => {
    for (const message of [
      'no chain tracker could confirm the merkle root at height 900000',
      'Invalid merkle path for transaction ab',
      'Verification failed because the input at index 0 of transaction ab is missing an associated source transaction.',
      'fetch failed',
    ]) {
      expect(classifySpvThrow(new Error(message)).kind).toBe('incomplete')
    }
  })
})
