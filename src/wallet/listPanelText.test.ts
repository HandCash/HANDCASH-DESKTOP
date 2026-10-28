import { describe, expect, it } from 'vitest'
import { AUTO_PAY_SCOPE, CONNECT_GRANTED_SCOPES } from './appIdentity'
import { appAccessText, appSeenText, filterConnectedApps, sinceText } from './listPanelText'

const NOW = Date.UTC(2026, 9, 22, 16, 0)
const MIN = 60_000

describe('sinceText', () => {
  it('counts minutes, hours and days, then gives the date', () => {
    expect(sinceText(NOW - 20_000, NOW)).toBe('just now')
    expect(sinceText(NOW - 5 * MIN, NOW)).toBe('5 min ago')
    expect(sinceText(NOW - 3 * 60 * MIN, NOW)).toBe('3 h ago')
    expect(sinceText(NOW - 26 * 60 * MIN, NOW)).toBe('yesterday')
    expect(sinceText(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('3 days ago')
    expect(sinceText(NOW - 30 * 24 * 60 * MIN, NOW)).not.toMatch(/ago|just now/)
  })

  it('never says a future time is ago', () => {
    expect(sinceText(NOW + 10 * MIN, NOW)).toBe('just now')
  })
})

describe('appSeenText', () => {
  it('prefers the last use over the connect time', () => {
    expect(appSeenText(NOW - 3 * 24 * 60 * MIN, NOW - 5 * MIN, NOW)).toBe('Used 5 min ago')
    expect(appSeenText(NOW - 3 * 24 * 60 * MIN, 0, NOW)).toBe('Connected 3 days ago')
  })
})

describe('appAccessText', () => {
  const [walletAccess, receive] = CONNECT_GRANTED_SCOPES

  it('names only the grants beyond plain wallet access', () => {
    expect(appAccessText([walletAccess, receive, AUTO_PAY_SCOPE])).toBe('Receive BSV · Auto-pay')
  })

  it('falls back to the base access when nothing else is granted', () => {
    expect(appAccessText([walletAccess])).toBe('View only, no spending')
  })
})

describe('filterConnectedApps', () => {
  const apps = [
    { origin: 'https://pixel.example', name: 'Pixel Foxes', connectedAt: 1 },
    { origin: 'https://cards.example', name: 'Card Packs', connectedAt: 2 },
  ]

  it('matches name or origin, ignoring case and spaces', () => {
    expect(filterConnectedApps(apps, '  FOX ').map((a) => a.name)).toEqual(['Pixel Foxes'])
    expect(filterConnectedApps(apps, 'cards.ex').map((a) => a.name)).toEqual(['Card Packs'])
  })

  it('keeps every app for an empty query and none for a miss', () => {
    expect(filterConnectedApps(apps, '')).toHaveLength(2)
    expect(filterConnectedApps(apps, 'zzz')).toEqual([])
  })
})
