import { describe, expect, it } from 'vitest'
import {
  appBrowserSurfaceLabel,
  chooseAppBrowserSurface,
} from './appBrowserSurface'

describe('chooseAppBrowserSurface', () => {
  it('hosts an embedded tab only when the shell says it can', () => {
    expect(chooseAppBrowserSurface({ embeddedAppBrowser: true })).toEqual({
      surface: 'embedded',
    })
  })

  /**
   * Both shells expose `openAppBrowser`; on mobile it hands off to the system
   * browser. Reading it as proof of a `<webview>` host is what put a dead
   * in-app tab on the phone — it mounted, never loaded, and never errored.
   */
  it('does not infer an embedded tab from openAppBrowser alone', () => {
    expect(chooseAppBrowserSurface({ openAppBrowser: () => undefined })).toEqual({
      surface: 'native',
    })
  })

  it('falls back to the system browser with no shell at all', () => {
    expect(chooseAppBrowserSurface(undefined)).toEqual({ surface: 'external' })
    expect(chooseAppBrowserSurface({})).toEqual({ surface: 'external' })
    // A non-callable value is not a browser the shell can drive.
    expect(chooseAppBrowserSurface({ openAppBrowser: true })).toEqual({
      surface: 'external',
    })
  })

  it('prefers the embedded tab when a shell offers both', () => {
    expect(
      chooseAppBrowserSurface({
        embeddedAppBrowser: true,
        openAppBrowser: () => undefined,
      }),
    ).toEqual({ surface: 'embedded' })
  })

  it('never promises an in-app tab the surface cannot deliver', () => {
    expect(appBrowserSurfaceLabel({ surface: 'embedded' }).label).toBe('Open in-app')
    for (const surface of ['native', 'external'] as const) {
      expect(appBrowserSurfaceLabel({ surface }).label).not.toMatch(/in-app/i)
    }
  })
})
