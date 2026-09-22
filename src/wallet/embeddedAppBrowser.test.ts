import { afterEach, describe, expect, it } from 'vitest'
import {
  clearNavChild,
  closeAllEmbeddedAppBrowsers,
  closeEmbeddedAppBrowser,
  focusEmbeddedAppBrowser,
  getEmbeddedAppBrowser,
  getEmbeddedAppBrowserTabs,
  getNavState,
  openEmbeddedAppBrowser,
  openSendFlow,
  setNavSection,
} from './navStore'

afterEach(() => {
  closeAllEmbeddedAppBrowsers()
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

  it('keeps multiple app tabs alive and focuses an existing tab', () => {
    openEmbeddedAppBrowser('https://pixelwar.click', 'https://pixelwar.click/')
    openEmbeddedAppBrowser('https://example.com', 'https://example.com/app')

    expect(getEmbeddedAppBrowserTabs()).toEqual([
      { origin: 'https://pixelwar.click', url: 'https://pixelwar.click/' },
      { origin: 'https://example.com', url: 'https://example.com/app' },
    ])
    expect(getEmbeddedAppBrowser()?.origin).toBe('https://example.com')

    focusEmbeddedAppBrowser('https://pixelwar.click')
    expect(getEmbeddedAppBrowser()?.origin).toBe('https://pixelwar.click')
    expect(getNavState().child).toMatchObject({
      type: 'app-browser',
      origin: 'https://pixelwar.click',
    })

    closeEmbeddedAppBrowser('https://pixelwar.click')
    expect(getEmbeddedAppBrowserTabs()).toEqual([
      { origin: 'https://example.com', url: 'https://example.com/app' },
    ])
    expect(getNavState().child).toMatchObject({
      type: 'app-browser',
      origin: 'https://example.com',
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

  it('WalletNav keeps an open browser under permission prompts', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../components/WalletNav.tsx', import.meta.url),
      'utf8',
    )
    expect(src).toContain('getEmbeddedAppBrowser()')
    expect(src).toContain('browserUnderPermission')
    expect(src).toContain(
      'const browserUnderPermission = pendingPrompt != null && embeddedBrowser != null',
    )
    expect(src).toContain('nav-child-stage--browser-parked')
    // Must not unconditionally clear the browser when a prompt arrives.
    expect(src).toMatch(
      /if \(getEmbeddedAppBrowser\(\)\) \{\s*setMountedLight/,
    )
  })
})
