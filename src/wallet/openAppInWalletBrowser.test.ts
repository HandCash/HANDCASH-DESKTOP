import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./navStore', () => ({
  openEmbeddedAppBrowser: vi.fn(),
}))

vi.mock('./appBrowserUrl', () => ({
  decideAppBrowserTarget: vi.fn((url: string) =>
    url.startsWith('http')
      ? { kind: 'open' as const, url, host: 'example.test' }
      : {
          kind: 'refuse' as const,
          reason: 'unparsable' as const,
          message: 'bad',
        },
  ),
}))

import { decideAppBrowserTarget } from './appBrowserUrl'
import { openEmbeddedAppBrowser } from './navStore'
import {
  launchConnectedApp,
  openAppInWalletBrowser,
} from './openAppInWalletBrowser'

const nativeGuest = { create: vi.fn() }
const app = { origin: 'https://pixelwar.click', url: 'https://pixelwar.click/' }

describe('openAppInWalletBrowser', () => {
  const openExternal = vi.fn(async () => {})

  beforeEach(() => {
    vi.mocked(openEmbeddedAppBrowser).mockClear()
    vi.mocked(decideAppBrowserTarget).mockClear()
    openExternal.mockClear()
    // Desktop shell: hosts `<webview>`, so an embedded tab is real.
    vi.stubGlobal('window', {
      handcash: { openExternal, embeddedAppBrowser: true },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens a Desktop app in the system browser by default', async () => {
    await expect(openAppInWalletBrowser(app)).resolves.toBe('external')
    expect(openExternal).toHaveBeenCalledWith('https://pixelwar.click/')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
  })

  it('opens a Desktop tab when the user picks in-app', async () => {
    await expect(openAppInWalletBrowser({ ...app, surface: 'in-app' })).resolves.toBe('embedded')
    expect(openEmbeddedAppBrowser).toHaveBeenCalledWith(app.origin, app.url)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens a phone app in a tab by default', async () => {
    vi.stubGlobal('window', { handcash: { openExternal, appBrowserGuest: nativeGuest } })
    await expect(openAppInWalletBrowser(app)).resolves.toBe('embedded')
    expect(openEmbeddedAppBrowser).toHaveBeenCalledWith(app.origin, app.url)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens a phone app in Chrome when the user picks the browser', async () => {
    vi.stubGlobal('window', { handcash: { openExternal, appBrowserGuest: nativeGuest } })
    await expect(openAppInWalletBrowser({ ...app, surface: 'browser' })).resolves.toBe('external')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://pixelwar.click/')
  })

  it('uses the system browser where no tab exists, even when in-app is picked', async () => {
    vi.stubGlobal('window', { handcash: { openExternal } })
    await expect(openAppInWalletBrowser({ ...app, surface: 'in-app' })).resolves.toBe('external')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
  })

  it('refuses invalid targets', async () => {
    await expect(
      openAppInWalletBrowser({ origin: 'https://pixelwar.click', url: 'not-a-url' }),
    ).resolves.toBe('unavailable')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('launchConnectedApp is a no-op without a url', () => {
    launchConnectedApp('https://pixelwar.click', null)
    launchConnectedApp('https://pixelwar.click', '   ')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
