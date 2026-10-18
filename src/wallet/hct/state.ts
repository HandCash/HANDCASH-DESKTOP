import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'

/**
 * Account-scoped BRC-255 state: packages waiting for a recipient's box and
 * the transactions each peer is known to hold, so a package to that peer
 * stops there (§6). Chain facts live in `store.ts`.
 */

/** One output's remittance as the recipient reads it: it derives the holder key from these and the sender. */
export type HctDeliveryOutput = { vout: number; derivationPrefix: string; derivationSuffix: string }

export type HctOutboxEntry = {
  recipient: string
  assetId: string
  txid: string
  outputs: HctDeliveryOutput[]
  at: number
  attempts: number
  nextAt: number
  lastError?: string
}

export type HctState = {
  outbox: Record<string, HctOutboxEntry>
  /** peer identity → asset id → txids that peer holds. */
  frontier: Record<string, Record<string, string[]>>
}

const MAX_FRONTIER = 256

function key(): string {
  return accountLocalKey(storageRegistry.hct.key)
}

export function readHctState(): HctState {
  try {
    const parsed = JSON.parse(durableGetItem(key()) ?? '{}') as Partial<HctState>
    return { outbox: parsed.outbox ?? {}, frontier: parsed.frontier ?? {} }
  } catch {
    return { outbox: {}, frontier: {} }
  }
}

export function writeHctState(state: HctState): void {
  if (!durableSetItem(key(), JSON.stringify(state))) {
    throw new Error('The HCT record could not be saved.')
  }
}

export function outboxId(recipient: string, txid: string): string {
  return `${recipient.toLowerCase()}:${txid.toLowerCase()}`
}

export function peerHolds(state: HctState, peer: string, assetId: string): Set<string> {
  return new Set(state.frontier[peer.toLowerCase()]?.[assetId] ?? [])
}

/** Newest last; the oldest fall off, so a package only grows back to what the peer may have pruned. */
export function notePeerHolds(state: HctState, peer: string, assetId: string, txids: readonly string[]): void {
  const who = peer.toLowerCase()
  const byAsset = (state.frontier[who] ??= {})
  const list = (byAsset[assetId] ?? []).filter((t) => !txids.includes(t))
  byAsset[assetId] = [...list, ...txids].slice(-MAX_FRONTIER)
}
