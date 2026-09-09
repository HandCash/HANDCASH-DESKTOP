import { afterEach, describe, expect, it } from 'vitest'
import {
  clearNavChild,
  closeEmbeddedAppBrowser,
  focusEmbeddedAppBrowser,
  getEmbeddedAppBrowser,
  getNavState,
  openEmbeddedAppBrowser,
  openSendFlow,
  setNavSection,
} from './navStore'

afterEach(() => {
  closeEmbeddedAppBrowser()
  setNavSection('activity')
})

describe('embedded app browser session', () => {
  it('keeps the session parked when navigating away from Apps', () => {
    openEmbeddedAppBrowser('https://pixelwar.click', 'https://pixelwar.click/')
    expect(getEmbeddedAppBrowser()).toEqual({
      origin: 'https://pixelwar.click',
      url: 'https://pixelwar.click/',
    })
    expect(getNavState().child?.type).toBe('app-browser')

    setNavSection('activity')
    expect(getNavState()).toEqual({ section: 'activity', child: null })
    expect(getEmbeddedAppBrowser()).toEqual({
      origin: 'https://pixelwar.click',
      url: 'https://pixelwar.click/',
    })
  })

  it('keeps the session when another nav child opens (request / send overlay path)', () => {
    openEmbeddedAppBrowser('https://pixelwar.click', 'https://pixelwar.click/')
    openSendFlow()
    expect(getNavState().child?.type).toBe('send')
    expect(getEmbeddedAppBrowser()?.origin).toBe('https://pixelwar.click')
  })

  it('restores a parked session to the Apps foreground', () => {
    openEmbeddedAppBrowser('https://pixelwar.click', 'https://pixelwar.click/')
    setNavSection('collectables')
    focusEmbeddedAppBrowser()
    expect(getNavState()).toEqual({
      section: 'apps',
      child: {
        type: 'app-browser',
        origin: 'https://pixelwar.click',
        url: 'https://pixelwar.click/',
      },
    })
  })

  it('ends the session only on explicit close / clear of the browser child', () => {
    openEmbeddedAppBrowser('https://pixelwar.click', 'https://pixelwar.click/')
    setNavSection('activity')
    expect(getEmbeddedAppBrowser()).not.toBeNull()

    focusEmbeddedAppBrowser()
    clearNavChild()
    expect(getEmbeddedAppBrowser()).toBeNull()
    expect(getNavState().child).toBeNull()

    openEmbeddedAppBrowser('https://pixelwar.click', 'https://pixelwar.click/')
    closeEmbeddedAppBrowser()
    expect(getEmbeddedAppBrowser()).toBeNull()
    expect(getNavState().child).toBeNull()
  })

  it('WalletNav keeps an open browser under compact permission prompts', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../components/WalletNav.tsx', import.meta.url),
      'utf8',
    )
    expect(src).toContain('getEmbeddedAppBrowser()')
    expect(src).toContain('browserUnderPermission')
    expect(src).toContain('nav-child-stage--browser-parked')
    // Must not unconditionally clear the browser when a prompt arrives.
    expect(src).toMatch(
      /if \(getEmbeddedAppBrowser\(\)\) \{\s*setMountedLight/,
    )
  })
})
