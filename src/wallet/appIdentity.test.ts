import { describe, expect, it } from 'vitest'
import { appDisplayName, normalizeAppHost } from './appIdentity'

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
