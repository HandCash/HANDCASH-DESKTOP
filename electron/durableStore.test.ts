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

  it('reports a vault write as failed when the store file does not read back with it', async () => {
    fs.writeFileSync(storeFile(), JSON.stringify({ 'handcash.brc100.vault.v1': '{"identityKey":"abc"}' }), 'utf8')
    const { durableGet, durableSet } = await loadStore()
    expect(durableGet('handcash.brc100.vault.v1')).toContain('abc')
    const stale = JSON.stringify({ 'handcash.brc100.vault.v1': '{"identityKey":"abc"}' })
    const realRead = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
      file === storeFile() ? stale : (realRead as (...a: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync)

    expect(durableSet('handcash.brc100.vault.v1', '{"identityKey":"abc","v":2}')).toBe(false)
    vi.restoreAllMocks()
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
        'handcash.brc100.derivedChangeEcho.v1:wallet:main:0:02ab': '{}',
      }),
      'utf8',
    )
    const { durableWipeWallet } = await loadStore()

    expect(durableWipeWallet().removed).toBe(1)

    const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>
    expect('handcash.brc100.vault.v1' in onDisk).toBe(false)
    expect(onDisk['handcash.appearance']).toBe('dark')
    expect(onDisk['handcash.brc100.derivedChangeEcho.v1:wallet:main:0:02ab']).toBe('{}')
  })
})

function diskFull(): never {
  throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
}

function leftoverTemps(): string[] {
  return fs.readdirSync(userData).filter((name) => name.endsWith('.tmp'))
}

function onDisk(): Record<string, string> {
  return JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, string>
}

function writeAged(file: string, contents: string, ageSeconds: number): void {
  fs.writeFileSync(file, contents, 'utf8')
  const at = Date.now() / 1000 - ageSeconds
  fs.utimesSync(file, at, at)
}

/** A committed key: it must reach disk before durableSet reports success. */
const COMMITTED = 'handcash.publicIdentities'

describe('durable store on a full disk or after a crash', () => {
  it('keeps the last saved file and leaves no temp file when the disk is full', async () => {
    fs.writeFileSync(storeFile(), JSON.stringify({ [COMMITTED]: 'old' }), 'utf8')
    const { durableSet } = await loadStore()
    const log = (await import('electron-log')).default
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(diskFull)

    expect(durableSet(COMMITTED, 'new')).toBe(false)

    expect(onDisk()[COMMITTED]).toBe('old')
    expect(leftoverTemps()).toEqual([])
    expect(vi.mocked(log.error).mock.calls.some(([message]) => String(message).includes('disk is full'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('does not serve or later save a committed write the disk refused', async () => {
    fs.writeFileSync(storeFile(), JSON.stringify({ [COMMITTED]: 'old' }), 'utf8')
    const { durableGet, durableSet, flushDurableStore } = await loadStore()
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(diskFull)

    expect(durableSet(COMMITTED, 'new')).toBe(false)
    vi.restoreAllMocks()

    expect(durableGet(COMMITTED)).toBe('old')
    expect(flushDurableStore()).toBe(true)
    expect(onDisk()[COMMITTED]).toBe('old')
  })

  it('retries a preference save the disk refused until it lands', async () => {
    const { durableSet } = await loadStore()
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(diskFull)

    durableSet('handcash.pref', 'on')
    vi.advanceTimersByTime(150)
    expect(fs.existsSync(storeFile())).toBe(false)
    vi.restoreAllMocks()

    vi.advanceTimersByTime(2_000)
    expect(onDisk()['handcash.pref']).toBe('on')
  })

  it('removes leftover temp files on start and keeps the saved store', async () => {
    writeAged(storeFile(), JSON.stringify({ 'handcash.a': 'saved' }), 10)
    writeAged(`${storeFile()}.111.tmp`, '', 5)
    writeAged(`${storeFile()}.222.tmp`, '{"handcash.a":"tor', 5)
    writeAged(`${storeFile()}.333.tmp`, JSON.stringify({ 'handcash.a': 'older' }), 60)
    const { durableGet } = await loadStore()

    expect(durableGet('handcash.a')).toBe('saved')
    expect(leftoverTemps()).toEqual([])
  })

  it('keeps a complete temp file that is the only good copy, and makes it the store', async () => {
    writeAged(`${storeFile()}.444.tmp`, JSON.stringify({ 'handcash.a': 'only copy' }), 5)
    const { durableGet } = await loadStore()

    expect(durableGet('handcash.a')).toBe('only copy')
    expect(onDisk()['handcash.a']).toBe('only copy')
    expect(leftoverTemps()).toEqual([])
  })

  it('falls back to the previous version when the store file is corrupt, keeping the corrupt bytes', async () => {
    const { durableSet, flushDurableStore } = await loadStore()
    durableSet('handcash.a', 'first')
    flushDurableStore()
    durableSet('handcash.a', 'second')
    flushDurableStore()
    fs.writeFileSync(storeFile(), '{"handcash.a":"sec', 'utf8')

    const reloaded = await loadStore()

    expect(reloaded.durableGet('handcash.a')).toBe('first')
    const aside = fs.readdirSync(userData).filter((name) => name.includes('.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(userData, aside[0]!), 'utf8')).toBe('{"handcash.a":"sec')
  })

  it('never replaces a store file it could not read', async () => {
    fs.writeFileSync(storeFile(), JSON.stringify({ [COMMITTED]: 'kept' }), 'utf8')
    const read = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (file === storeFile()) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      return (read as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync)
    const { durableSet } = await loadStore()

    expect(durableSet(COMMITTED, 'replacement')).toBe(false)
    vi.restoreAllMocks()

    expect(onDisk()[COMMITTED]).toBe('kept')
  })
})
