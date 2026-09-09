import { describe, expect, it, vi, beforeEach } from 'vitest'

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
  beforeEach(() => {
    vi.mocked(openEmbeddedAppBrowser).mockClear()
    vi.mocked(decideAppBrowserTarget).mockClear()
  })

  it('opens safe http(s) apps in the embedded browser', async () => {
    await expect(
      openAppInWalletBrowser({
        origin: 'https://pixelwar.click',
        url: 'https://pixelwar.click/',
      }),
    ).resolves.toBe('embedded')
    expect(openEmbeddedAppBrowser).toHaveBeenCalledWith(
      'https://pixelwar.click',
      'https://pixelwar.click/',
    )
  })

  it('refuses invalid targets', async () => {
    await expect(
      openAppInWalletBrowser({ origin: 'https://pixelwar.click', url: 'not-a-url' }),
    ).resolves.toBe('unavailable')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
  })

  it('launchConnectedApp is a no-op without a url', () => {
    launchConnectedApp('https://pixelwar.click', null)
    launchConnectedApp('https://pixelwar.click', '   ')
    expect(openEmbeddedAppBrowser).not.toHaveBeenCalled()
  })
})
