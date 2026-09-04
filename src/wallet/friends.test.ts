import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./appActivity', () => ({
  recordWalletEvent: vi.fn(),
  WALLET_ACTIVITY_ORIGIN: 'handcash.wallet',
}))

import {
  addFriend,
  friendHasFixedHandle,
  labelLooksLikeFixedHandle,
  updateFriend,
} from './friends'

function freshIdentityKey(): string {
  return PrivateKey.fromRandom().toPublicKey().toString()
}

describe('labelLooksLikeFixedHandle', () => {
  it('accepts $handle and @handle@domain', () => {
    expect(labelLooksLikeFixedHandle('$alice')).toBe(true)
    expect(labelLooksLikeFixedHandle('@alice@handcash.io')).toBe(true)
  })

  it('rejects bare custom names and identity-key snippets', () => {
    expect(labelLooksLikeFixedHandle('Alice')).toBe(false)
    expect(labelLooksLikeFixedHandle('alice')).toBe(false)
    expect(labelLooksLikeFixedHandle('02ab…cdef')).toBe(false)
  })
})

describe('friendHasFixedHandle', () => {
  it('locks when handle field is set', () => {
    expect(
      friendHasFixedHandle({
        label: 'Nickname',
        handle: '$alice',
      }),
    ).toBe(true)
  })

  it('locks legacy friends whose label is a handle display', () => {
    expect(friendHasFixedHandle({ label: '$bob' })).toBe(true)
  })

  it('allows custom labels without a handle field', () => {
    expect(friendHasFixedHandle({ label: 'Lab phone' })).toBe(false)
  })
})

describe('updateFriend label rules', () => {
  beforeEach(() => {
    store.clear()
  })

  it('allows renaming a non-handle friend', () => {
    const friend = addFriend({
      label: 'Lab phone',
      identityKey: freshIdentityKey(),
    })
    const updated = updateFriend(friend.id, { label: 'Android lab' })
    expect(updated.label).toBe('Android lab')
  })

  it('refuses renaming a handle-identified friend', () => {
    const friend = addFriend({
      label: '$alice',
      identityKey: freshIdentityKey(),
      handle: '$alice',
    })
    expect(() => updateFriend(friend.id, { label: 'Alice' })).toThrow(
      /Handle is fixed/,
    )
    expect(updateFriend(friend.id, { label: '$alice' }).label).toBe('$alice')
  })

  it('refuses renaming a legacy handle-shaped label', () => {
    const friend = addFriend({
      label: '$carol',
      identityKey: freshIdentityKey(),
    })
    expect(() => updateFriend(friend.id, { label: 'Carol' })).toThrow(
      /Handle is fixed/,
    )
  })
})
