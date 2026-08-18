import { describe, expect, it } from 'vitest'
import {
  parseFungibleSendAmount,
  selectFungibleTips,
} from './sendFungible'
import type { Bsv21Utxo } from './bsv21'
import { buildBsv21TransferLockingScript } from './bsv21Inscribe'
import { chooseBsv21SendPath, classifyBsv21TipKind } from './bsv21TipKind'

const TOKEN_ID = `${'ab'.repeat(32)}_0`
const COSIGN_PUB = '02' + 'ab'.repeat(32)
const PLAIN_P2PKH = `76a914${'11'.repeat(20)}88ac`

function tip(amt: string, outpoint = `${'cd'.repeat(32)}.0`): Bsv21Utxo {
  return {
    outpoint,
    tokenId: TOKEN_ID,
    amt,
    op: 'transfer',
    dec: 0,
    satoshis: 1,
  }
}

describe('parseFungibleSendAmount', () => {
  it('parses whole units when dec is 0', () => {
    expect(parseFungibleSendAmount('12', { dec: 0, amt: '100' })).toEqual({
      units: 12n,
      unitsStr: '12',
    })
  })

  it('parses decimals against the token scale', () => {
    expect(parseFungibleSendAmount('1.50', { dec: 2, amt: '1000' })).toEqual({
      units: 150n,
      unitsStr: '150',
    })
  })

  it('refuses amounts above the held balance', () => {
    expect(() => parseFungibleSendAmount('3', { dec: 0, amt: '2' })).toThrow(
      /Insufficient balance/,
    )
  })

  it('refuses too many fractional digits', () => {
    expect(() => parseFungibleSendAmount('1.001', { dec: 2, amt: '1000' })).toThrow(
      /At most 2/,
    )
  })
})

describe('selectFungibleTips', () => {
  it('picks largest tips first until need is covered', () => {
    const { selected, selectedSum } = selectFungibleTips(
      [tip('10', 'aa.0'), tip('40', 'bb.0'), tip('30', 'cc.0')],
      50n,
    )
    expect(selected.map((t) => t.outpoint)).toEqual(['bb.0', 'cc.0'])
    expect(selectedSum).toBe(70n)
  })

  it('throws when tips cannot cover the amount', () => {
    expect(() => selectFungibleTips([tip('10'), tip('5')], 20n)).toThrow(
      /Not enough token outputs/,
    )
  })
})

describe('buildBsv21TransferLockingScript', () => {
  it('inscribes transfer JSON before a P2PKH lock', () => {
    const { lockingScript, json } = buildBsv21TransferLockingScript({
      // Valid mainnet P2PKH address (Bitcoin genesis coinbase pubkey hash).
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      tokenId: TOKEN_ID,
      amt: '42',
      sym: 'TST',
      dec: 0,
    })
    expect(json.p).toBe('bsv-20')
    expect(json.op).toBe('transfer')
    expect(json.amt).toBe('42')
    expect(json.id).toBeTruthy()
    expect(lockingScript.startsWith('0063036f7264')).toBe(true)
    expect(lockingScript.length).toBeGreaterThan(80)
  })
})

describe('chooseBsv21SendPath fail-closed', () => {
  it('routes plain tips to plain', () => {
    expect(chooseBsv21SendPath(classifyBsv21TipKind({ lockingScript: PLAIN_P2PKH }))).toEqual({
      path: 'plain',
    })
  })

  it('refuses cosigned tips without a cosigner client', () => {
    const kind = classifyBsv21TipKind({
      lockingScript: PLAIN_P2PKH,
      cosignClaim: { pubkey: COSIGN_PUB },
    })
    expect(chooseBsv21SendPath(kind)).toEqual({
      path: 'refuse',
      reason: 'cosigner_required',
    })
  })
})
