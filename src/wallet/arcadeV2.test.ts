import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ARCADE_V2_DEV_PROXY_MAIN,
  ARCADE_V2_DEV_PROXY_TEST,
  arcadeV2BaseUrl,
  stripArcadeCorsForbiddenHeaders,
} from './arcadeV2'

describe('arcadeV2BaseUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses Vite dev proxy paths in DEV', () => {
    expect(arcadeV2BaseUrl('main')).toBe(ARCADE_V2_DEV_PROXY_MAIN)
    expect(arcadeV2BaseUrl('test')).toBe(ARCADE_V2_DEV_PROXY_TEST)
    expect(arcadeV2BaseUrl('reg')).toBeNull()
  })
})

describe('stripArcadeCorsForbiddenHeaders', () => {
  it('drops XDeployment-ID so Arcade preflight from localhost succeeds', () => {
    expect(
      stripArcadeCorsForbiddenHeaders({
        'Content-Type': 'application/json',
        'XDeployment-ID': 'abc',
        'X-CallbackToken': 'tok',
      }),
    ).toEqual({
      'Content-Type': 'application/json',
      'X-CallbackToken': 'tok',
    })
  })
})
