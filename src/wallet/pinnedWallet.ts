/**
 * Wallet handles pinned to the runtime that was current when they were taken.
 *
 * Storage repair work (`staleOutputRelease`) spans many awaits and resolves
 * "the wallet" at entry. Without a pin, a pass begun on one vault account
 * finishes on the next, or worse — reads rows from one account's toolbox and
 * writes the outcome into the other's (hc-a580a, 2026-09-27). Rather than
 * thread a guard past every await in 3k lines, the pin sits at the single
 * choke point every such write crosses: `wallet.storage`. Each storage call,
 * and each call on the provider handed to `runAsStorageProvider`, asserts the
 * runtime is still current and throws `AbortError` otherwise.
 *
 * The pinned `wallet` is a proxy; its methods run against the real instance
 * (`this` is never the proxy) so toolbox internals are untouched. Do not use
 * it as a cache key — session's balance caches key on the real `wallet`.
 */
import { getActiveWallet, type ActiveWallet } from './session'
import {
  assertRuntimeCurrent,
  getWalletRuntime,
  type WalletRuntime,
} from './walletRuntime'

const pinnedByRuntime = new WeakMap<WalletRuntime, ActiveWallet>()

function guarded<T extends object>(target: T, runtime: WalletRuntime): T {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      const value = Reflect.get(t, prop, t)
      if (typeof value !== 'function') return value
      if (prop === 'runAsStorageProvider') {
        return (fn: (sp: object) => unknown, ...rest: unknown[]) => {
          assertRuntimeCurrent(runtime)
          return (value as (...a: unknown[]) => unknown).call(
            t,
            (sp: object) => {
              assertRuntimeCurrent(runtime)
              return fn(guarded(sp, runtime))
            },
            ...rest,
          )
        }
      }
      return (...args: unknown[]) => {
        assertRuntimeCurrent(runtime)
        return (value as (...a: unknown[]) => unknown).apply(t, args)
      }
    },
  })
}

/** The runtime's wallet with storage that refuses once the runtime is disposed. */
export function pinnedWalletFor(runtime: WalletRuntime): ActiveWallet {
  const cached = pinnedByRuntime.get(runtime)
  if (cached) return cached
  const instance = runtime.instance
  const realWallet = instance.wallet
  const storage = guarded(realWallet.storage, runtime)
  const wallet = new Proxy(realWallet, {
    get(t, prop) {
      if (prop === 'storage') return storage
      const value = Reflect.get(t, prop, t)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        assertRuntimeCurrent(runtime)
        return (value as (...a: unknown[]) => unknown).apply(t, args)
      }
    },
  })
  const pinned: ActiveWallet = { ...instance, wallet }
  pinnedByRuntime.set(runtime, pinned)
  return pinned
}

/**
 * Drop-in for `getActiveWallet()` in storage-mutating modules. Falls back to
 * the raw wallet only when no runtime is installed (unit fixtures).
 */
export function pinnedActiveWallet(): ActiveWallet | null {
  const active = getActiveWallet()
  if (!active) return null
  const runtime = getWalletRuntime()
  if (!runtime || runtime.instance !== active) return active
  return pinnedWalletFor(runtime)
}
