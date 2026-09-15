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
import { clearPaymentProgress } from './paymentProgress'
import { bindWalletProgressAccount } from './walletProgress'

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
  bindWalletProgressAccount({
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
  })
  // Live "Sending…" row is global — drop it so Activity cannot paint another
  // account's in-flight send after vault switch.
  clearPaymentProgress()
}
