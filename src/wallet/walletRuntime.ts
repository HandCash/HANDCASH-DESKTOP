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
  backgroundRefs: number
  detached: boolean
}

type RuntimeState = {
  generation: number
  current: RuntimeRecord | null
  background: Map<WalletRuntimeId, RuntimeRecord>
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
    background: new Map(),
    lifecycle: new Map(),
  })
// Hot reload can preserve the pre-background runtime shape.
state.background ??= new Map()

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
  state.current = { runtime, abort, backgroundRefs: 0, detached: false }
  for (const hook of state.lifecycle.values()) hook.start?.(runtime)
  return runtime
}

export function disposeWalletRuntime(reason: WalletRuntimeDisposeReason): void {
  const record = state.current
  if (record) {
    state.current = null
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
    if (reason === 'account-changed' && record.backgroundRefs > 0) {
      // Foreground feature state is disposed above, but a signed action keeps
      // its immutable wallet instance long enough to finish propagation. It
      // must never become current again or inherit the next account's stores.
      record.detached = true
      state.background.set(record.runtime.runtimeId, record)
    } else {
      record.abort.abort(reason)
    }
  }
  if (reason === 'locked' || reason === 'test') {
    for (const background of state.background.values()) {
      background.abort.abort(reason)
    }
    state.background.clear()
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

/** A captured runtime may continue only while a signed background action retains it. */
export function runtimeCanRunInBackground(runtime: WalletRuntime): boolean {
  if (runtimeIsCurrent(runtime)) return true
  const record = state.background.get(runtime.runtimeId)
  return !!record && record.backgroundRefs > 0 && !runtime.signal.aborted
}

export function assertRuntimeAvailable(runtime: WalletRuntime): void {
  if (!runtimeCanRunInBackground(runtime)) {
    throw new DOMException('Wallet runtime disposed', 'AbortError')
  }
}

export type WalletRuntimeRetention = Readonly<{
  runtime: WalletRuntime
  release: () => void
}>

/**
 * Keep the immutable wallet instance alive across an account switch.
 *
 * This is intentionally explicit and reference-counted. General wallet work
 * still requires the current runtime; only an operation holding this retention
 * may use a detached wallet in the background.
 */
export function retainWalletRuntime(
  runtime: WalletRuntime = requireWalletRuntime(),
): WalletRuntimeRetention {
  const record =
    state.current?.runtime.runtimeId === runtime.runtimeId
      ? state.current
      : state.background.get(runtime.runtimeId)
  if (!record || runtime.signal.aborted) {
    throw new DOMException('Wallet runtime disposed', 'AbortError')
  }
  record.backgroundRefs += 1
  let released = false
  return Object.freeze({
    runtime,
    release: () => {
      if (released) return
      released = true
      record.backgroundRefs = Math.max(0, record.backgroundRefs - 1)
      if (record.detached && record.backgroundRefs === 0) {
        state.background.delete(runtime.runtimeId)
        record.abort.abort('account-changed')
      }
    },
  })
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
  for (const background of state.background.values()) {
    background.abort.abort('test')
  }
  state.background.clear()
  state.lifecycle.clear()
  state.generation = 0
}
