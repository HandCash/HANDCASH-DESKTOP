import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { ethAddressFromPrivateKey, toChecksumAddress } from './address'

describe('Arc USD address', () => {
  it('derives the known Ethereum address for private key 1', () => {
    const key = PrivateKey.fromHex('0'.repeat(63) + '1')
    expect(ethAddressFromPrivateKey(key).toLowerCase()).toBe(
      '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    )
  })

  it('checksums EIP-55', () => {
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    )
  })
})
