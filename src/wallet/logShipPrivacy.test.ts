import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => { store.set(key, value); return true },
  durableRemoveItem: (key: string) => { store.delete(key) },
}))
vi.mock('../version', () => ({ APP_VERSION: 'synthetic-test' }))

// Only synthetic fixtures and intercepted fetches; never contact a log service.
describe('log upload privacy evidence', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let visibilityChanged: (() => void) | undefined
  const doc = {
    visibilityState: 'visible',
    addEventListener: (event: string, callback: () => void) => {
      if (event === 'visibilitychange') visibilityChanged = callback
    },
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    store.clear()
    store.set('handcash.logs.uploadUrl', 'https://example.test/v1/logs/synthetic-only')
    visibilityChanged = undefined
    doc.visibilityState = 'visible'
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { addEventListener: () => {}, handcash: { platform: 'synthetic' } })
    vi.stubGlobal('navigator', { userAgent: 'synthetic user agent' })
    vi.stubGlobal('performance', {})
    fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const body = () => String((fetchSpy.mock.calls.at(-1) as [string, RequestInit])[1].body)
  const reason = () => ((fetchSpy.mock.calls.at(-1) as [string, RequestInit])[1].headers as Record<string, string>)['X-HandCash-Log']

  it('has no automatic sender: no boot, interval, hidden, failure or crash-recovery upload', async () => {
    store.set('handcash.applog.current.v1', JSON.stringify([
      { at: 1, level: 'error', message: 'previous session crash' },
    ]))
    const log = await import('./appLog')
    log.installAppLogCapture()
    const ship = await import('./logShip')
    expect(Object.keys(ship).sort()).toEqual(['shellOnlyLines', 'shipAppLogs'])
    doc.visibilityState = 'hidden'
    visibilityChanged?.()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('manual send is the only upload path and still posts', async () => {
    const ship = await import('./logShip')
    const result = await ship.shipAppLogs()
    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(reason()).toBe('manual')
    expect(body()).toContain('# userAgent synthetic user agent')
  })

  it('redacts recognized new renderer fields, balance metadata, and transaction IDs', async () => {
    const log = await import('./appLog')
    log.appendAppLog('info', JSON.stringify({ mnemonic: 'SYNTHETIC_LABELLED_SEED', privateKey: 'SYNTHETIC_LABELLED_KEY' }))
    log.appendAppLog('info', 'SYNTHETIC_UNLABELLED_MATERIAL spendable=123 txid=SYNTHETIC_TX')
    const ship = await import('./logShip')
    await ship.shipAppLogs()
    expect(body()).toContain('[REDACTED]')
    expect(body()).not.toContain('SYNTHETIC_LABELLED_SEED')
    expect(body()).not.toContain('SYNTHETIC_LABELLED_KEY')
    expect(body()).toContain('SYNTHETIC_UNLABELLED_MATERIAL')
    // Balance metadata and transaction IDs should now be redacted
    expect(body()).not.toContain('spendable=123')
    expect(body()).not.toContain('txid=SYNTHETIC_TX')
    expect(body()).toContain('spendable=[amt]')
    expect(body()).toContain('txid=[REDACTED]')
  })

  it('uploads no peers, txids, addresses or amounts from the ring, the previous session or the shell', async () => {
    const txid = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
    store.set('handcash.applog.current.v1', JSON.stringify([
      { at: 1, level: 'info', message: `[send] paid $carol 7777 sats ${txid}` },
    ]))
    vi.stubGlobal('window', {
      addEventListener: () => {},
      handcash: { readLogs: async () => ({ ok: true, text: `[HTTP] peer=dave ${txid} 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa` }) },
    })
    const log = await import('./appLog')
    log.installAppLogCapture()
    log.appendAppLog('info', `[chat] to $erin@handcash.io 0.5 BSV ${txid.slice(0, 12)}…`)
    const ship = await import('./logShip')
    await ship.shipAppLogs()
    for (const leak of ['carol', 'dave', 'erin', '7777', '0.5 BSV', txid.slice(0, 12), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa']) {
      expect(body()).not.toContain(leak)
    }
    expect(body()).toContain('# privacy identifiers are per-session pseudonyms')
  })

  it('re-redacts persisted previous-session entries at manual upload', async () => {
    store.set('handcash.applog.current.v1', JSON.stringify([
      { at: 1, level: 'error', message: 'privateKey=SYNTHETIC_PERSISTED_MATERIAL' },
    ]))
    const log = await import('./appLog')
    log.installAppLogCapture()
    const ship = await import('./logShip')
    await ship.shipAppLogs()
    expect(reason()).toBe('manual')
    expect(body()).not.toContain('SYNTHETIC_PERSISTED_MATERIAL')
    expect(body()).toContain('[REDACTED]')
  })

  it('redacts shell tail returned through IPC before upload', async () => {
    vi.stubGlobal('window', {
      handcash: { readLogs: async () => ({ ok: true, text: 'mnemonic=SYNTHETIC_SHELL_MATERIAL' }) },
    })
    const ship = await import('./logShip')
    await ship.shipAppLogs()
    expect(body()).not.toContain('SYNTHETIC_SHELL_MATERIAL')
    expect(body()).toContain('[REDACTED]')
  })

  it.each(['http://example.test/logs', 'https://user:password@example.test/logs'])(
    'rejects insecure or credential-bearing target %s without fetching', async (url) => {
      const ship = await import('./logShip')
      expect(await ship.shipAppLogs(url)).toMatchObject({ ok: false })
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it('does not follow redirects or attach browser credentials to uploads', async () => {
    const ship = await import('./logShip')
    await ship.shipAppLogs()
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
    })
  })

  it('clearing the URL reprovisions a sink for manual sends only', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => { a.fill(0x12); return a } })
    const prefs = await import('./logUploadPrefs')
    prefs.setLogUploadUrl('')
    expect(fetchSpy).not.toHaveBeenCalled()
    const ship = await import('./logShip')
    await ship.shipAppLogs()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(store.has('handcash.logs.uploadUrl')).toBe(true)
  })
})
