import { describe, expect, it } from 'vitest'
import { resolveBridgeCaller } from './bridgeOrigin'

describe('resolveBridgeCaller', () => {
  it('trusts the browser Origin over a self-declared originator', () => {
    expect(
      resolveBridgeCaller({ origin: 'https://evil.example', originator: 'market.handcash.io' }),
    ).toEqual({ kind: 'app', host: 'evil.example' })
  })

  it('keeps the port and punycodes the host', () => {
    expect(resolveBridgeCaller({ origin: 'https://app.example:8443' })).toEqual({
      kind: 'app',
      host: 'app.example:8443',
    })
    expect(resolveBridgeCaller({ origin: 'https://hаndcash.io' })).toEqual({
      kind: 'app',
      host: 'xn--hndcash-2fg.io',
    })
  })

  it('refuses opaque origins instead of sharing one identity', () => {
    expect(resolveBridgeCaller({ origin: 'null' })).toEqual({ kind: 'refuse', reason: 'opaque-origin' })
    expect(resolveBridgeCaller({ origin: 'null', originator: 'market.handcash.io' })).toEqual({
      kind: 'refuse',
      reason: 'opaque-origin',
    })
    expect(resolveBridgeCaller({ origin: 'not a url' })).toEqual({ kind: 'refuse', reason: 'opaque-origin' })
  })

  it('refuses a plaintext page claiming a public host', () => {
    expect(resolveBridgeCaller({ origin: 'http://market-v2.handcash.io' })).toEqual({
      kind: 'refuse',
      reason: 'insecure-origin',
    })
    expect(resolveBridgeCaller({ origin: 'http://10.evil.example' })).toEqual({
      kind: 'refuse',
      reason: 'insecure-origin',
    })
    expect(resolveBridgeCaller({ origin: 'http://127.evil.example' })).toEqual({
      kind: 'refuse',
      reason: 'insecure-origin',
    })
  })

  it('keeps plaintext open on loopback and private networks', () => {
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://[::1]:5173',
      'http://192.168.1.20:5173',
      'http://10.0.0.4',
      'http://172.20.1.1',
      'http://studio.local:3000',
    ]) {
      expect(resolveBridgeCaller({ origin }).kind).toBe('app')
    }
    expect(resolveBridgeCaller({ origin: 'http://172.32.0.1' }).kind).toBe('refuse')
  })

  it('names browser extensions by id and refuses other schemes', () => {
    expect(resolveBridgeCaller({ origin: 'chrome-extension://abcdefghijklmnop' })).toEqual({
      kind: 'app',
      host: 'abcdefghijklmnop',
    })
    expect(resolveBridgeCaller({ origin: 'ionic://market.handcash.io' })).toEqual({
      kind: 'refuse',
      reason: 'unsupported-scheme',
    })
  })

  it('falls back to the originator for native clients', () => {
    expect(resolveBridgeCaller({ originator: 'example.com' })).toEqual({ kind: 'app', host: 'example.com' })
    expect(resolveBridgeCaller({ originator: 'https://example.com/path' })).toEqual({
      kind: 'app',
      host: 'example.com',
    })
  })

  it('refuses a caller that names no one', () => {
    expect(resolveBridgeCaller({})).toEqual({ kind: 'refuse', reason: 'no-originator' })
    expect(resolveBridgeCaller({ origin: '  ', originator: '' })).toEqual({
      kind: 'refuse',
      reason: 'no-originator',
    })
  })
})
