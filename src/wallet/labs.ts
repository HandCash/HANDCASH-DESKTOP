import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'

/**
 * Settings → Labs. Unfinished or riskier features stay off until the user
 * turns them on on this device. Unknown or unreadable state reads as off, and
 * a wallet wipe clears the record, so every flag returns to off.
 */
export type LabFeatureId = 'inAppBrowser' | 'localHandCashHosts'

export type LabFeature = {
  id: LabFeatureId
  label: string
  description: string
}

export const LAB_FEATURES: readonly LabFeature[] = [
  {
    id: 'inAppBrowser',
    label: 'In-app browser',
    description:
      'Open connected apps inside HandCash instead of your system browser. Apps still ask before anything moves.',
  },
  {
    id: 'localHandCashHosts',
    label: 'Local HandCash hosts',
    description:
      'Treat pages on localhost as HandCash sites for migrate, handle claim and market listing. For local testing only.',
  },
]

type LabState = Partial<Record<LabFeatureId, boolean>>
type Listener = (state: Readonly<LabState>) => void

const KEY = storageRegistry.labs.key
const listeners = new Set<Listener>()

function read(): LabState {
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const state: LabState = {}
    for (const { id } of LAB_FEATURES) {
      if ((parsed as Record<string, unknown>)[id] === true) state[id] = true
    }
    return state
  } catch {
    return {}
  }
}

export function isLabEnabled(id: LabFeatureId): boolean {
  return read()[id] === true
}

export function setLabEnabled(id: LabFeatureId, enabled: boolean): void {
  const next = { ...read(), [id]: enabled }
  if (!enabled) delete next[id]
  durableSetItem(KEY, JSON.stringify(next))
  console.info(`[labs] ${id} ${enabled ? 'on' : 'off'}`)
  for (const listener of listeners) listener(next)
}

/**
 * Whether a localhost page may act as a HandCash host. Any local process can
 * serve localhost, so a shipped wallet trusts it only when the user opts in.
 */
export function trustsLocalHandCashHosts(): boolean {
  return Boolean(import.meta.env?.DEV) || isLabEnabled('localHandCashHosts')
}

export function subscribeLabs(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
