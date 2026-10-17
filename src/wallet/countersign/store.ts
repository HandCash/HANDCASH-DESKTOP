import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'
import type { BeaconChainView, CountersignPhase } from './beacon'
import type { CountersignDeployFields } from './payload'
import type { AcceptRefusal, CountersignDeploy } from './resolve'
import type { CountersignKeySets } from './script'

/** A deploy as stored: the icon bytes stay in the deploy body, not here. */
export type StoredDeploy = Omit<CountersignDeploy, 'fields'> & {
  fields: Omit<CountersignDeployFields, 'icon'> & { iconMediaType?: string }
}

/** The acceptor's accept-once record for one asset this wallet issued. */
export type AcceptorRecord = {
  assetId: string
  /** Countersigned outputs accepted and not yet spent by an accepted transfer. */
  accepted: string[]
  /** Outpoint → the request that spent it. */
  spent: Record<string, string>
  /** Request id → the transaction this acceptor signed for it, Extended Format hex. */
  requests: Record<string, { txid: string; efHex: string; at: number }>
  cancelled: string[]
  /** Current beacon outpoint and the body that holds it. */
  beacon: string
  beaconTxHex?: string
  beaconAt: number
  /** Set once: this issuer never countersigns or refreshes the beacon again. */
  ended?: 'retired' | 'lapsed' | 'released'
}

/** The beacon chain as last read, and the phase it gave. */
export type StoredPhase = { view: BeaconChainView; phase: CountersignPhase; checkedAt: number }

export type OutgoingRequest = {
  requestId: string
  assetId: string
  efHex: string
  recipient: string
  amount: string
  acceptors: string[]
  inputs: string[]
  state: 'open' | 'accepted' | 'refused' | 'cancelled'
  reason?: AcceptRefusal
  txid?: string
  at: number
}

export type CountersignState = {
  deploys: Record<string, StoredDeploy>
  acceptor: Record<string, AcceptorRecord>
  outgoing: Record<string, OutgoingRequest>
  phases: Record<string, StoredPhase>
}

function key(): string {
  return accountLocalKey(storageRegistry.countersign.key)
}

export function readCountersignState(): CountersignState {
  try {
    const parsed = JSON.parse(durableGetItem(key()) ?? '{}') as Partial<CountersignState>
    return {
      deploys: parsed.deploys ?? {},
      acceptor: parsed.acceptor ?? {},
      outgoing: parsed.outgoing ?? {},
      phases: parsed.phases ?? {},
    }
  } catch {
    return { deploys: {}, acceptor: {}, outgoing: {}, phases: {} }
  }
}

/** One durable write: the accept-once step is all or nothing. */
export function writeCountersignState(state: CountersignState): void {
  if (!durableSetItem(key(), JSON.stringify(state))) {
    throw new Error('The countersign record could not be saved; nothing was signed.')
  }
}

export function toStoredDeploy(deploy: CountersignDeploy): StoredDeploy {
  const { icon, ...fields } = deploy.fields
  return { ...deploy, fields: { ...fields, ...(icon ? { iconMediaType: icon.mediaType } : {}) } }
}

export function deployForResolve(stored: StoredDeploy): CountersignDeploy {
  const { iconMediaType: _icon, ...fields } = stored.fields
  return { ...stored, fields }
}

export function deployMap(state: CountersignState): Map<string, CountersignDeploy> {
  return new Map(Object.values(state.deploys).map((d) => [d.assetId, deployForResolve(d)]))
}

export function keySetsEqual(a: CountersignKeySets, b: CountersignKeySets): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
