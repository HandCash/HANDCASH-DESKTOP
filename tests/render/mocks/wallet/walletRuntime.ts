/** Render harness: a fake runtime for the fixture profile; no wallet is opened. */
import type { ActiveWallet } from '../../../../src/wallet/session'
import type { WalletRuntime, WalletRuntimeId } from '../../../../src/wallet/walletRuntime'
import { mockState } from '../../mockState'

export * from '../../../../src/wallet/walletRuntime'

let runtime: WalletRuntime | null = null

export function getWalletRuntime(): WalletRuntime | null {
  if (!runtime) {
    const { profile } = mockState()
    runtime = Object.freeze({
      instance: { identityKey: profile.identityKey, chain: profile.chain } as unknown as ActiveWallet,
      runtimeId: 'render-fixture' as WalletRuntimeId,
      generation: 1,
      storageNamespace: 'render-fixture',
      signal: new AbortController().signal,
    })
  }
  return runtime
}

export function runtimeIsCurrent(candidate: WalletRuntime): boolean {
  return candidate === runtime
}
