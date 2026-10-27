import { createEcpmModule } from '@bsv/ecpm-permission-module'
import { KeyDeriver, type PrivateKey, type WalletInterface } from '@bsv/sdk'
import { requestEcpmApproval } from './permissions'
import { getWalletRuntime, registerWalletRuntimeLifecycle, runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

type Entry = { module: ReturnType<typeof createEcpmModule>; unregister: () => void; abort: AbortController }
const modules = new Map<string, Entry>()

/** Only the exact implemented namespace is exempt from the BRC-98 refusal. */
export function isEcpmRequest(method: string, args: unknown): boolean {
  if (method !== 'getPublicKey' || !args || typeof args !== 'object') return false
  const protocol = (args as { protocolID?: unknown }).protocolID
  return Array.isArray(protocol) && typeof protocol[1] === 'string' && /^p ecpm(?: |$)/.test(protocol[1])
}

/** Revoking app/session permissions must also revoke these memory-only grants. */
export function clearEcpmPermissions(): void {
  for (const entry of modules.values()) {
    entry.abort.abort()
    entry.module.dispose()
    entry.unregister()
  }
  modules.clear()
}

function assertCurrent(runtime: WalletRuntime): void {
  if (!runtimeIsCurrent(runtime)) throw new Error('ECPM wallet session changed')
}

export async function dispatchEcpm(wallet: WalletInterface, args: unknown, originator: string): Promise<unknown> {
  const runtime = getWalletRuntime()
  if (!runtime || runtime.instance.wallet !== wallet) throw new Error('ECPM requires the active unlocked wallet')
  assertCurrent(runtime)
  let entry = modules.get(runtime.runtimeId)
  if (!entry) {
    // Trusted wallet capabilities never cross the bridge. The current engine
    // keeps privileged retrieval internal; incompatible/unavailable hosts refuse.
    const host = runtime.instance.wallet
    const abort = new AbortController()
    const module = createEcpmModule({
      keyDeriver: host.keyDeriver,
      authorize: async request => {
        assertCurrent(runtime)
        const allowed = await requestEcpmApproval(request, abort.signal)
        assertCurrent(runtime)
        return allowed
      },
      privilegedKeyDeriver: async reason => {
        assertCurrent(runtime)
        const manager = host.privilegedKeyManager as unknown as {
          getPrivilegedKey?: (reason: string) => Promise<PrivateKey>
        } | undefined
        if (typeof manager?.getPrivilegedKey !== 'function') throw new Error('ECPM privileged keys are unavailable')
        const key = await manager.getPrivilegedKey(reason)
        assertCurrent(runtime)
        return new KeyDeriver(key)
      }
    })
    const unregister = registerWalletRuntimeLifecycle({
      name: `ecpm:${runtime.runtimeId}`,
      dispose: disposed => {
        if (disposed.runtimeId !== runtime.runtimeId) return
        abort.abort()
        module.dispose()
        modules.delete(runtime.runtimeId)
        unregister()
      }
    })
    entry = { module, unregister, abort }
    modules.set(runtime.runtimeId, entry)
  }
  const captured = entry
  const result = await entry.module.handleRequest({ method: 'getPublicKey', args: args as object, originator }, async () => {
    throw new Error('ECPM must never use ordinary public-key derivation')
  })
  assertCurrent(runtime)
  if (modules.get(runtime.runtimeId) !== captured) throw new Error('ECPM permissions changed')
  return result
}
