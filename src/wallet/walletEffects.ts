/**
 * Exhaustive projection of kernel outcomes onto feature state.
 *
 * Mutation paths emit facts; this module owns the secondary effects. Adding a
 * new outcome fails compilation until its effects are explicitly accepted.
 */
import { rebindAppActivityForAccount } from './appActivity'
import { rebindActivitySeenForAccount } from './activitySeen'
import { rebindCollectablesForAccount } from './collectables'
import { rebindFriendsForAccount } from './friends'
import { rebindMessagesForAccount } from './messageStore'
import { rebindConnectedAppsForAccount } from './permissions'
import { clearPaymentProgress } from './paymentProgress'
import { rebindOneSatImportGuardForAccount } from './oneSatImportGuard'
import { rebindSentItemGuardForAccount } from './sentItemGuard'
import { rebindFungiblesForAccount } from './token/list'
import { assertNeverOutcome, type WalletOutcome } from './kernel/outcomes'

export function applyWalletOutcome(outcome: WalletOutcome): void {
  switch (outcome.type) {
    case 'AccountChanged':
      rebindFriendsForAccount()
      rebindAppActivityForAccount()
      rebindConnectedAppsForAccount()
      rebindActivitySeenForAccount()
      rebindMessagesForAccount()
      // Before the inventories: both guards answer "is this outpoint mine to
      // show", and a stale parse from the previous account would hide the new
      // account's own tips.
      rebindSentItemGuardForAccount()
      rebindOneSatImportGuardForAccount()
      rebindCollectablesForAccount()
      rebindFungiblesForAccount()
      clearPaymentProgress()
      return
    case 'SpendCompleted':
    case 'ItemInternalized':
    case 'ChainIngestCompleted':
      // These outcomes are declared now; their existing call sites migrate
      // behind this boundary feature by feature.
      return
    default:
      return assertNeverOutcome(outcome)
  }
}
