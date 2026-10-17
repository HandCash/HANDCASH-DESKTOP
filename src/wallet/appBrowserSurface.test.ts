import { describe, expect, it } from 'vitest'
import {
  appBrowserSurfaceLabel,
  chooseAppBrowserSurface,
  preferredAppSurface,
} from './appBrowserSurface'

const nativeGuest = { create: () => Promise.resolve() }

describe('chooseAppBrowserSurface', () => {
  it('hosts a Desktop `<webview>` tab', () => {
    expect(chooseAppBrowserSurface({ embeddedAppBrowser: true })).toEqual({
      surface: 'embedded',
      host: 'webview',
    })
  })

  it('hosts the native guest on mobile with no lab to turn on', () => {
    expect(chooseAppBrowserSurface({ appBrowserGuest: nativeGuest })).toEqual({
      surface: 'embedded',
      host: 'native',
    })
  })

  it('falls back to the system browser with no shell at all', () => {
    expect(chooseAppBrowserSurface(undefined)).toEqual({ surface: 'external' })
    expect(chooseAppBrowserSurface({})).toEqual({ surface: 'external' })
    // A guest the shell cannot create is not a browser.
    expect(chooseAppBrowserSurface({ appBrowserGuest: true })).toEqual({ surface: 'external' })
    expect(chooseAppBrowserSurface({ appBrowserGuest: {} })).toEqual({ surface: 'external' })
  })

  it('prefers the `<webview>` when a shell offers both', () => {
    expect(
      chooseAppBrowserSurface({ embeddedAppBrowser: true, appBrowserGuest: nativeGuest }),
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

describe('preferredAppSurface', () => {
  it('keeps a phone app in the wallet', () => {
    expect(preferredAppSurface({ appBrowserGuest: nativeGuest })).toEqual({
      surface: 'embedded',
      host: 'native',
    })
  })

  it('sends a Desktop app to the system browser, where its sessions live', () => {
    expect(preferredAppSurface({ embeddedAppBrowser: true })).toEqual({ surface: 'external' })
  })

  it('has only the system browser without a guest', () => {
    expect(preferredAppSurface({})).toEqual({ surface: 'external' })
  })
})
