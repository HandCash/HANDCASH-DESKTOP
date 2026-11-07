import { activeAccountSpendRefusal } from './vaultAccountHolding'
import { assertRuntimeCurrent, getWalletRuntime } from './walletRuntime'

/** BRC-249 Moving on demand: a user action belongs to one runtime, not a later selection. */
export function captureSigningIntent() {
  const runtime = getWalletRuntime()
  if (!runtime) throw new Error('WALLET_LOCKED')
  const assertCurrent = () => assertRuntimeCurrent(runtime)
  const assertHeld = () => {
    assertCurrent()
    const refusal = activeAccountSpendRefusal(runtime.instance)
    if (refusal) throw new Error(refusal)
  }
  return { account: runtime.instance, assertCurrent, assertHeld }
}
