/**
 * Rebind in-memory + durable UI stores when the active vault account changes.
 * Toolbox IDB is already per-account; these localStorage surfaces were not.
 */
import { bindAccountLocalKeyScope } from './accountLocalKeys'
import { bindWalletProgressAccount } from './walletProgress'
import { applyWalletOutcome } from './walletEffects'
import type { WalletRuntime } from './walletRuntime'
import { registerWalletRuntimeLifecycle } from './walletRuntime'
import { cancelPendingPermissions } from './permissions'
import { clearPaymentProgress } from './paymentProgress'
import { clearVerificationProgress } from './verificationProgress'
import {
  resetDirectSessions,
  setDirectSessionIdentity,
} from './directSession/session'

let lifecycleRegistered = false

function ensureLifecycleRegistered(): void {
  if (lifecycleRegistered) return
  lifecycleRegistered = true
  registerWalletRuntimeLifecycle({
    name: 'account-feature-state',
    start: (runtime) => {
      const wallet = runtime.instance
      applyWalletOutcome({
        type: 'AccountChanged',
        accountIndex: wallet.accountIndex,
        identityKey: wallet.identityKey,
        runtime,
      })
      bindWalletProgressAccount({
        accountIndex: wallet.accountIndex,
        identityKey: wallet.identityKey,
      })
      setDirectSessionIdentity({
        rootKeyHex: wallet.rootKeyHex,
        identityKey: wallet.identityKey,
      })
    },
    dispose: () => {
      cancelPendingPermissions('wallet-runtime-disposed')
      clearPaymentProgress()
      clearVerificationProgress()
      resetDirectSessions()
    },
  })
}

export function prepareAccountLocalStores(
  wallet: WalletRuntime['instance'],
): void {
  ensureLifecycleRegistered()
  bindAccountLocalKeyScope({
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
    chain: wallet.chain,
  })
}
