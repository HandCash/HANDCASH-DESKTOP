import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BntDeployFields } from './payload'

const store = new Map<string, string>()
const writes = vi.fn()

vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    writes(key)
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
    return true
  },
}))

const { bntArtUrl, bntDeployArt, resetBntArtForTests } = await import('./art')

const TOKEN = 'ab'.repeat(20)
const ITEM = 'cd'.repeat(20)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const token = { kind: 'token', mode: 'open', sym: 'GOLD', iss: [], icon: { mediaType: 'image/png', bytes: PNG } } as unknown as BntDeployFields
const item = { kind: 'item', mode: 'open', name: 'Picture', iss: [], ctype: 'image/png', c: PNG } as unknown as BntDeployFields
const plain = { kind: 'token', mode: 'open', sym: 'PLAIN', iss: [] } as unknown as BntDeployFields

describe('BNT art', () => {
  beforeEach(() => {
    store.clear()
    writes.mockClear()
    resetBntArtForTests()
  })

  it('encodes a token icon and an image item from the deploy', () => {
    expect(bntDeployArt(TOKEN, token)).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(bntDeployArt(ITEM, item)).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(bntDeployArt('ef'.repeat(20), plain)).toBeUndefined()
  })

  it('writes the art store once per asset, not on every read', () => {
    bntDeployArt(TOKEN, token)
    bntDeployArt(TOKEN, token)
    bntDeployArt(TOKEN.toUpperCase(), token)
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('still has the picture after a relaunch, before any deploy is read', () => {
    const url = bntDeployArt(TOKEN, token)
    resetBntArtForTests()
    expect(bntArtUrl(TOKEN.toUpperCase())).toBe(url)
  })

  it('does not rewrite art the store already holds after a relaunch', () => {
    bntDeployArt(TOKEN, token)
    resetBntArtForTests()
    writes.mockClear()
    bntDeployArt(TOKEN, token)
    expect(writes).not.toHaveBeenCalled()
  })

  it('knows nothing of an asset it never read', () => {
    expect(bntArtUrl(ITEM)).toBeUndefined()
    expect(bntArtUrl('')).toBeUndefined()
  })
})
