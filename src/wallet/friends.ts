import { P2PKH, PublicKey } from '@bsv/sdk'
import type { Chain } from './vault'
import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { formatHandCashHandle } from './handleFormat'
import { verifiedForwarding, type ForwardingRecord } from './handleForwarding'
import { tryParsePeerPayUri } from './peerPayUri'
import {
  createHandleResolveDebouncer,
  HANDLE_RESOLVE_DEBOUNCE_MS,
  HandleRevokedError,
  parseHandleInput,
  resolveHandle,
  type HandleResolveDebouncer,
  type ResolvedHandle,
} from './handleResolve'
import { storageRegistry } from '../storage/registry'

const STORAGE_KEY_BASE = storageRegistry.friends.key

function friendsStorageKey(): string {
  return accountLocalKey(STORAGE_KEY_BASE)
}

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
  /**
   * Optional wallet protocols from handle resolve (`coin:ltc`, …).
   * Copied locally so a send can check them without another round trip.
   */
  protocols?: string[]
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
    const raw = durableGetItem(friendsStorageKey())
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
      protocols: Array.isArray(f.protocols)
        ? f.protocols.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map((p) => p.trim().toLowerCase())
        : undefined,
    }))
  } catch {
    return []
  }
}

function writeAll(friends: Friend[]) {
  durableSetItem(friendsStorageKey(), JSON.stringify(friends))
  notify(friends)
}

export function rebindFriendsForAccount(): void {
  notify(listFriends())
}

export function listFriends(): Friend[] {
  return readRaw().slice().sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Merge friends by identity key (keeps existing labels). A synced friend that
 * names a handle this device already pins to another key is skipped: another
 * device cannot repoint a saved handle.
 */
export function mergeFriends(incoming: Friend[]): number {
  const local = readRaw()
  const byIk = new Map(local.map((f) => [f.identityKey, f]))
  const pins = new Map<string, string>()
  for (const f of local) {
    const key = friendHandleKey(f)
    if (key) pins.set(key, normalizeIdentityKey(f.identityKey))
  }
  let added = 0
  for (const friend of incoming) {
    if (!friend?.identityKey || !friend.label) continue
    const handle = friendHandleKey(friend)
    const pinnedTo = handle ? pins.get(handle) : undefined
    if (pinnedTo && pinnedTo !== normalizeIdentityKey(friend.identityKey)) {
      console.warn(`[friends] sync skipped ${handle}: pinned here to another identity key`)
      continue
    }
    const existing = byIk.get(friend.identityKey)
    if (existing) {
      let next = existing
      if (!existing.messagebox && friend.messagebox) {
        next = { ...next, messagebox: friend.messagebox }
      }
      if (
        (!existing.protocols || existing.protocols.length === 0) &&
        friend.protocols &&
        friend.protocols.length > 0
      ) {
        next = { ...next, protocols: friend.protocols }
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

/**
 * Who a payment goes to. An identity key is paid at a fresh BRC-29 child of
 * it, never at its own address: a BRC-100 wallet holds no key for the
 * identity address. A bare address is paid as given.
 */
export type PaymentTarget =
  | { kind: 'identity'; identityKey: string }
  | { kind: 'address'; address: string }

/** Accept a P2PKH address, identity key, or BRC-125 peerpay URI. */
export function resolvePaymentTarget(recipient: string): PaymentTarget {
  const value = recipient.trim()
  if (!value) throw new Error('Recipient required')

  const peer = tryParsePeerPayUri(value)
  if (peer) return { kind: 'identity', identityKey: normalizeIdentityKey(peer.identityKey) }

  try {
    new P2PKH().lock(value)
    return { kind: 'address', address: value }
  } catch {
    // not a payment address — try identity key
  }

  try {
    return { kind: 'identity', identityKey: PublicKey.fromString(value).toString() }
  } catch {
    if (parseHandleInput(value)) {
      throw new Error(
        'Handle must be resolved before send — use $handle in the recipient field and wait for it to resolve',
      )
    }
    throw new Error('Invalid recipient address, identity key, or peerpay URI')
  }
}

/** True when the target is this wallet: its identity key, or the identity address earlier releases paid. */
export function paymentTargetIsSelf(
  target: PaymentTarget,
  wallet: { identityKey: string; address: string },
): boolean {
  return target.kind === 'identity'
    ? target.identityKey === normalizeIdentityKey(wallet.identityKey)
    : target.address === wallet.address
}

/**
 * Same as resolvePaymentTarget, plus BRC-169 `$handle` / paymail-shaped resolve
 * against BRC-CLOUD. `label` is the recipient the user confirmed; when it is a
 * handle a saved friend pins, the destination must still be that friend's key.
 */
export async function resolvePaymentRecipient(
  recipient: string,
  chain: Chain,
  opts: { label?: string | null } = {},
): Promise<PaymentTarget> {
  const value = recipient.trim()
  if (!value) throw new Error('Recipient required')

  // Concrete address / key / peerpay first — never send a base58 address through
  // handle resolve (bare-handle grammar can look similar).
  let target: PaymentTarget | null = null
  try {
    target = resolvePaymentTarget(value)
  } catch (err) {
    if (!parseHandleInput(value)) throw err
  }
  if (target == null) {
    const resolved = await resolvePinnedHandle(value)
    target = { kind: 'identity', identityKey: normalizeIdentityKey(resolved.identityKey) }
  }
  refuseBoundHandleConflict(
    opts.label,
    target.kind === 'identity' ? { identityKey: target.identityKey } : { address: target.address },
    chain,
  )
  return target
}

/** A handle now answers another key than the saved friend that pins it. */
export class HandleKeyChangedError extends Error {
  readonly handle: string
  readonly friendLabel: string
  constructor(handle: string, friendLabel: string) {
    super(
      `${handle} now points to a different identity key than your saved friend "${friendLabel}". ` +
        'Nothing was sent. Confirm the change with them another way, then remove that friend to accept the new key.',
    )
    this.name = 'HandleKeyChangedError'
    this.handle = handle
    this.friendLabel = friendLabel
  }
}

/** Canonical handle display (`$alice`, `@alice@other.domain`), lower-cased for comparison. */
function handleKey(raw: string | null | undefined): string | null {
  const parsed = raw ? parseHandleInput(raw) : null
  return parsed ? formatHandCashHandle(parsed.handle, parsed.domain).toLowerCase() : null
}

/** The handle a friend pins: its handle field, else a legacy handle-shaped label. */
function friendHandleKey(friend: Pick<Friend, 'handle' | 'label'>): string | null {
  return handleKey(friend.handle?.trim() || (labelLooksLikeFixedHandle(friend.label) ? friend.label : null))
}

/**
 * The saved friend that pins this handle. Legacy friends stored the handle
 * only as their label, and pin it the same way.
 */
function friendPinningHandle(handle: string): Friend | null {
  const wanted = handleKey(handle)
  if (!wanted) return null
  return (
    readRaw().find((f) => friendHandleKey(f) === wanted) ?? null
  )
}

/**
 * A handle saved as a friend stays pinned to the key it resolved to then. A
 * resolve that now answers another key means the host reassigned the handle
 * (or lies), so paying or re-adding it refuses until the old friend is removed.
 */
export function refuseHandleKeyChange(resolved: ResolvedHandle): void {
  const handle = formatHandCashHandle(resolved.handle, resolved.domain)
  const pinned = friendPinningHandle(handle)
  if (pinned && normalizeIdentityKey(pinned.identityKey) !== normalizeIdentityKey(resolved.identityKey)) {
    throw new HandleKeyChangedError(handle, pinned.label)
  }
}

/**
 * A saved friend released this handle and, signing with the key the friend is
 * pinned to, named where they went (BRC-169 §4.3). Nothing follows it: the
 * user confirms with them and adds the new handle themselves.
 */
export class HandleMovedError extends Error {
  readonly handle: string
  readonly friendLabel: string
  readonly forwarding: ForwardingRecord
  constructor(handle: string, friendLabel: string, forwarding: ForwardingRecord) {
    super(
      `Your friend "${friendLabel}" released ${handle} and says they moved to ${forwarding.toHandle}. ` +
        'Nothing was sent. Confirm with them, then add the new handle as a friend.',
    )
    this.name = 'HandleMovedError'
    this.handle = handle
    this.friendLabel = friendLabel
    this.forwarding = forwarding
  }
}

/** Resolve a handle and refuse it when a saved friend pins it to another key. */
export async function resolvePinnedHandle(raw: string): Promise<ResolvedHandle> {
  let resolved: ResolvedHandle
  try {
    resolved = await resolveHandle(raw)
  } catch (error) {
    const parsed = error instanceof HandleRevokedError && error.forwarding ? parseHandleInput(raw) : null
    if (parsed) {
      const handle = formatHandCashHandle(parsed.handle, parsed.domain)
      const pinned = friendPinningHandle(handle)
      const forwarding = pinned && verifiedForwarding((error as HandleRevokedError).forwarding, pinned.identityKey)
      if (pinned && forwarding) throw new HandleMovedError(handle, pinned.label, forwarding)
    }
    throw error
  }
  refuseHandleKeyChange(resolved)
  return resolved
}

/** The typing debouncer every recipient field uses, with the friend pin applied. */
export function createPinnedHandleResolveDebouncer(): HandleResolveDebouncer {
  return createHandleResolveDebouncer(HANDLE_RESOLVE_DEBOUNCE_MS, resolvePinnedHandle)
}

/**
 * Last check before signing: a payment confirmed to a handle a saved friend
 * pins must still go to that friend's key. Local only — no resolve.
 */
export function refuseBoundHandleConflict(
  label: string | null | undefined,
  destination: { identityKey?: string | null; address?: string | null },
  chain: Chain,
): void {
  // A custom label such as "alice" parses as a bare handle; only `$` / `@` names one.
  if (!label || !labelLooksLikeFixedHandle(label)) return
  const pinned = friendPinningHandle(label)
  if (!pinned) return
  const key = destination.identityKey ? normalizeIdentityKey(destination.identityKey) : null
  const address = destination.address?.trim() || null
  const bound = key
    ? key === normalizeIdentityKey(pinned.identityKey)
    : address != null && address === addressFromIdentityKey(pinned.identityKey, chain)
  if (!bound) throw new HandleKeyChangedError(label.trim(), pinned.label)
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
  protocols?: string[]
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

  const protocols =
    Array.isArray(args.protocols) && args.protocols.length > 0
      ? args.protocols
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .map((p) => p.trim().toLowerCase())
      : undefined

  const friend: Friend = {
    id: `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`,
    label,
    identityKey,
    createdAt: Date.now(),
    ...(messagebox !== undefined ? { messagebox } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...(protocols && protocols.length > 0 ? { protocols } : {}),
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
  /** Key the user was shown before choosing Add; a different answer now refuses. */
  expectedIdentityKey?: string | null
}): Promise<Friend> {
  const value = args.recipient.trim()
  if (!value) throw new Error('Handle or identity key is required')

  let identityKey: string
  let suggestedLabel = ''
  let messagebox: string | null | undefined
  let protocols: string[] | undefined
  let fixedHandle: string | undefined

  const peer = tryParsePeerPayUri(value)
  if (peer) {
    identityKey = normalizeIdentityKey(peer.identityKey)
  } else if (parseHandleInput(value)) {
    const resolved = await resolvePinnedHandle(value)
    identityKey = normalizeIdentityKey(resolved.identityKey)
    fixedHandle = formatHandCashHandle(resolved.handle, resolved.domain)
    if (args.expectedIdentityKey && normalizeIdentityKey(args.expectedIdentityKey) !== identityKey) {
      throw new Error(
        `${fixedHandle} changed its identity key while you were adding it. Nothing was saved — check the key shown and add again.`,
      )
    }
    suggestedLabel = fixedHandle
    messagebox = resolved.messagebox
    protocols = resolved.protocols
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
    protocols,
    ...(fixedHandle ? { handle: fixedHandle } : {}),
  })
}

export function getFriendById(id: string): Friend | null {
  return readRaw().find((f) => f.id === id) ?? null
}

export function getFriendByIdentityKey(identityKey: string): Friend | null {
  const key = normalizeIdentityKey(identityKey)
  if (!key) return null
  return readRaw().find((f) => f.identityKey.toLowerCase() === key) ?? null
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
  // The key is who the handle was pinned to; a new key is a new friend, added after removing this one.
  if (friendHasFixedHandle(current) && identityKey !== normalizeIdentityKey(current.identityKey)) {
    throw new Error('A handle friend keeps the identity key it was added with — remove it and add the handle again')
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
