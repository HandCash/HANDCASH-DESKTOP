import { describe, expect, it } from 'vitest'
import { hexToHslChannels } from './colorFormat'

describe('hexToHslChannels', () => {
  it('converts tokyo-night green', () => {
    const c = hexToHslChannels('#9ece6a')
    expect(c).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/)
  })

  it('rejects junk', () => {
    expect(hexToHslChannels('nope')).toBeNull()
  })
})
