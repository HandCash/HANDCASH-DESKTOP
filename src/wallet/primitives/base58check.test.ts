import { Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { fromBase58Check, toBase58Check } from './base58check'

describe('address-only base58check adapter', () => {
  it('matches fixed zero-hash mainnet and leading-zero vectors', () => {
    expect(toBase58Check(Array(20).fill(0))).toBe('1111111111111111111114oLvT2')
    expect(fromBase58Check('1111111111111111111114oLvT2')).toEqual({ prefix: [0], data: Array(20).fill(0) })
  })

  it.each([0, 5, 0x30, 0x32, 0x1e, 0x16])('preserves legacy address version %i and checksum', (version) => {
    for (const data of [Array(20).fill(0), Array(20).fill(255), Array.from({ length: 20 }, (_, i) => i)]) {
      const encoded = toBase58Check(data, [version])
      expect(encoded).toBe(Utils.toBase58Check(data, [version]))
      expect(fromBase58Check(encoded)).toEqual({ prefix: [version], data })
    }
  })

  it.each(['', '0OIl', '1', '1111111111111111111114oLvT3', '1'.repeat(129)])('rejects invalid address %s', (address) => {
    expect(() => fromBase58Check(address)).toThrow()
  })
})
