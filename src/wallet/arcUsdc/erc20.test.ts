import { describe, expect, it } from 'vitest'
import {
  decodeUint256,
  encodeBalanceOf,
  encodeTransfer,
  formatUsdcAtoms,
  parseUsdcAtoms,
  weiToAtoms,
} from './erc20'

describe('Arc USDC ERC-20 helpers', () => {
  it('encodes balanceOf and transfer', () => {
    expect(encodeBalanceOf('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf')).toBe(
      '0x70a082310000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf',
    )
    expect(encodeTransfer('0x1111111111111111111111111111111111111111', 1_000_000n)).toBe(
      '0xa9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f4240',
    )
  })

  it('parses and formats 6-decimal atoms', () => {
    expect(parseUsdcAtoms('1.5')).toBe(1_500_000n)
    expect(formatUsdcAtoms(1_500_000n)).toBe('1.5')
    expect(weiToAtoms(10n ** 18n)).toBe(1_000_000n)
  })

  it('decodes uint256 hex', () => {
    expect(decodeUint256('0xf4240')).toBe(1_000_000n)
  })
})
