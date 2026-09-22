import type { ActiveWallet } from './session'

export type WalletRuntimeId = string & { readonly __walletRuntimeId: unique symbol }

export type WalletRuntime = Readonly<{
  instance: ActiveWallet
  runtimeId: WalletRuntimeId
  generation: number
  storageNamespace: string
  signal: AbortSignal
}>

export type WalletRuntimeLifecycle = Readonly<{
  name: string
  start?: (runtime: WalletRuntime) => void
  dispose?: (runtime: WalletRuntime, reason: WalletRuntimeDisposeReason) => void
}>

export type WalletRuntimeDisposeReason =
  | 'account-changed'
  | 'locked'
  | 'replaced'
  | 'test'

type RuntimeRecord = {
  runtime: WalletRuntime
  abort: AbortController
}

type RuntimeState = {
  generation: number
  current: RuntimeRecord | null
  lifecycle: Map<string, WalletRuntimeLifecycle>
}

const RUNTIME_STATE = Symbol.for('handcash.wallet.runtime-state')
const runtimeGlobals = globalThis as typeof globalThis & {
  [RUNTIME_STATE]?: RuntimeState
}
const state =
  runtimeGlobals[RUNTIME_STATE] ??
  (runtimeGlobals[RUNTIME_STATE] = {
    generation: 0,
    current: null,
    lifecycle: new Map(),
  })

function runtimeIdFor(
  wallet: Pick<ActiveWallet, 'chain' | 'identityKey' | 'accountIndex'>,
  generationValue: number,
): WalletRuntimeId {
  return `${wallet.chain}:${wallet.accountIndex}:${wallet.identityKey}:${generationValue}` as WalletRuntimeId
}

export function walletStorageNamespace(
  wallet: Pick<ActiveWallet, 'chain' | 'identityKey' | 'accountIndex'>,
): string {
  return `${wallet.chain}:${wallet.accountIndex}:${wallet.identityKey}`
}

export function installWalletRuntime(instance: ActiveWallet): WalletRuntime {
  const nextGeneration = ++state.generation
  const abort = new AbortController()
  const runtime = Object.freeze({
    instance,
    runtimeId: runtimeIdFor(instance, nextGeneration),
    generation: nextGeneration,
    storageNamespace: walletStorageNamespace(instance),
    signal: abort.signal,
  })
  if (state.current) disposeWalletRuntime('replaced')
  state.current = { runtime, abort }
  for (const hook of state.lifecycle.values()) hook.start?.(runtime)
  return runtime
}

export function disposeWalletRuntime(reason: WalletRuntimeDisposeReason): void {
  const record = state.current
  if (!record) return
  state.current = null
  record.abort.abort(reason)
  const hooks = [...state.lifecycle.values()].reverse()
  for (const hook of hooks) {
    try {
      hook.dispose?.(record.runtime, reason)
    } catch (error) {
      console.warn(
        `[wallet-runtime] ${hook.name} dispose failed`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export function getWalletRuntime(): WalletRuntime | null {
  return state.current?.runtime ?? null
}

export function requireWalletRuntime(): WalletRuntime {
  const runtime = getWalletRuntime()
  if (!runtime) throw new Error('WALLET_LOCKED')
  return runtime
}

export function runtimeIsCurrent(runtime: WalletRuntime): boolean {
  return state.current?.runtime.runtimeId === runtime.runtimeId && !runtime.signal.aborted
}

export function assertRuntimeCurrent(runtime: WalletRuntime): void {
  if (!runtimeIsCurrent(runtime)) throw new DOMException('Wallet runtime disposed', 'AbortError')
}

export function registerWalletRuntimeLifecycle(hook: WalletRuntimeLifecycle): () => void {
  if (state.lifecycle.has(hook.name)) {
    throw new Error(`Wallet runtime lifecycle already registered: ${hook.name}`)
  }
  state.lifecycle.set(hook.name, hook)
  const runtime = state.current?.runtime
  if (runtime) hook.start?.(runtime)
  return () => state.lifecycle.delete(hook.name)
}

export function resetWalletRuntimeForTests(): void {
  disposeWalletRuntime('test')
  state.lifecycle.clear()
  state.generation = 0
}
