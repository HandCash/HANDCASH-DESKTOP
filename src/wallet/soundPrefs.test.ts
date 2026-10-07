import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => void store.set(key, value),
}))

import { isWalletSfxEnabled, setWalletSfxEnabled, subscribeWalletSfx } from './soundPrefs'

beforeEach(() => store.clear())

describe('soundPrefs', () => {
  it('plays by default and mutes only on an explicit off', () => {
    expect(isWalletSfxEnabled()).toBe(true)
    const heard = vi.fn()
    const off = subscribeWalletSfx(heard)
    setWalletSfxEnabled(false)
    expect(isWalletSfxEnabled()).toBe(false)
    setWalletSfxEnabled(true)
    expect(isWalletSfxEnabled()).toBe(true)
    expect(heard.mock.calls).toEqual([[false], [true]])
    off()
  })
})
