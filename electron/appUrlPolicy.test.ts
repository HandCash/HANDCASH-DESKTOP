import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { isTrustedAppUrl, rewriteForcedHttpsUiUrl } from './appUrlPolicy.js'

const distRoot = path.resolve('/tmp/handcash/dist')
const policy = {
  devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  packagedUiOrigin: 'http://localhost:5173',
  distRoot,
}

describe('isTrustedAppUrl', () => {
  it('accepts the exact trusted origins and their routes', () => {
    expect(isTrustedAppUrl('http://localhost:5173/collectables/1', policy)).toBe(true)
    expect(isTrustedAppUrl('http://127.0.0.1:5173/', policy)).toBe(true)
  })

  it('rejects prefix-confusion hosts and ports', () => {
    expect(isTrustedAppUrl('http://localhost:5173.evil.example/', policy)).toBe(false)
    expect(isTrustedAppUrl('http://localhost:51730/', policy)).toBe(false)
  })

  it('treats Chromium HTTPS upgrades of the UI origin as trusted', () => {
    expect(isTrustedAppUrl('https://localhost:5173/', policy)).toBe(true)
    expect(isTrustedAppUrl('https://127.0.0.1:5173/collectables/1', policy)).toBe(true)
  })

  it('accepts only files contained by dist', () => {
    expect(isTrustedAppUrl(pathToFileURL(path.join(distRoot, 'index.html')).href, policy)).toBe(
      true,
    )
    expect(isTrustedAppUrl(pathToFileURL(`${distRoot}-attacker/index.html`).href, policy)).toBe(
      false,
    )
    expect(isTrustedAppUrl(pathToFileURL(path.join(distRoot, '..', 'vault.txt')).href, policy)).toBe(
      false,
    )
  })
})

describe('rewriteForcedHttpsUiUrl', () => {
  it('rewrites HTTPS upgrades of the UI origin back to HTTP', () => {
    expect(rewriteForcedHttpsUiUrl('https://localhost:5173/collectables/1', policy)).toBe(
      'http://localhost:5173/collectables/1',
    )
    expect(rewriteForcedHttpsUiUrl('https://127.0.0.1:5173/', policy)).toBe(
      'http://127.0.0.1:5173/',
    )
  })

  it('leaves real HTTPS and non-UI hosts alone', () => {
    expect(rewriteForcedHttpsUiUrl('http://localhost:5173/', policy)).toBeNull()
    expect(rewriteForcedHttpsUiUrl('https://localhost:2121/favicon.ico', policy)).toBeNull()
    expect(rewriteForcedHttpsUiUrl('https://www.lilb.it/', policy)).toBeNull()
  })
})
