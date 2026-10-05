import { afterEach, describe, expect, it } from 'vitest'
import { setLabEnabled } from './labs'
import {
  appBrowserSurfaceLabel,
  chooseAppBrowserSurface,
  inAppBrowserNeedsLab,
  inAppBrowserRefused,
} from './appBrowserSurface'

const nativeGuest = { create: () => Promise.resolve() }

describe('chooseAppBrowserSurface', () => {
  afterEach(() => setLabEnabled('inAppBrowser', false))

  it('always hosts a Desktop `<webview>` tab; the lab does not apply there', () => {
    expect(chooseAppBrowserSurface({ embeddedAppBrowser: true }, false)).toEqual({
      surface: 'embedded',
      host: 'webview',
    })
    expect(inAppBrowserNeedsLab({ embeddedAppBrowser: true })).toBe(false)
    expect(inAppBrowserRefused({ embeddedAppBrowser: true })).toBe(false)
  })

  it('hosts the native guest on mobile only while Labs › In-app browser is on', () => {
    expect(chooseAppBrowserSurface({ appBrowserGuest: nativeGuest }, false)).toEqual({
      surface: 'external',
    })
    expect(chooseAppBrowserSurface({ appBrowserGuest: nativeGuest }, true)).toEqual({
      surface: 'embedded',
      host: 'native',
    })
    expect(inAppBrowserNeedsLab({ appBrowserGuest: nativeGuest })).toBe(true)
    expect(inAppBrowserRefused({ appBrowserGuest: nativeGuest })).toBe(true)
    setLabEnabled('inAppBrowser', true)
    expect(chooseAppBrowserSurface({ appBrowserGuest: nativeGuest })).toEqual({
      surface: 'embedded',
      host: 'native',
    })
    expect(inAppBrowserRefused({ appBrowserGuest: nativeGuest })).toBe(false)
  })

  it('falls back to the system browser with no shell at all', () => {
    expect(chooseAppBrowserSurface(undefined, true)).toEqual({ surface: 'external' })
    expect(chooseAppBrowserSurface({}, true)).toEqual({ surface: 'external' })
    // A guest the shell cannot create is not a browser.
    expect(chooseAppBrowserSurface({ appBrowserGuest: true }, true)).toEqual({
      surface: 'external',
    })
    expect(chooseAppBrowserSurface({ appBrowserGuest: {} }, true)).toEqual({
      surface: 'external',
    })
  })

  it('prefers the `<webview>` when a shell offers both', () => {
    expect(
      chooseAppBrowserSurface({ embeddedAppBrowser: true, appBrowserGuest: nativeGuest }, true),
    ).toEqual({ surface: 'embedded', host: 'webview' })
  })

  it('labels both hosts as in-app', () => {
    expect(appBrowserSurfaceLabel({ surface: 'embedded', host: 'webview' }).label).toBe(
      'Open in-app',
    )
    expect(appBrowserSurfaceLabel({ surface: 'embedded', host: 'native' }).label).toBe(
      'Open in-app',
    )
    expect(appBrowserSurfaceLabel({ surface: 'external' }).label).not.toMatch(/in-app/i)
  })
})
