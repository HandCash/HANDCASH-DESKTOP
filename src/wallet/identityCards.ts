/**
 * Identity cards: pure projection for the credit-card deck on Identity.
 *
 * Card 1 is always the wallet identity key alone. Every further card is a
 * collected identity that meets the BRC-169 handle format: this wallet's own
 * claimed handle, then each saved friend that pins a handle.
 */
import { friendHasFixedHandle, type Friend } from './friends'
import type { HandleIptView } from './handleIpt'

export type IdentityCard = {
  id: string
  kind: 'key' | 'handle'
  /** Large line: key groups for the key card, `$handle` otherwise. */
  title: string
  /** Four-character groups, credit-card number style. */
  groups: string[]
  holder: string
  identityKey: string
  own: boolean
}

/** Identity key as four-character groups: first 16 and last 16 hex chars, 4 rows of 4 groups collapse to 2 lines. */
export function keyGroups(key: string): string[] {
  const k = key.trim().toLowerCase()
  const hex = k.length > 32 ? k.slice(0, 16) + k.slice(-16) : k
  return hex.match(/.{1,4}/g) ?? []
}

export function buildIdentityCards(
  identityKey: string,
  ownHandle: HandleIptView,
  friends: readonly Friend[],
): IdentityCard[] {
  const cards: IdentityCard[] = [
    {
      id: 'key',
      kind: 'key',
      title: 'Identity key',
      groups: keyGroups(identityKey),
      holder: 'WALLET KEY',
      identityKey,
      own: true,
    },
  ]
  if (ownHandle.state !== 'empty') {
    cards.push({
      id: 'own-handle',
      kind: 'handle',
      title: ownHandle.label,
      groups: keyGroups(ownHandle.identityKey || identityKey),
      holder: 'YOU',
      identityKey: ownHandle.identityKey || identityKey,
      own: true,
    })
  }
  const seen = new Set<string>([identityKey.toLowerCase()])
  for (const f of friends) {
    if (!friendHasFixedHandle(f)) continue
    const k = f.identityKey.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    cards.push({
      id: `friend-${f.id}`,
      kind: 'handle',
      title: (f.handle?.trim() || f.label).trim(),
      groups: keyGroups(f.identityKey),
      holder: f.label.replace(/^[$@]/, '').toUpperCase(),
      identityKey: f.identityKey,
      own: false,
    })
  }
  return cards
}
