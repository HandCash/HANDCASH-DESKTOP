import { describe, expect, it } from 'vitest'
import { encodeBsv21Binary } from './decode162'
import { deployDisplayFromScript } from './deployDisplay'

const P2PKH_REST = `76a914${'11'.repeat(20)}88ac`
const DEPLOY_TXID = 'ab'.repeat(32)
const TOKEN_ID = `${DEPLOY_TXID}_0`

describe('deployDisplayFromScript', () => {
  it('names a BRC-162 binary deploy and points its icon at the same transaction', () => {
    const script = encodeBsv21Binary({
      amount: 1_000n,
      payload: { sym: 'GOLD', dec: 2, icon: Uint8Array.from([1, 0, 0, 0]) },
      rest: P2PKH_REST,
    }).toHex()

    expect(deployDisplayFromScript(script, TOKEN_ID)).toEqual({
      encoding: 'binary',
      sym: 'GOLD',
      dec: 2,
      icon: `${DEPLOY_TXID}_1`,
    })
  })

  it('carries nothing for a transfer output', () => {
    const transfer = encodeBsv21Binary({ tokenId: TOKEN_ID, amount: 5n, rest: P2PKH_REST }).toHex()
    expect(deployDisplayFromScript(transfer, TOKEN_ID)).toBeNull()
    expect(deployDisplayFromScript(undefined, TOKEN_ID)).toBeNull()
  })
})
