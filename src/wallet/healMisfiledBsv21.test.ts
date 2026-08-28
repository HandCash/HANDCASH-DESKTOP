import { describe, expect, it } from 'vitest'
import { classifyOneSatAsBsv21 } from './healMisfiledBsv21'

const P2PKH = '76a914' + '11'.repeat(20) + '88ac'
const IMAGE_ENV =
  '0063036f726451' + '09696d6167652f706e67' + '0002' + '6869' + '68'
const BSV20_EMPTY =
  '0063036f726451' + '126170706c69636174696f6e2f6273762d3230' + '0002' + '7b7d' + '68'
const FT_ENV =
  '0063036f726451' +
  '186170706c69636174696f6e2f317361742d66742b6a736f6e' +
  '0002' +
  '7b7d' +
  '68'

const tokenId = `${'aa'.repeat(32)}_0`
const transfer = {
  p: 'bsv-20',
  op: 'transfer',
  id: tokenId,
  amt: '1000',
  sym: 'FOX',
}

function transferEnv(): string {
  const mime = 'application/bsv-20'
  const mimeHex = Array.from(new TextEncoder().encode(mime))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const body = JSON.stringify(transfer)
  const bodyHex = Array.from(new TextEncoder().encode(body))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const mimeLen = (mimeHex.length / 2).toString(16).padStart(2, '0')
  const bodyLen = bodyHex.length / 2
  const bodyPush =
    bodyLen < 76
      ? bodyLen.toString(16).padStart(2, '0') + bodyHex
      : '4c' + bodyLen.toString(16).padStart(2, '0') + bodyHex
  return '0063036f726451' + mimeLen + mimeHex + '00' + bodyPush + '68'
}

describe('classifyOneSatAsBsv21', () => {
  it('moves a valid BSV-21 envelope out of the NFT basket', () => {
    const got = classifyOneSatAsBsv21({
      satoshis: 1,
      outpoint: `${'aa'.repeat(32)}.0`,
      lockingScriptHex: transferEnv() + P2PKH,
    })
    expect(got.kind).toBe('bsv21')
    if (got.kind === 'bsv21') {
      expect(got.payload.sym).toBe('FOX')
      expect(got.tokenId).toBe(tokenId)
    }
  })

  it('moves a valid BSV-21 remittance / tags tip', () => {
    const got = classifyOneSatAsBsv21({
      satoshis: 1,
      outpoint: `${'bb'.repeat(32)}.1`,
      customInstructions: JSON.stringify(transfer),
      tags: ['bsv21', `bsv21:${tokenId}`, 'amt:1000', 'sym:fox'],
    })
    expect(got.kind).toBe('bsv21')
  })

  it('does not move an image collectable even with token remittance', () => {
    expect(
      classifyOneSatAsBsv21({
        satoshis: 1,
        lockingScriptHex: IMAGE_ENV + P2PKH,
        customInstructions: JSON.stringify(transfer),
      }).kind,
    ).toBe('skip')
  })

  it('does not move 1sat-ft (other healer)', () => {
    expect(
      classifyOneSatAsBsv21({
        satoshis: 1,
        lockingScriptHex: FT_ENV + P2PKH,
      }).kind,
    ).toBe('skip')
  })

  it('does not move non-1sat outputs', () => {
    expect(
      classifyOneSatAsBsv21({
        satoshis: 2,
        customInstructions: JSON.stringify(transfer),
      }).kind,
    ).toBe('skip')
  })

  it('does not move a bsv-20 mime without a holding payload', () => {
    expect(
      classifyOneSatAsBsv21({
        satoshis: 1,
        lockingScriptHex: BSV20_EMPTY + P2PKH,
      }).kind,
    ).toBe('skip')
  })
})
