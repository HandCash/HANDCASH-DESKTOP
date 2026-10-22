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

const resolveAnswer: { identityKey: string; released?: { forwarding: unknown } } = { identityKey: '' }

vi.mock('./handleResolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./handleResolve')>()
  return {
    ...actual,
    resolveHandle: vi.fn(async (raw: string) => {
      const parsed = actual.parseHandleInput(raw)!
      if (resolveAnswer.released) {
        throw new actual.HandleRevokedError(raw, resolveAnswer.released.forwarding as never)
      }
      return {
        handle: parsed.handle,
        domain: parsed.domain ?? 'brc-cloud.bcryderman.workers.dev',
        identityKey: resolveAnswer.identityKey,
        certificate: null,
        display: `@${parsed.handle}@${parsed.domain ?? 'brc-cloud.bcryderman.workers.dev'}`,
        messagebox: null,
        protocols: [],
      }
    }),
  }
})

import {
  addFriend,
  addFriendFromRecipient,
  addressFromIdentityKey,
  friendHasFixedHandle,
  HandleKeyChangedError,
  HandleMovedError,
  labelLooksLikeFixedHandle,
  listFriends,
  mergeFriends,
  refuseBoundHandleConflict,
  refuseHandleKeyChange,
  resolvePaymentRecipient,
  resolvePinnedHandle,
  updateFriend,
} from './friends'
import { HandleRevokedError } from './handleResolve'
import { signForwardingRecord } from './handleForwarding'

describe('handle key pinning', () => {
  beforeEach(() => store.clear())

  it('refuses a resolve that moved a saved handle to another key', () => {
    const saved = freshIdentityKey()
    const moved = freshIdentityKey()
    addFriend({ label: '$alice', identityKey: saved, handle: '$alice' })
    const resolved = {
      handle: 'alice',
      domain: 'brc-cloud.bcryderman.workers.dev',
      identityKey: moved,
      certificate: null,
      display: '@alice@brc-cloud.bcryderman.workers.dev',
      messagebox: null,
      protocols: [],
    }
    expect(() => refuseHandleKeyChange(resolved)).toThrow(/different identity key.*\$alice/)
    expect(() => refuseHandleKeyChange({ ...resolved, identityKey: saved.toUpperCase() })).not.toThrow()
    expect(() => refuseHandleKeyChange({ ...resolved, handle: 'bob' })).not.toThrow()
  })

  it('pins a legacy friend that stored the handle only as its label', () => {
    const saved = freshIdentityKey()
    addFriend({ label: '@alice@brc-cloud.bcryderman.workers.dev', identityKey: saved })
    const resolved = {
      handle: 'alice',
      domain: 'brc-cloud.bcryderman.workers.dev',
      identityKey: freshIdentityKey(),
      certificate: null,
      display: '@alice@brc-cloud.bcryderman.workers.dev',
      messagebox: null,
      protocols: [],
    }
    expect(() => refuseHandleKeyChange(resolved)).toThrow(HandleKeyChangedError)
  })

  it('refuses a typed handle that now resolves elsewhere, before any key is derived', async () => {
    const saved = freshIdentityKey()
    addFriend({ label: '$alice', identityKey: saved, handle: '$alice' })
    resolveAnswer.identityKey = freshIdentityKey()
    await expect(resolvePaymentRecipient('$alice', 'main')).rejects.toThrow(HandleKeyChangedError)
    resolveAnswer.identityKey = saved
    await expect(resolvePaymentRecipient('$alice', 'main')).resolves.toEqual({ kind: 'identity', identityKey: saved })
  })

  it('reports a pinned friend\'s signed move without following it', async () => {
    const root = PrivateKey.fromRandom()
    addFriend({ label: '$alice', identityKey: root.toPublicKey().toString(), handle: '$alice' })
    const forwarding = signForwardingRecord(root.toHex(), {
      from: '@alice@brc-cloud.bcryderman.workers.dev',
      toIdentityKey: freshIdentityKey(),
      toHandle: '@alice@other.example',
    })
    try {
      resolveAnswer.released = { forwarding }
      const err = await resolvePinnedHandle('$alice').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HandleMovedError)
      expect((err as HandleMovedError).forwarding.toHandle).toBe('@alice@other.example')
      expect(String(err)).toMatch(/Nothing was sent/)

      // Signed by anyone but the pinned key, the record is ignored.
      resolveAnswer.released = {
        forwarding: signForwardingRecord(PrivateKey.fromRandom().toHex(), {
          from: forwarding.from,
          toIdentityKey: forwarding.toIdentityKey,
          toHandle: forwarding.toHandle,
        }),
      }
      const unsigned = await resolvePinnedHandle('$alice').catch((e: unknown) => e)
      expect(unsigned).not.toBeInstanceOf(HandleMovedError)
      expect(unsigned).toBeInstanceOf(HandleRevokedError)
    } finally {
      resolveAnswer.released = undefined
    }
  })

  it('checks the confirmed destination against the pin right before signing', () => {
    const saved = freshIdentityKey()
    const other = freshIdentityKey()
    addFriend({ label: '$alice', identityKey: saved, handle: '$alice' })
    expect(() => refuseBoundHandleConflict('@alice@brc-cloud.bcryderman.workers.dev', { identityKey: saved }, 'main')).not.toThrow()
    expect(() => refuseBoundHandleConflict('@alice@brc-cloud.bcryderman.workers.dev', { identityKey: other }, 'main')).toThrow(
      HandleKeyChangedError,
    )
    expect(() =>
      refuseBoundHandleConflict('$alice', { address: addressFromIdentityKey(other, 'main') }, 'main'),
    ).toThrow(HandleKeyChangedError)
    expect(() =>
      refuseBoundHandleConflict('$alice', { address: addressFromIdentityKey(saved, 'main') }, 'main'),
    ).not.toThrow()
    // A custom label is not a handle, even when it reads like a bare one.
    expect(() => refuseBoundHandleConflict('alice', { identityKey: other }, 'main')).not.toThrow()
    expect(() => refuseBoundHandleConflict('$bob', { identityKey: other }, 'main')).not.toThrow()
  })

  it('refuses to save a handle whose key changed after the preview', async () => {
    const shown = freshIdentityKey()
    resolveAnswer.identityKey = freshIdentityKey()
    await expect(addFriendFromRecipient({ recipient: '$carol', expectedIdentityKey: shown })).rejects.toThrow(
      /changed its identity key/,
    )
    expect(listFriends()).toHaveLength(0)
    resolveAnswer.identityKey = shown
    await expect(addFriendFromRecipient({ recipient: '$carol', expectedIdentityKey: shown })).resolves.toMatchObject({
      identityKey: shown,
      handle: '$carol',
    })
  })

  it('never repoints a handle friend to another key', () => {
    const friend = addFriend({ label: '$alice', identityKey: freshIdentityKey(), handle: '$alice' })
    expect(() => updateFriend(friend.id, { identityKey: freshIdentityKey() })).toThrow(/keeps the identity key/)
    const custom = addFriend({ label: 'Dave', identityKey: freshIdentityKey() })
    const next = freshIdentityKey()
    expect(updateFriend(custom.id, { identityKey: next }).identityKey).toBe(next)
  })

  it('skips a synced friend that names a pinned handle with another key', () => {
    const saved = freshIdentityKey()
    addFriend({ label: '$alice', identityKey: saved, handle: '$alice' })
    const imposter = freshIdentityKey()
    const bob = freshIdentityKey()
    expect(
      mergeFriends([
        { id: 'x', label: '$alice', identityKey: imposter, createdAt: 1, handle: '$alice' },
        { id: 'y', label: '$bob', identityKey: bob, createdAt: 1, handle: '$bob' },
      ]),
    ).toBe(1)
    expect(listFriends().map((f) => f.identityKey).sort()).toEqual([saved, bob].sort())
  })
})

function freshIdentityKey(): string {
  return PrivateKey.fromRandom().toPublicKey().toString()
}

describe('labelLooksLikeFixedHandle', () => {
  it('accepts $handle and @handle@domain', () => {
    expect(labelLooksLikeFixedHandle('$alice')).toBe(true)
    expect(labelLooksLikeFixedHandle('@alice@brc-cloud.bcryderman.workers.dev')).toBe(true)
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
