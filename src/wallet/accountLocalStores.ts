/**
 * Rebind in-memory + durable UI stores when the active vault account changes.
 * Toolbox IDB is already per-account; these localStorage surfaces were not.
 */
import { bindAccountLocalKeyScope } from './accountLocalKeys'
import { rebindAppActivityForAccount } from './appActivity'
import { rebindActivitySeenForAccount } from './activitySeen'
import { rebindCollectablesForAccount } from './collectables'
import { rebindFriendsForAccount } from './friends'
import { rebindConnectedAppsForAccount } from './permissions'
import { rebindFungiblesForAccount } from './token/list'
import { rebindMessagesForAccount } from './messageStore'

export function rebindAccountLocalStores(wallet: {
  accountIndex: number
  identityKey: string
}): void {
  bindAccountLocalKeyScope({
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
  })
  rebindFriendsForAccount()
  rebindAppActivityForAccount()
  rebindConnectedAppsForAccount()
  rebindActivitySeenForAccount()
  rebindMessagesForAccount()
  rebindCollectablesForAccount()
  rebindFungiblesForAccount()
}
