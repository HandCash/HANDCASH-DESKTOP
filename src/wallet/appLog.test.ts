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

const CURRENT_KEY = 'handcash.applog.current.v1'

/** installAppLogCapture is browser-only; this suite runs on the node env. */
function stubBrowserGlobals(): void {
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('document', {
    addEventListener: () => {},
    visibilityState: 'visible',
  })
  vi.stubGlobal('navigator', { userAgent: 'test-agent' })
  vi.stubGlobal('performance', {})
}

describe('appLog crash recovery', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('mirrors errors to durable storage immediately', async () => {
    const log = await import('./appLog')
    log.appendAppLog('error', 'boom')

    const stored = JSON.parse(store.get(CURRENT_KEY) ?? '[]') as { message: string }[]
    expect(stored.map((e) => e.message)).toContain('boom')
  })

  it('recovers the last run as the previous session', async () => {
    store.set(
      CURRENT_KEY,
      JSON.stringify([{ at: 1, level: 'error', message: 'died here' }]),
    )
    stubBrowserGlobals()

    const log = await import('./appLog')
    log.installAppLogCapture()

    expect(log.getPreviousSessionLogs().map((e) => e.message)).toEqual(['died here'])
    // The recovered run must not be mistaken for this run's output.
    expect(log.getAppLogs().some((e) => e.message === 'died here')).toBe(false)
  })

  it('reports the running version so a crash can be pinned to a build', async () => {
    stubBrowserGlobals()

    const log = await import('./appLog')
    log.installAppLogCapture()

    expect(log.formatAppLogs()).toContain('v9.9.9')
  })

  it('survives a corrupt stored blob', async () => {
    store.set(CURRENT_KEY, '{not json')
    stubBrowserGlobals()

    const log = await import('./appLog')
    log.installAppLogCapture()

    expect(log.getPreviousSessionLogs()).toEqual([])
  })
})
