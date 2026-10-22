import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectedApp } from '../wallet/permissions'
import { ConnectedAppsPanel, ConnectedAppsResults } from './ConnectedAppsPanel'

const NOW = Date.UTC(2026, 9, 22, 16, 0)
const MIN = 60_000

vi.mock('./AppAvatar', () => ({ AppAvatar: () => createElement('span', { className: 'avatar-mock' }) }))
vi.mock('./AppLaunchMenu', () => ({ AppLaunchMenu: () => createElement('button', null, 'Open') }))
vi.mock('./CollectionViewToggle', () => ({ CollectionViewToggle: () => null }))
vi.mock('./AppsSearchBar', () => ({
  AppsSearchBar: () => createElement('form', { className: 'apps-search-mock', role: 'search' }),
  appsSearchAddress: () => null,
  canOpenAppAddresses: () => true,
}))
vi.mock('../wallet/permissions', () => ({
  acceptsIncomingFunds: (origin: string) => origin.includes('pixel'),
  getItemAccess: () => ({ view: 'none', collections: [], canReceive: false }),
  getTokenAccess: () => ({ view: 'none', ids: [] }),
}))
vi.mock('../wallet/fx', () => ({
  formatPrimaryFromSats: () => '$0.00',
  getCachedUsdPerBsv: () => null,
  satsToUsd: () => 0,
  subscribeUsdRate: () => () => undefined,
}))
vi.mock('../wallet/displayCurrency', () => ({
  getDisplayCurrency: () => 'usd',
  subscribeDisplayCurrency: () => () => undefined,
}))
vi.mock('../wallet/appActivity', () => ({
  getAppActivityVolume: () => 0,
  getAppLastActivityAt: (origin: string) => (origin.includes('pixel') ? NOW - 5 * MIN : 0),
  getAppMoneySummary: () => ({ spent24h: 0, earned24h: 0 }),
  getSpentSatsSince: () => 0,
  subscribeAppActivity: () => () => undefined,
}))
vi.mock('../wallet/autoPay', () => ({
  getAutoPaySettings: () => null,
  subscribeAutoPay: () => () => undefined,
}))
vi.mock('../wallet/collectionView', () => ({
  getCollectionView: () => 'list',
  subscribeCollectionView: () => () => undefined,
}))
vi.mock('../wallet/layoutViewport', () => ({
  isCompactLayout: () => false,
  subscribeCompactLayout: () => () => undefined,
}))
vi.mock('../wallet/navStore', () => ({ openAppDetails: vi.fn(), openDevKeys: vi.fn() }))
vi.mock('../wallet/soundService', () => ({ playWalletSound: vi.fn() }))

const APPS: ConnectedApp[] = [
  { origin: 'https://pixel.example', name: 'Pixel Foxes', connectedAt: NOW - 3 * 24 * 60 * MIN },
  { origin: 'https://cards.example', name: 'Card Packs', connectedAt: NOW - 2 * 24 * 60 * MIN },
]

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const results = (apps: ConnectedApp[], query = '') =>
  renderToStaticMarkup(
    createElement(ConnectedAppsResults, {
      apps,
      query,
      view: 'list',
      currency: 'usd',
      usdPerBsv: null,
      now: NOW,
      opensAddress: false,
      canOpen: true,
    }),
  )

describe('ConnectedAppsResults', () => {
  it('shows the empty state when no app is connected', () => {
    const out = text(results([]))
    expect(out).toContain('No apps connected')
    expect(out).toContain('Type a web address above to open an app.')
  })

  it('lists each app with what it can reach, when it was used and a way to manage it', () => {
    const html = results(APPS)
    const out = text(html)
    expect(out).toContain('Pixel Foxes')
    expect(out).toContain('Receive BSV')
    expect(out).toContain('Used 5 min ago')
    expect(out).toContain('Card Packs')
    expect(out).toContain('View only, no spending')
    expect(out).toContain('Connected 2 days ago')
    expect(html).toContain('aria-label="Manage or disconnect Card Packs"')
  })

  it('shows only matching apps for a search', () => {
    const out = text(results(APPS, 'pixel'))
    expect(out).toContain('Pixel Foxes')
    expect(out).not.toContain('Card Packs')
  })

  it('says plainly when a search matches nothing', () => {
    const out = text(results(APPS, 'zzz'))
    expect(out).toContain('No apps found')
    expect(out).toContain('Nothing matches “zzz”.')
  })
})

describe('ConnectedAppsPanel', () => {
  const panel = (apps: ConnectedApp[]) =>
    renderToStaticMarkup(createElement(ConnectedAppsPanel, { apps, openTabCount: 0, onShowTabs: () => undefined }))

  it('puts the search directly under the title, above the apps', () => {
    const html = panel(APPS)
    const title = html.indexOf('Connected apps')
    const search = html.indexOf('apps-search-mock')
    expect(title).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(title)
    expect(search).toBeLessThan(html.indexOf('Pixel Foxes'))
    expect(html).toContain('aria-label="2 connected apps"')
  })

  it('keeps the search above the empty state when apps can be opened', () => {
    const html = panel([])
    expect(html.indexOf('apps-search-mock')).toBeGreaterThan(-1)
    expect(html.indexOf('apps-search-mock')).toBeLessThan(html.indexOf('No apps connected'))
  })
})
