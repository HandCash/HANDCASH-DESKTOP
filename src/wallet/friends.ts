import { P2PKH, PublicKey } from '@bsv/sdk'
import type { Chain } from './vault'
import { durableGetItem, durableSetItem } from './durableStorage'
import { formatHandCashHandle } from './handleFormat'
import { tryParsePeerPayUri } from './peerPayUri'
import { parseHandleInput, resolveHandle } from './handleResolve'

const STORAGE_KEY = 'handcash.brc100.friends'

export type Friend = {
  id: string
  label: string
  identityKey: string
  createdAt: number
  /**
   * BRC-169 messagebox base URL for this peer (from handle resolve).
   * When absent, chat falls back to the HandCash BRC-CLOUD convenience box.
   */
  messagebox?: string | null
  /**
   * When set, this friend was identified by a BRC-169 handle.
   * Handles are fixed display identity — local custom labels are not allowed.
   * Value is the canonical display (`$alice` or `@alice@domain`).
   */
  handle?: string | null
}

/**
 * Legacy handle friends often only stored `$alice` / `@alice@domain` as `label`
 * (no `handle` field). Bare names are treated as custom labels, not fixed handles.
 */
export function labelLooksLikeFixedHandle(label: string): boolean {
  const t = label.trim()
  if (!t.startsWith('$') && !t.startsWith('@')) return false
  return Boolean(parseHandleInput(t))
}

/** True when the friend's display identity is a handle and must not be renamed. */
export function friendHasFixedHandle(
  friend: Pick<Friend, 'label' | 'handle'>,
): boolean {
  if (typeof friend.handle === 'string' && friend.handle.trim()) return true
  return labelLooksLikeFixedHandle(friend.label)
}

type FriendsListener = (friends: Friend[]) => void

const listeners = new Set<FriendsListener>()

function notify(friends: Friend[]) {
  for (const listener of listeners) listener(friends)
}

function readRaw(): Friend[] {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Friend[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (f) =>
        f &&
        typeof f.id === 'string' &&
        typeof f.label === 'string' &&
        typeof f.identityKey === 'string',
    ).map((f) => ({
      ...f,
      messagebox:
        typeof f.messagebox === 'string' && f.messagebox.trim()
          ? f.messagebox.trim().replace(/\/+$/, '')
          : f.messagebox === null
            ? null
            : undefined,
      handle:
        typeof f.handle === 'string' && f.handle.trim()
          ? f.handle.trim()
          : f.handle === null
            ? null
            : undefined,
    }))
  } catch {
    return []
  }
}

function writeAll(friends: Friend[]) {
  durableSetItem(STORAGE_KEY, JSON.stringify(friends))
  notify(friends)
}

export function listFriends(): Friend[] {
  return readRaw().slice().sort((a, b) => a.label.localeCompare(b.label))
}

/** Merge friends by identity key (keeps existing labels). */
export function mergeFriends(incoming: Friend[]): number {
  const local = readRaw()
  const byIk = new Map(local.map((f) => [f.identityKey, f]))
  let added = 0
  for (const friend of incoming) {
    if (!friend?.identityKey || !friend.label) continue
    const existing = byIk.get(friend.identityKey)
    if (existing) {
      let next = existing
      if (!existing.messagebox && friend.messagebox) {
        next = { ...next, messagebox: friend.messagebox }
      }
      if (!existing.handle && friend.handle) {
        next = { ...next, handle: friend.handle }
      }
      if (next !== existing) byIk.set(friend.identityKey, next)
      continue
    }
    byIk.set(friend.identityKey, friend)
    added += 1
  }
  writeAll([...byIk.values()])
  return added
}

export function subscribeFriends(listener: FriendsListener): () => void {
  listeners.add(listener)
  listener(listFriends())
  return () => {
    listeners.delete(listener)
  }
}

export function addressFromIdentityKey(identityKey: string, chain: Chain): string {
  const prefix = chain === 'main' ? 'mainnet' : 'testnet'
  return PublicKey.fromString(identityKey.trim()).toAddress(prefix)
}

/** Accept a P2PKH address, identity key, or BRC-125 peerpay URI; returns a lockable address. */
export function resolvePaymentAddress(recipient: string, chain: Chain): string {
  const value = recipient.trim()
  if (!value) throw new Error('Recipient required')

  const peer = tryParsePeerPayUri(value)
  if (peer) return addressFromIdentityKey(peer.identityKey, chain)

  try {
    new P2PKH().lock(value)
    return value
  } catch {
    // not a payment address — try identity key
  }

  try {
    return addressFromIdentityKey(value, chain)
  } catch {
    if (parseHandleInput(value)) {
      throw new Error(
        'Handle must be resolved before send — use $handle in the recipient field and wait for it to resolve',
      )
    }
    throw new Error('Invalid recipient address, identity key, or peerpay URI')
  }
}

/**
 * Same as resolvePaymentAddress, plus BRC-169 `$handle` / paymail-shaped resolve
 * against BRC-CLOUD.
 */
export async function resolvePaymentRecipient(
  recipient: string,
  chain: Chain,
): Promise<string> {
  const value = recipient.trim()
  if (!value) throw new Error('Recipient required')

  // Concrete address / key / peerpay first — never send a base58 address through
  // handle resolve (bare-handle grammar can look similar).
  try {
    return resolvePaymentAddress(value, chain)
  } catch (err) {
    if (!parseHandleInput(value)) throw err
  }

  const resolved = await resolveHandle(value)
  return addressFromIdentityKey(resolved.identityKey, chain)
}

/**
 * Return the recipient public key when the supplied target carries one.
 *
 * A bare P2PKH address deliberately returns null: its HASH160 cannot be
 * reversed into the public key required by a hardened BRC-156 covenant. The
 * send path then falls back to BRC-150 instead of pretending it hardened.
 */
export function identityKeyFromRecipient(recipient: string): string | null {
  const value = recipient.trim()
  if (!value) return null
  const peer = tryParsePeerPayUri(value)
  if (peer) return normalizeIdentityKey(peer.identityKey)
  try {
    return PublicKey.fromString(value).toString()
  } catch {
    return null
  }
}

export function normalizeIdentityKey(identityKey: string): string {
  return identityKey.trim().toLowerCase()
}

export function validateIdentityKey(identityKey: string): string | null {
  const key = normalizeIdentityKey(identityKey)
  if (!key) return 'Identity key is required'
  try {
    PublicKey.fromString(key)
    return null
  } catch {
    return 'Invalid identity key'
  }
}

export function addFriend(args: {
  label: string
  identityKey: string
  messagebox?: string | null
  /** Canonical handle display when the friend was added via handle resolve. */
  handle?: string | null
}): Friend {
  const label = args.label.trim()
  const identityKey = normalizeIdentityKey(args.identityKey)
  if (!label) throw new Error('Label is required')
  const invalid = validateIdentityKey(identityKey)
  if (invalid) throw new Error(invalid)

  const friends = readRaw()
  if (friends.some((f) => f.identityKey === identityKey)) {
    throw new Error('Friend already added')
  }

  const messagebox =
    typeof args.messagebox === 'string' && args.messagebox.trim()
      ? args.messagebox.trim().replace(/\/+$/, '')
      : args.messagebox === null
        ? null
        : undefined

  const handle =
    typeof args.handle === 'string' && args.handle.trim()
      ? args.handle.trim()
      : args.handle === null
        ? null
        : undefined

  const friend: Friend = {
    id: `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`,
    label,
    identityKey,
    createdAt: Date.now(),
    ...(messagebox !== undefined ? { messagebox } : {}),
    ...(handle !== undefined ? { handle } : {}),
  }
  writeAll([...friends, friend])
  void import('./appActivity').then(({ recordWalletEvent, WALLET_ACTIVITY_ORIGIN }) => {
    recordWalletEvent({
      origin: WALLET_ACTIVITY_ORIGIN,
      method: 'add-friend',
      note: `Added friend ${label}`,
    })
  })
  return friend
}

/**
 * Add a friend from `$handle` / `@handle` / bare handle, peerpay URI, or
 * identity key. Handle resolve uses BRC-CLOUD; label defaults to `$handle`
 * when omitted. Handle-identified friends lock the display to the handle —
 * custom labels are ignored.
 */
export async function addFriendFromRecipient(args: {
  label?: string
  recipient: string
}): Promise<Friend> {
  const value = args.recipient.trim()
  if (!value) throw new Error('Handle or identity key is required')

  let identityKey: string
  let suggestedLabel = ''
  let messagebox: string | null | undefined
  let fixedHandle: string | undefined

  const peer = tryParsePeerPayUri(value)
  if (peer) {
    identityKey = normalizeIdentityKey(peer.identityKey)
  } else if (parseHandleInput(value)) {
    const resolved = await resolveHandle(value)
    identityKey = normalizeIdentityKey(resolved.identityKey)
    fixedHandle = formatHandCashHandle(resolved.handle, resolved.domain)
    suggestedLabel = fixedHandle
    messagebox = resolved.messagebox
  } else {
    identityKey = normalizeIdentityKey(value)
    const invalid = validateIdentityKey(identityKey)
    if (invalid) throw new Error(invalid)
    if (!suggestedLabel) {
      suggestedLabel =
        identityKey.length <= 16
          ? identityKey
          : `${identityKey.slice(0, 8)}…${identityKey.slice(-6)}`
    }
  }

  // Handle = fixed identity. Never accept a custom label override.
  const label = fixedHandle || args.label?.trim() || suggestedLabel
  if (!label) throw new Error('Label is required')
  return addFriend({
    label,
    identityKey,
    messagebox,
    ...(fixedHandle ? { handle: fixedHandle } : {}),
  })
}

export function getFriendById(id: string): Friend | null {
  return readRaw().find((f) => f.id === id) ?? null
}

export function updateFriend(
  id: string,
  patch: { label?: string; identityKey?: string; messagebox?: string | null },
): Friend {
  const friends = readRaw()
  const index = friends.findIndex((f) => f.id === id)
  if (index < 0) throw new Error('Friend not found')

  const current = friends[index]!
  const label = patch.label !== undefined ? patch.label.trim() : current.label
  const identityKey =
    patch.identityKey !== undefined
      ? normalizeIdentityKey(patch.identityKey)
      : current.identityKey

  if (!label) throw new Error('Label is required')
  if (
    friendHasFixedHandle(current) &&
    patch.label !== undefined &&
    label !== current.label
  ) {
    throw new Error('Handle is fixed — custom labels are not allowed')
  }
  const invalid = validateIdentityKey(identityKey)
  if (invalid) throw new Error(invalid)

  if (
    friends.some((f) => f.id !== id && f.identityKey === identityKey)
  ) {
    throw new Error('Friend already added')
  }

  const messagebox =
    patch.messagebox !== undefined
      ? typeof patch.messagebox === 'string' && patch.messagebox.trim()
        ? patch.messagebox.trim().replace(/\/+$/, '')
        : patch.messagebox
      : current.messagebox

  const updated: Friend = {
    ...current,
    label,
    identityKey,
    ...(messagebox !== undefined ? { messagebox } : {}),
  }
  const next = friends.slice()
  next[index] = updated
  writeAll(next)
  return updated
}

export function removeFriend(id: string) {
  writeAll(readRaw().filter((f) => f.id !== id))
}

export function searchFriends(query: string, friends = listFriends()): Friend[] {
  const q = query.trim().toLowerCase()
  if (!q) return friends
  return friends.filter(
    (f) =>
      f.label.toLowerCase().includes(q) ||
      f.identityKey.toLowerCase().includes(q),
  )
}

export function findFriendByAddress(
  address: string,
  chain: Chain,
  friends = listFriends(),
): Friend | null {
  const target = address.trim()
  if (!target) return null
  for (const friend of friends) {
    try {
      if (addressFromIdentityKey(friend.identityKey, chain) === target) return friend
    } catch {
      // skip invalid stored keys
    }
  }
  return null
}
