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

  it('posts at boot, five-minute interval and hidden event with a one-minute debounce', async () => {
    const ship = await import('./logShip')
    ship.startAutoLogShip()
    await vi.advanceTimersByTimeAsync(0)
    expect(reason()).toBe('boot')
    expect(body()).toContain('# userAgent synthetic user agent')
    expect(body()).toContain('version synthetic-test · platform synthetic')
    doc.visibilityState = 'hidden'
    visibilityChanged?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(reason()).toBe('interval')
    await vi.advanceTimersByTimeAsync(60_000)
    visibilityChanged?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(reason()).toBe('hidden')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('send-failure bypasses the time debounce', async () => {
    const ship = await import('./logShip')
    await ship.shipAppLogsAuto('boot')
    await ship.shipAppLogsAuto('send-failure')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(reason()).toBe('send-failure')
  })

  it('redacts recognized new renderer fields, but not unlabelled material or balance metadata', async () => {
    const log = await import('./appLog')
    log.appendAppLog('info', JSON.stringify({ mnemonic: 'SYNTHETIC_LABELLED_SEED', privateKey: 'SYNTHETIC_LABELLED_KEY' }))
    log.appendAppLog('info', 'SYNTHETIC_UNLABELLED_MATERIAL spendable=123 txid=SYNTHETIC_TX')
    const ship = await import('./logShip')
    await ship.shipAppLogsAuto('send-failure')
    expect(body()).toContain('[REDACTED]')
    expect(body()).not.toContain('SYNTHETIC_LABELLED_SEED')
    expect(body()).not.toContain('SYNTHETIC_LABELLED_KEY')
    expect(body()).toContain('SYNTHETIC_UNLABELLED_MATERIAL')
    expect(body()).toContain('spendable=123')
    expect(body()).toContain('SYNTHETIC_TX')
  })

  it('does not re-redact persisted previous-session entries at upload', async () => {
    store.set('handcash.applog.current.v1', JSON.stringify([
      { at: 1, level: 'error', message: 'privateKey=SYNTHETIC_PERSISTED_MATERIAL' },
    ]))
    const log = await import('./appLog')
    log.installAppLogCapture()
    const ship = await import('./logShip')
    await ship.shipPreviousSessionLogs()
    expect(reason()).toBe('crash-recovery')
    expect(body()).toContain('privateKey=SYNTHETIC_PERSISTED_MATERIAL')
  })

  it('does not redact shell tail returned through IPC before upload', async () => {
    vi.stubGlobal('window', {
      handcash: { readLogs: async () => ({ ok: true, text: 'mnemonic=SYNTHETIC_SHELL_MATERIAL' }) },
    })
    const ship = await import('./logShip')
    await ship.shipAppLogsAuto('boot')
    expect(body()).toContain('mnemonic=SYNTHETIC_SHELL_MATERIAL')
  })

  it('clearing the URL reprovisions a sink rather than disabling uploads', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => { a.fill(0x12); return a } })
    const prefs = await import('./logUploadPrefs')
    prefs.setLogUploadUrl('')
    const ship = await import('./logShip')
    await ship.shipAppLogsAuto('boot')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(store.has('handcash.logs.uploadUrl')).toBe(true)
  })
})
