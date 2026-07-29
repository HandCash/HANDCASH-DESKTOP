import { PublicKey } from '@bsv/sdk'
import type { Chain } from './vault'

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
    const raw = localStorage.getItem(STORAGE_KEY)
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(friends))
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
