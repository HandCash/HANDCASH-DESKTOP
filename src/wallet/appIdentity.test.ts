import { describe, expect, it } from 'vitest'
import {
  appDisplayName,
  appFaviconCandidates,
  normalizeAppHost,
} from './appIdentity'

describe('normalizeAppHost', () => {
  it('reduces an origin to its host', () => {
    expect(normalizeAppHost('https://brc-cloud.bcryderman.workers.dev/app-lab')).toBe(
      'brc-cloud.bcryderman.workers.dev',
    )
    expect(normalizeAppHost('  HTTPS://Market.HandCash.io  ')).toBe('market.handcash.io')
    expect(normalizeAppHost(undefined)).toBe('unknown-app')
  })
})

describe('appDisplayName', () => {
  it('names the app by its own subdomain on shared app hosts', () => {
    expect(appDisplayName('https://brc-cloud.bcryderman.workers.dev')).toBe('BRC Cloud')
    expect(appDisplayName('free-radio.pages.dev')).toBe('Free Radio')
    expect(appDisplayName('https://someone.github.io/app')).toBe('Someone')
  })

  it('keeps using the registrable domain elsewhere', () => {
    expect(appDisplayName('https://market.handcash.io')).toBe('HandCash')
    expect(appDisplayName('https://app.example.com')).toBe('Example')
    expect(appDisplayName('http://127.0.0.1:5173')).toBe('Local app')
    expect(appDisplayName(undefined)).toBe('Unknown app')
  })
})

describe('appFaviconCandidates', () => {
  it('does not use generic favicon proxies for shared app hosts', () => {
    const candidates = appFaviconCandidates(
      'https://brc-cloud.bcryderman.workers.dev',
    )
    expect(candidates).toContain(
      'https://brc-cloud.bcryderman.workers.dev/favicon.svg',
    )
    expect(candidates.some((candidate) => candidate.includes('google.com'))).toBe(false)
    expect(candidates.some((candidate) => candidate.includes('duckduckgo.com'))).toBe(false)
  })

  it('retains favicon proxy fallbacks for ordinary app domains', () => {
    const candidates = appFaviconCandidates('https://example.com')
    expect(candidates.some((candidate) => candidate.includes('google.com'))).toBe(true)
  })
})
