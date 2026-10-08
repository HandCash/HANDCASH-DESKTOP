/**
 * Rebind in-memory + durable UI stores when the active vault account changes.
 * Toolbox IDB is already per-account; these localStorage surfaces were not.
 */
import { bindAccountLocalKeyScope } from './accountLocalKeys'
import {
  consumeActivityLedgerPrime,
  publishActivityLedger,
  resetActivityLedgerForRuntime,
  restoreActivityLedger,
  scheduleActivityLedgerRefresh,
} from './activityLedger'
import { appendAppLog } from './appLog'
import { reconcileBackupWatchdog } from './backupWatchdog'
import { bindSyncHealthAccount } from './walletHealth'
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
      resetActivityLedgerForRuntime()
      const primed = consumeActivityLedgerPrime(runtime.storageNamespace)
      if (primed) publishActivityLedger(runtime.storageNamespace, primed)
      else void restoreActivityLedger(runtime)
      scheduleActivityLedgerRefresh()
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
      // Sync pill + chain-ingest status are per vault account — never leave
      // root's Synced painted on a cold child toolbox. Bound here, in the same
      // tick as every other account store, not after the runtime is published.
      bindSyncHealthAccount({
        identityKey: wallet.identityKey,
        accountIndex: wallet.accountIndex,
      })
      setDirectSessionIdentity({
        rootKeyHex: wallet.rootKeyHex,
        identityKey: wallet.identityKey,
      })
      void import('./deadCoinSweep').then(({ scheduleUnlockDeadCoinPass }) =>
        scheduleUnlockDeadCoinPass(runtime),
      )
      void import('./arcadeLanding').then(({ scheduleUnlockLandingPass }) =>
        scheduleUnlockLandingPass(runtime),
      )
      void import('./peerDeviceSpends').then(({ schedulePeerDeviceWatch }) =>
        schedulePeerDeviceWatch(runtime),
      )
    },
    dispose: () => {
      resetActivityLedgerForRuntime()
      bindSyncHealthAccount(null)
      cancelPendingPermissions('wallet-runtime-disposed')
      clearPaymentProgress()
      clearVerificationProgress()
      resetDirectSessions()
    },
  })
}

const watchdogReconciled = new Set<string>()

export function prepareAccountLocalStores(
  wallet: WalletRuntime['instance'],
): void {
  ensureLifecycleRegistered()
  bindAccountLocalKeyScope({
    accountIndex: wallet.accountIndex,
    identityKey: wallet.identityKey,
    chain: wallet.chain,
  })
  // The watchdog lives under this account's keys, which do not exist before
  // unlock. Once per launch: a second unlock would read a live attempt as a
  // crash.
  const account = `${wallet.chain}:${wallet.accountIndex}:${wallet.identityKey}`
  if (!watchdogReconciled.has(account)) {
    watchdogReconciled.add(account)
    const note = reconcileBackupWatchdog()
    if (note) appendAppLog('warn', `[cloud-backup] ${note}`)
  }
}
