import { describe, expect, it } from 'vitest'
import {
  classifySpendFailureMessage,
  isAlreadySpentInputError,
  isAlreadySpentListingFailure,
  isGhostMissingInputsMessage,
} from './classify'

describe('classifySpendFailureMessage', () => {
  it.each([
    ['Already spent', 'alreadySpent'],
    ['ARCADE_HARD_REJECT: Already spent', 'alreadySpent'],
    ['double spend detected', 'alreadySpent'],
    ['doubleSpend', 'alreadySpent'],
    ['missing inputs on vin 2', 'ghostMissingInputs'],
    ['ARCADE_HARD_REJECT: MissingInputs', 'ghostMissingInputs'],
    ['bad-txns-inputs-missingorspent', 'ghostMissingInputs'],
    ['txn-mempool-conflict', 'ghostMissingInputs'],
    ['BEEF_ANCESTRY_INCOMPLETE: MissingInputs', 'ancestryIncomplete'],
    ['ARCADE_HARD_REJECT: Not sent', 'unknown'],
    ['ITEM_ORIGIN_UNPROVEN', 'unknown'],
    ['ACTION_DENIED', 'unknown'],
  ] as const)('%s → %s', (reason, kind) => {
    expect(classifySpendFailureMessage(reason)).toBe(kind)
  })
})

describe('isAlreadySpentListingFailure', () => {
  it('ignores MissingInputs-only Arcade noise', () => {
    expect(isAlreadySpentListingFailure('missing inputs on vin 2')).toBe(false)
    expect(isAlreadySpentListingFailure('Already spent')).toBe(true)
  })
})

describe('isAlreadySpentInputError', () => {
  it('still hides inputs on missing-inputs createAction rejects', () => {
    expect(isAlreadySpentInputError(new Error('Missing inputs'))).toBe(true)
    expect(isAlreadySpentInputError(new Error('input already spent'))).toBe(true)
    expect(isAlreadySpentInputError(new Error('Insufficient funds'))).toBe(false)
  })
})

describe('isGhostMissingInputsMessage', () => {
  it('names the ghost path', () => {
    expect(isGhostMissingInputsMessage('MissingInputs')).toBe(true)
    expect(isGhostMissingInputsMessage('Already spent')).toBe(false)
  })
})
