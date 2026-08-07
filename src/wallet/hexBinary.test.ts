import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  hexToBytes,
  hexToU32Le,
  reverseTxidHex,
  u32LeToHex,
} from './hexBinary'

describe('hexBinary', () => {
  it('round-trips little-endian u32', () => {
    expect(u32LeToHex(0)).toBe('00000000')
    expect(u32LeToHex(1)).toBe('01000000')
    expect(u32LeToHex(0x12345678)).toBe('78563412')
    expect(hexToU32Le('01000000')).toBe(1)
    expect(hexToU32Le(u32LeToHex(42))).toBe(42)
  })

  it('reverses txid byte order', () => {
    const txid = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
    const rev = reverseTxidHex(txid)
    expect(rev).toBe('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100')
    expect(reverseTxidHex(rev)).toBe(txid)
  })

  it('round-trips arbitrary hex', () => {
    const hex = 'deadbeef'
    expect(bytesToHex(hexToBytes(hex))).toBe(hex)
  })
})
