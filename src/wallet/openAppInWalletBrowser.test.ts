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

  it('opens safe http(s) apps in the system browser by default', async () => {
    await expect(
      openAppInWalletBrowser({
        origin: 'https://pixelwar.click',
        url: 'https://pixelwar.click/',
      }),
    ).resolves.toBe('external')
    expect(openExternal).toHaveBeenCalledWith('https://pixelwar.click/')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
  })

  it('opens the embedded browser only when preferInApp is set', async () => {
    await expect(
      openAppInWalletBrowser({
        origin: 'https://pixelwar.click',
        url: 'https://pixelwar.click/',
        preferInApp: true,
      }),
    ).resolves.toBe('embedded')
    expect(openEmbeddedAppBrowser).toHaveBeenCalledWith(
      'https://pixelwar.click',
      'https://pixelwar.click/',
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  /**
   * Mobile exposes `openAppBrowser` but has no `<webview>`. Honouring
   * preferInApp there mounted a guest that never loaded and never errored.
   */
  it('ignores preferInApp on a shell that cannot host a tab', async () => {
    vi.stubGlobal('window', {
      handcash: { openExternal, openAppBrowser: vi.fn() },
    })
    await expect(
      openAppInWalletBrowser({
        origin: 'https://pixelwar.click',
        url: 'https://pixelwar.click/',
        preferInApp: true,
      }),
    ).resolves.toBe('external')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://pixelwar.click/')
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
