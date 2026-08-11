import { describe, expect, it } from 'vitest'
import {
  identiconDataUrl,
  identiconGrid,
  identiconSeedBytes,
} from './identicon.js'

describe('identicon', () => {
  it('is stable for the same seed (case-insensitive)', () => {
    const a = identiconGrid('aa'.repeat(32) + '_0')
    const b = identiconGrid('aa'.repeat(32) + '_0')
    expect(a).toEqual(b)
    expect(identiconDataUrl('aa'.repeat(32) + '_0')).toBe(
      identiconDataUrl('AA'.repeat(32) + '_0'),
    )
  })

  it('differs across seeds', () => {
    const a = identiconDataUrl('aa'.repeat(32) + '_0')
    const b = identiconDataUrl('bb'.repeat(32) + '_0')
    expect(a).not.toBe(b)
  })

  it('mirrors the left half (GitHub-style)', () => {
    const g = identiconGrid('demo')
    expect(g).toHaveLength(5)
    for (const row of g) {
      expect(row).toHaveLength(5)
      expect(row[0]).toBe(row[4])
      expect(row[1]).toBe(row[3])
    }
  })

  it('produces a data URL', () => {
    const url = identiconDataUrl('GOON', 48)
    expect(url.startsWith('data:image/svg+xml')).toBe(true)
    expect(identiconSeedBytes('GOON')).toHaveLength(16)
  })
})
