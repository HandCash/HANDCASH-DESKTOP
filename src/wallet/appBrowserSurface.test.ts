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
   * Mobile exposes `openAppBrowser` for DappBrowserActivity. That is native,
   * not proof that the shell can host an Electron `<webview>` tab.
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

  it('labels both real wallet-owned surfaces as in-app', () => {
    expect(appBrowserSurfaceLabel({ surface: 'embedded' }).label).toBe('Open in-app')
    expect(appBrowserSurfaceLabel({ surface: 'native' }).label).toBe('Open in-app')
    expect(appBrowserSurfaceLabel({ surface: 'external' }).label).not.toMatch(/in-app/i)
  })
})
