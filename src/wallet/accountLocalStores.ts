/**
 * Rebind in-memory + durable UI stores when the active vault account changes.
 * Toolbox IDB is already per-account; these localStorage surfaces were not.
 */
import { bindAccountLocalKeyScope } from './accountLocalKeys'
import { bindWalletProgressAccount } from './walletProgress'
import { applyWalletOutcome } from './walletEffects'

export function rebindAccountLocalStores(wallet: {
  accountIndex: number
  identityKey: string
}): void {
  bindAccountLocalKeyScope({
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
  })
  applyWalletOutcome({
    type: 'AccountChanged',
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
  })
  bindWalletProgressAccount({
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
  })
}
