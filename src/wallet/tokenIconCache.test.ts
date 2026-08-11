import { describe, expect, it } from 'vitest'
import {
  getTokenIconDataUrl,
  rememberTokenIcon,
  tokenIconBytes,
} from './tokenIconCache'

describe('tokenIconCache', () => {
  it('round-trips icon bytes as a data URL', () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    rememberTokenIcon('aa'.repeat(32) + '_0', body, 'image/png')
    const url = getTokenIconDataUrl('aa'.repeat(32) + '.0')
    expect(url?.startsWith('data:image/png;base64,')).toBe(true)
    expect(tokenIconBytes('AA'.repeat(32) + '_0')).toEqual(body)
  })
})
