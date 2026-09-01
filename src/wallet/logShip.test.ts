import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
}))

vi.mock('../version', () => ({ APP_VERSION: '9.9.9' }))

const UPLOAD_KEY = 'handcash.logs.uploadUrl'
const CURRENT_KEY = 'handcash.applog.current.v1'

function stubBrowserGlobals(): void {
  vi.stubGlobal('window', { addEventListener: () => {}, handcash: undefined })
  vi.stubGlobal('document', {
    addEventListener: () => {},
    visibilityState: 'visible',
  })
  vi.stubGlobal('navigator', { userAgent: 'android test' })
  vi.stubGlobal('performance', {})
}

async function withRecoveredCrash() {
  store.set(
    CURRENT_KEY,
    JSON.stringify([{ at: 1, level: 'error', message: 'out of memory' }]),
  )
  stubBrowserGlobals()
  const log = await import('./appLog')
  log.installAppLogCapture()
  return import('./logShip')
}

describe('logShip', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('auto-provisions a BRC-CLOUD bucket when none is configured', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        a.fill(0xab)
        return a
      },
    })
    const ship = await withRecoveredCrash()

    const result = await ship.shipPreviousSessionLogs()

    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(url).toMatch(/\/v1\/logs\/hc-[0-9a-f]+$/)
    expect(store.get(UPLOAD_KEY)).toBe(url)
  })

  it('uploads a recovered crash log automatically', async () => {
    store.set(UPLOAD_KEY, 'https://example.test/v1/logs/hc-abcdefgh')
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const ship = await withRecoveredCrash()

    const result = await ship.shipPreviousSessionLogs()

    expect(result.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.test/v1/logs/hc-abcdefgh')
    expect(String(init.body)).toContain('out of memory')
    expect((init.headers as Record<string, string>)['X-HandCash-Version']).toBe('9.9.9')
  })

  it('uploads only once per launch', async () => {
    store.set(UPLOAD_KEY, 'https://example.test/v1/logs/hc-abcdefgh')
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const ship = await withRecoveredCrash()

    await ship.shipPreviousSessionLogs()
    await ship.shipPreviousSessionLogs()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected upload instead of throwing', async () => {
    store.set(UPLOAD_KEY, 'https://example.test/v1/logs/hc-abcdefgh')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('too large', { status: 413 })),
    )
    const ship = await withRecoveredCrash()

    const result = await ship.shipPreviousSessionLogs()

    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain('413')
  })

  it('rejects a non-http upload URL', async () => {
    stubBrowserGlobals()
    const ship = await import('./logShip')

    const result = await ship.shipAppLogs('ftp://example.test/logs')

    expect(result).toMatchObject({ ok: false })
  })

  it('strips /latest from a misconfigured upload URL before POST', async () => {
    store.set(
      UPLOAD_KEY,
      'https://example.test/v1/logs/hc-abcdefgh/latest',
    )
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const ship = await withRecoveredCrash()

    await ship.shipPreviousSessionLogs()

    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://example.test/v1/logs/hc-abcdefgh')
    expect(store.get(UPLOAD_KEY)).toBe('https://example.test/v1/logs/hc-abcdefgh')
  })

  it('auto-ships on send-failure without waiting for the interval', async () => {
    store.set(UPLOAD_KEY, 'https://example.test/v1/logs/hc-live')
    store.set(
      CURRENT_KEY,
      JSON.stringify([{ at: 1, level: 'error', message: 'send blew up' }]),
    )
    stubBrowserGlobals()
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await import('./appLog').then((m) => m.installAppLogCapture())
    const ship = await import('./logShip')

    const first = await ship.shipAppLogsAuto('send-failure')
    expect(first.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-HandCash-Log']).toBe(
      'send-failure',
    )
  })

  it('includes renderer wallet lines even when Electron main logs exist', async () => {
    store.set(UPLOAD_KEY, 'https://example.test/v1/logs/hc-desktop')
    store.set(
      CURRENT_KEY,
      JSON.stringify([{ at: 2, level: 'info', message: '[collectables] listOutputs done' }]),
    )
    stubBrowserGlobals()
    vi.stubGlobal('window', {
      addEventListener: () => {},
      handcash: {
        readLogs: async () => ({
          ok: true,
          text: '[main] BRC-100 bridge online',
        }),
      },
    })
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await import('./appLog').then((m) => m.installAppLogCapture())
    const ship = await import('./logShip')

    const result = await ship.shipAppLogs()
    expect(result.ok).toBe(true)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = String(init.body)
    expect(body).toContain('[collectables] listOutputs done')
    expect(body).toContain('electron main')
    expect(body).toContain('BRC-100 bridge online')
  })
})
