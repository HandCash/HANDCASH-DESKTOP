import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = new Map<string, string>()
let rootKeyHex = '11'.repeat(32)

vi.mock('../durableStorage', () => ({
  durableGetItem: (k: string) => disk.get(k) ?? null,
  durableSetItem: (k: string, v: string) => void disk.set(k, v),
  durableRemoveItem: (k: string) => void disk.delete(k),
}))
vi.mock('../walletRuntime', () => ({
  getWalletRuntime: () => ({
    instance: { identityKey: 'vitest-primary-identity', accountIndex: 0, chain: 'main', rootKeyHex },
  }),
}))

import {
  addImportedSource,
  loadImportedSources,
  removeImportedSource,
  updateImportedSource,
} from './store'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('imported source store', () => {
  beforeEach(() => {
    disk.clear()
    rootKeyHex = '11'.repeat(32)
  })

  it('never writes a secret in the clear', async () => {
    await addImportedSource({ kind: 'phrase', mnemonic: PHRASE, passphrase: '' })
    const raw = [...disk.values()].join('')
    expect(raw).not.toContain('abandon')
    expect(JSON.parse(raw)).toMatchObject({ v: 1 })
  })

  it('round-trips, de-duplicates, updates and removes', async () => {
    const first = await addImportedSource({ kind: 'twetch', mnemonic: PHRASE, passphrase: '' }, 'My Twetch')
    expect(first.existing).toBe(false)
    const again = await addImportedSource({ kind: 'twetch', mnemonic: PHRASE, passphrase: '' })
    expect(again).toEqual({ source: first.source, existing: true })
    await updateImportedSource(first.source.id, { label: 'Renamed' })
    const list = await loadImportedSources()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'Renamed', kind: 'twetch', secret: { mnemonic: PHRASE } })
    await removeImportedSource(first.source.id)
    expect(await loadImportedSources()).toEqual([])
    expect(disk.size).toBe(0)
  })

  it('opens only under the wallet key that sealed it', async () => {
    await addImportedSource({ kind: 'phrase', mnemonic: PHRASE, passphrase: '' })
    rootKeyHex = '22'.repeat(32)
    await expect(loadImportedSources()).rejects.toThrow()
  })
})
