import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { storageRegistry } from '../storage/registry'

/**
 * Identity keys whose message box mail this account ignores. The inbox poll
 * and the direct-session path drop their messages as they arrive (BRC-33
 * acknowledge), payment notices included. Local to this account on this device.
 */
export type BlockedSender = { identityKey: string; name: string; at: number }

const listeners = new Set<() => void>()

function storageKey(): string {
  return accountLocalKey(storageRegistry.blockedSenders.key)
}

function normalize(identityKey: string): string {
  return identityKey.trim().toLowerCase()
}

export function listBlockedSenders(): BlockedSender[] {
  try {
    const raw = durableGetItem(storageKey())
    const parsed = raw ? (JSON.parse(raw) as BlockedSender[]) : []
    return Array.isArray(parsed)
      ? parsed.filter((b) => b && /^0[23][0-9a-f]{64}$/.test(b.identityKey))
      : []
  } catch {
    return []
  }
}

export function isSenderBlocked(identityKey: string): boolean {
  const key = normalize(identityKey)
  return !!key && listBlockedSenders().some((b) => b.identityKey === key)
}

function write(next: BlockedSender[]): void {
  durableSetItem(storageKey(), JSON.stringify(next))
  for (const listener of listeners) listener()
}

export function blockSender(identityKey: string, name: string): void {
  const key = normalize(identityKey)
  if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new Error('Not an identity key')
  const rest = listBlockedSenders().filter((b) => b.identityKey !== key)
  write([...rest, { identityKey: key, name: name.trim() || key, at: Date.now() }])
}

export function unblockSender(identityKey: string): void {
  const key = normalize(identityKey)
  write(listBlockedSenders().filter((b) => b.identityKey !== key))
}

export function subscribeBlockedSenders(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
