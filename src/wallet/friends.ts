import { PublicKey } from '@bsv/sdk'
import type { Chain } from './vault'
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.brc100.friends'

export type Friend = {
  id: string
  label: string
  identityKey: string
  createdAt: number
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
    )
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

export function normalizeIdentityKey(identityKey: string): string {
  return identityKey.trim()
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

export function addFriend(args: { label: string; identityKey: string }): Friend {
  const label = args.label.trim()
  const identityKey = normalizeIdentityKey(args.identityKey)
  if (!label) throw new Error('Label is required')
  const invalid = validateIdentityKey(identityKey)
  if (invalid) throw new Error(invalid)

  const friends = readRaw()
  if (friends.some((f) => f.identityKey === identityKey)) {
    throw new Error('Friend already added')
  }

  const friend: Friend = {
    id: `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`,
    label,
    identityKey,
    createdAt: Date.now(),
  }
  writeAll([...friends, friend])
  return friend
}

export function getFriendById(id: string): Friend | null {
  return readRaw().find((f) => f.id === id) ?? null
}

export function updateFriend(
  id: string,
  patch: { label?: string; identityKey?: string },
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
  const invalid = validateIdentityKey(identityKey)
  if (invalid) throw new Error(invalid)

  if (
    friends.some((f) => f.id !== id && f.identityKey === identityKey)
  ) {
    throw new Error('Friend already added')
  }

  const updated: Friend = { ...current, label, identityKey }
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
