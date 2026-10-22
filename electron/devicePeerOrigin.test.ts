import { describe, expect, it } from 'vitest'
import { devicePeerCorsHeaders, devicePeerOriginAllowed } from './devicePeerOrigin.js'

describe('device-peer origins', () => {
  it('refuses a website and gives it no CORS grant', () => {
    for (const origin of ['https://evil.example', 'http://localhost:3000', 'http://192.168.1.5:3340']) {
      expect(devicePeerOriginAllowed(origin)).toBe(false)
      expect(devicePeerCorsHeaders(origin)).toEqual({})
    }
  })

  it('lets HandCash windows and native clients through', () => {
    for (const origin of ['http://localhost:5173', 'null', 'https://localhost', 'capacitor://localhost']) {
      expect(devicePeerOriginAllowed(origin)).toBe(true)
      expect(devicePeerCorsHeaders(origin)['Access-Control-Allow-Origin']).toBe(origin)
    }
    expect(devicePeerOriginAllowed(undefined)).toBe(true)
  })
})
