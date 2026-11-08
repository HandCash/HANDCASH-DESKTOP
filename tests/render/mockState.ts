/**
 * Fixture data the render harness reads. `main.tsx` installs one fixture before
 * the first render; nothing here touches storage, keys or the network.
 *
 * Machines start in a declared snapshot (state value + context overlay), not by
 * replaying events. The live snapshot of every machine is mirrored to
 * `window.__renderStates` so the runner can check and save it beside each shot.
 */
import type { ClaimedHandleState } from '../../src/wallet/handleClaim'
import type { PublicIdentityRow } from '../../src/wallet/publicIdentities'
import type { WalletProfile } from '../../src/machines/appMachine'

/** A statechart state as data: `value` as XState writes it, plus context fields to overlay. */
export type MachineState = { value: string | Record<string, unknown>; context?: Record<string, unknown> }

export type MockState = {
  profile: WalletProfile
  claimed: ClaimedHandleState | null
  identities: PublicIdentityRow[]
  selectedIdentityKey: string | null
  presentedIdentityKey: string | null
  signsIssuance: boolean
  /** Snapshot each machine (by machine id) starts in. */
  machines: Record<string, MachineState>
}

/** What a machine is actually in after render: read back by scripts/render-states.mjs. */
export type ObservedState = { value: unknown; context: Record<string, unknown> }

declare global {
  interface Window {
    __renderStates?: Record<string, ObservedState>
  }
}

let current: MockState | null = null
const seen = new Map<string, number>()

export function installMockState(state: MockState): void {
  current = state
  seen.clear()
  window.__renderStates = {}
}

/** Stable key per actor: the machine id, then `id#2`, `id#3` for later actors of the same machine, in mount order. */
export function stateKey(machineId: string): string {
  const n = (seen.get(machineId) ?? 0) + 1
  seen.set(machineId, n)
  return n === 1 ? machineId : `${machineId}#${n}`
}

export function mockState(): MockState {
  if (!current) throw new Error('render harness: no fixture installed')
  return current
}

export function machineState(machineId: string): MachineState | undefined {
  return current?.machines[machineId]
}

/** JSON-safe copy of a context: functions (ports) and actor refs are dropped. */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value
  if (Array.isArray(value)) return value.map(plain)
  if ('send' in value && 'getSnapshot' in value) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    const copied = plain(inner)
    if (copied !== undefined) out[key] = copied
  }
  return out
}

export function recordState(key: string, value: unknown, context: unknown): void {
  const states = (window.__renderStates ??= {})
  states[key] = { value, context: plain(context) as Record<string, unknown> }
}
