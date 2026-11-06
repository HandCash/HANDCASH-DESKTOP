import { describe, expect, it } from 'vitest'
import { decodeHex, encodeHex } from './encoding'
import { fromHex, LtcFormatError, toHex } from '../wallet/ltc/litecoin'

describe('Meridian strict hex encoding', () => {
  it('preserves empty input and leading zeroes', () => {
    expect(encodeHex(new Uint8Array())).toBe('')
    expect(decodeHex('')).toEqual(new Uint8Array())
    expect(encodeHex(new Uint8Array([0, 1, 15, 16, 127, 128, 255]))).toBe('00010f107f80ff')
    expect(decodeHex('00010F107F80fF')).toEqual(new Uint8Array([0, 1, 15, 16, 127, 128, 255]))
  })

  it('matches an independent Node oracle for all byte values and offset views', () => {
    const storage = Uint8Array.from({ length: 258 }, (_, i) => (i - 1) & 255)
    const input = storage.subarray(1, 257)
    const before = storage.slice()
    const expected = Buffer.from(input).toString('hex')
    expect(encodeHex(input)).toBe(expected)
    expect(decodeHex(expected)).toEqual(new Uint8Array(Buffer.from(expected, 'hex')))
    expect(storage).toEqual(before)
  })

  it.each(['0', 'abc', 'gg', '0x00', ' 00', '00 ', '00\n', '0g', 'ＦＦ', '💰'])('rejects invalid input %j', (input) => {
    expect(() => decodeHex(input)).toThrow('Expected even-length hexadecimal')
  })

  it('returns independently owned decoded buffers', () => {
    const a = decodeHex('0001')
    const b = decodeHex('0001')
    a.fill(255)
    expect(b).toEqual(new Uint8Array([0, 1]))
  })

  it('preserves legacy entry point normalization and error type', () => {
    expect(toHex(fromHex(' \t00Ab\n'))).toBe('00ab')
    for (const value of ['a', 'gg', '0x00', '00 01']) {
      expect(() => fromHex(value)).toThrow(LtcFormatError)
      expect(() => fromHex(value)).toThrow('not hex')
    }
  })
})
