import { describe, expect, it } from 'vitest'
import { encodeBsv21Binary } from './decode162'
import { deployDisplayFromScript } from './deployDisplay'

const P2PKH_REST = `76a914${'11'.repeat(20)}88ac`
const DEPLOY_TXID = 'ab'.repeat(32)
const TOKEN_ID = `${DEPLOY_TXID}_0`

describe('deployDisplayFromScript', () => {
  it('names a BRC-162 deploy and points its embedded icon at the deploy itself', () => {
    const script = encodeBsv21Binary({
      amount: 1_000n,
      payload: {
        sym: 'GOLD',
        dec: 2,
        iconImage: { mediaType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) },
      },
      rest: P2PKH_REST,
    }).toHex()

    expect(deployDisplayFromScript(script, TOKEN_ID)).toEqual({
      encoding: 'binary',
      sym: 'GOLD',
      dec: 2,
      icon: TOKEN_ID,
    })
  })

  it('points a draft-tagged icon pointer at the same transaction', () => {
    const script = encodeBsv21Binary({
      layout: 'draft-tagged',
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

  it('flags a deploy that requires processing', () => {
    // OP_0 OP_1 OP_2DROP <{"req":[1]}> OP_DROP <p2pkh>
    const script = `00516d07a163726571810175${P2PKH_REST}`
    expect(deployDisplayFromScript(script, TOKEN_ID)).toEqual({
      encoding: 'binary',
      requiresProcessing: true,
    })
  })

  it('carries nothing for a transfer output', () => {
    const transfer = encodeBsv21Binary({ tokenId: TOKEN_ID, amount: 5n, rest: P2PKH_REST }).toHex()
    expect(deployDisplayFromScript(transfer, TOKEN_ID)).toBeNull()
    expect(deployDisplayFromScript(undefined, TOKEN_ID)).toBeNull()
  })
})
