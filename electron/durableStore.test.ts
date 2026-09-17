import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The renderer reads these prefs over `ipcRenderer.sendSync`, which parks the
 * renderer thread — no paint, no timers, and no stall warning, because the
 * watchdog cannot run either. A real wallet's store reaches several megabytes
 * (chat, activity, item art), so reading or rewriting the whole file per key
 * froze the window outright. These tests hold that cost down.
 */

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false },
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

async function loadStore() {
  vi.resetModules()
  return import('./durableStore.js')
}

function storeFile(): string {
  return path.join(userData, 'durable-prefs.json')
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'handcash-durable-'))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('durable store', () => {
  it('reads the file once no matter how many keys are fetched', async () => {
    fs.writeFileSync(
      storeFile(),
      JSON.stringify({ 'handcash.a': '1', 'handcash.b': '2' }),
      'utf8',
    )
    const { durableGet } = await loadStore()
    const spy = vi.spyOn(fs, 'readFileSync')

    expect(durableGet('handcash.a')).toBe('1')
    for (let i = 0; i < 50; i++) durableGet('handcash.b')

    expect(spy.mock.calls.filter(([f]) => f === storeFile())).toHaveLength(1)
    spy.mockRestore()
  })

  it('serves a written value without re-reading disk', async () => {
    const { durableGet, durableSet } = await loadStore()
    expect(durableSet('handcash.pref', 'on')).toBe(true)
    const spy = vi.spyOn(fs, 'readFileSync')

    expect(durableGet('handcash.pref')).toBe('on')

    expect(spy.mock.calls.filter(([f]) => f === storeFile())).toHaveLength(0)
    spy.mockRestore()
  })

  it('coalesces a burst of preference writes into one file replace', async () => {
    const { durableSet, flushDurableStore } = await loadStore()
    const spy = vi.spyOn(fs, 'writeFileSync')

    for (let i = 0; i < 20; i++) durableSet(`handcash.k${i}`, String(i))
    expect(spy).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(spy).toHaveBeenCalledTimes(1)

    flushDurableStore()
    spy.mockRestore()

    const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>
    expect(onDisk['handcash.k0']).toBe('0')
    expect(onDisk['handcash.k19']).toBe('19')
  })

  it('writes the vault through immediately rather than on the debounce', async () => {
    const { durableSet } = await loadStore()
    expect(durableSet('handcash.brc100.vault.v1', JSON.stringify({ identityKey: 'abc' }))).toBe(
      true,
    )

    // No timers run: a crash inside the debounce window must not lose the vault.
    const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>
    expect(onDisk['handcash.brc100.vault.v1']).toContain('abc')
  })

  it('flushes pending writes on demand so quit cannot drop them', async () => {
    const { durableSet, flushDurableStore } = await loadStore()
    durableSet('handcash.late', 'value')

    expect(fs.existsSync(storeFile())).toBe(false)
    expect(flushDurableStore()).toBe(true)

    const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>
    expect(onDisk['handcash.late']).toBe('value')
  })

  it('keeps a removed key gone for later reads', async () => {
    fs.writeFileSync(storeFile(), JSON.stringify({ 'handcash.gone': 'x' }), 'utf8')
    const { durableGet, durableRemove } = await loadStore()

    expect(durableRemove('handcash.gone')).toBe(true)
    expect(durableGet('handcash.gone')).toBeNull()

    vi.runAllTimers()
    const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>
    expect('handcash.gone' in onDisk).toBe(false)
  })

  it('wipes wallet keys to disk at once, keeping device prefs', async () => {
    fs.writeFileSync(
      storeFile(),
      JSON.stringify({
        'handcash.brc100.vault.v1': 'secret',
        'handcash.appearance': 'dark',
      }),
      'utf8',
    )
    const { durableWipeWallet } = await loadStore()

    expect(durableWipeWallet().removed).toBe(1)

    const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>
    expect('handcash.brc100.vault.v1' in onDisk).toBe(false)
    expect(onDisk['handcash.appearance']).toBe('dark')
  })
})
