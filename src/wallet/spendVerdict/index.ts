/**
 * Spend / miner / Arcade answers — one vocabulary.
 *
 * `postBeefConflictIsReal` and `signedTxSpendConflictIsProven` stay distinct:
 * `onChain === true` means the conflict is substantiated in the former and
 * that our tx landed (so it is *not* a competing spend) in the latter.
 * Call them through {@link spendConflictIsProven} with an intent name.
 */

export {
  classifySpendFailureMessage,
  isAlreadySpentInputError,
  isAlreadySpentListingFailure,
  isGhostMissingInputsMessage,
  type SpendArcadeKind,
} from './classify'

export {
  spendConflictIsProven,
  type SpendConflictIntent,
} from './conflict'
