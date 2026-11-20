import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function loadNativeDesktopFacade(platform: 'linux' | 'win32' = 'linux') {
  const scriptPath = path.resolve(process.cwd(), 'native-desktop/handcash-page.js')
  const source = fs.readFileSync(scriptPath, 'utf8')
  const posted: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  const docListeners = new Map<string, Array<(e: unknown) => void>>()

  const win: Record<string, unknown> = {
    __HANDCASH_NATIVE_PLATFORM__: platform,
    __HANDCASH_DURABLE_URL__: 'http://127.0.0.1:44444',
    __HANDCASH_DURABLE_TOKEN__: 'secret-token',
    ipc: {
      postMessage(raw: string) {
        posted.push(JSON.parse(raw))
      },
    },
    getComputedStyle() {
      return { getPropertyValue: () => '' }
    },
  }
  const doc = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = docListeners.get(type) ?? []
      list.push(fn)
      docListeners.set(type, list)
    },
  }

  const sandbox = {
    window: win,
    document: doc,
    location: { origin: 'http://localhost:5173' },
    console,
    Map,
    Set,
    Promise,
    Error,
    Uint8Array,
    ArrayBuffer,
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
  }
  vm.runInNewContext(source, sandbox)
  const handcash = win.handcash as Record<string, unknown>
  const reply = win.__handcashNativeReply as (msg: unknown) => void
  const push = win.__handcashNativePush as (msg: unknown) => void
  return { win, handcash, posted, reply, push, docListeners }
}

describe('native-desktop handcash-page.js facade', () => {
  it('exposes full host parity API and scrubs durable token from window', () => {
    const { win, handcash } = loadNativeDesktopFacade('linux')
    expect(win.__HANDCASH_DURABLE_TOKEN__).toBeUndefined()
    expect(handcash.platform).toBe('linux')
    expect(handcash.embeddedAppBrowser).toBe(false)
    expect(typeof (handcash.appBrowserGuest as Record<string, unknown>).create).toBe('function')
    expect(typeof handcash.saveBackupFile).toBe('function')
    expect(typeof handcash.saveImageFile).toBe('function')
    expect(typeof handcash.clipboardWriteImage).toBe('function')
    expect(typeof handcash.copyScreenshot).toBe('function')
    expect(typeof handcash.onScreenshotCopied).toBe('function')
    expect(typeof handcash.getLogInfo).toBe('function')
    expect(typeof handcash.readLogs).toBe('function')
    expect(typeof handcash.openLogs).toBe('function')
    expect(typeof handcash.uploadLogs).toBe('function')
    expect(typeof handcash.archiveBrc39Snapshot).toBe('function')
    expect(typeof handcash.listBrc39Archive).toBe('function')
    expect(typeof handcash.readBrc39Archive).toBe('function')
    expect(typeof handcash.brc39ArchiveRoot).toBe('function')
    expect(typeof handcash.appendCallRecording).toBe('function')
    expect(typeof handcash.finishCallRecording).toBe('function')
    expect(typeof handcash.readCallRecording).toBe('function')
    expect(typeof handcash.deleteCallRecording).toBe('function')
    expect(typeof handcash.getOmarchyTheme).toBe('function')
    expect(typeof handcash.onOmarchyTheme).toBe('function')
    expect(typeof handcash.startWindowDrag).toBe('function')

    // Keep checkForUpdates unset so desktopReleaseUpdate.ts activates thinShellReleaseUpdater().
    expect(handcash.checkForUpdates).toBeUndefined()
    // Keep screen share unset so screenShareAvailable() truthfully reports false.
    expect(handcash.listScreenSources).toBeUndefined()
    expect(handcash.chooseScreenSource).toBeUndefined()
  })

  it('encodes Uint8Array payloads for saveBackupFile and call recordings', async () => {
    const { handcash, posted, reply } = loadNativeDesktopFacade('win32')

    const savePromise = (
      handcash.saveBackupFile as (p: { filename: string; bytes: Uint8Array }) => Promise<unknown>
    )({
      filename: 'wallet.brc39',
      bytes: new Uint8Array([1, 2, 3, 4]),
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]!.method).toBe('saveBackupFile')
    expect(posted[0]!.params).toEqual({
      filename: 'wallet.brc39',
      bytesBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
    })
    reply({ id: posted[0]!.id, ok: true, value: { ok: true, saved: true, path: 'C:\\wallet.brc39', bytes: 4 } })
    await expect(savePromise).resolves.toEqual({ ok: true, saved: true, path: 'C:\\wallet.brc39', bytes: 4 })

    const readPromise = (
      handcash.readCallRecording as (k: string, id: string) => Promise<{ meta: Uint8Array | null; parts: Uint8Array[] }>
    )('02' + 'ab'.repeat(32), '0123456789abcdef0123456789abcdef')
    expect(posted).toHaveLength(2)
    expect(posted[1]!.method).toBe('readCallRecording')
    reply({
      id: posted[1]!.id,
      ok: true,
      value: {
        meta: Buffer.from([9, 8]).toString('base64'),
        parts: [Buffer.from([10, 20]).toString('base64')],
      },
    })
    const rec = await readPromise
    expect(Array.from(rec.meta!)).toEqual([9, 8])
    expect(rec.parts.map((p) => Array.from(p))).toEqual([[10, 20]])
  })

  it('delivers omarchy:theme, screenshot:copied, and app-browser-guest push events', () => {
    const { handcash, push } = loadNativeDesktopFacade('linux')
    const events: unknown[] = []
    const offTheme = (handcash.onOmarchyTheme as (fn: (v: unknown) => void) => () => void)((v) => events.push(['theme', v]))
    const offShot = (handcash.onScreenshotCopied as (fn: (v: unknown) => void) => () => void)((v) => events.push(['shot', v]))
    const guest = handcash.appBrowserGuest as { onEvent: (fn: (v: unknown) => void) => () => void }
    const offGuest = guest.onEvent((v) => events.push(['guest', v]))

    push({ channel: 'omarchy:theme', payload: { ok: true, detected: false } })
    push({ channel: 'screenshot:copied', payload: { at: 123, version: '1.3.718' } })
    push({ channel: 'app-browser-guest', payload: { id: 'g1', type: 'loading', url: 'https://example.com' } })

    expect(events).toEqual([
      ['theme', { ok: true, detected: false }],
      ['shot', { at: 123, version: '1.3.718' }],
      ['guest', { id: 'g1', type: 'loading', url: 'https://example.com' }],
    ])

    offTheme()
    offShot()
    offGuest()
  })
})
