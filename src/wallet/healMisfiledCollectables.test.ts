import { describe, expect, it } from 'vitest'
import { classifyTokenBasketTip } from './healMisfiledCollectables'

const P2PKH = '76a914' + '11'.repeat(20) + '88ac'
/** OP_FALSE OP_IF "ord" OP_1 <image/png> OP_0 <hi> OP_ENDIF */
const IMAGE_ENV =
  '0063036f726451' + '09696d6167652f706e67' + '0002' + '6869' + '68'
/** application/bsv-20 + empty JSON — mime is enough to hold as token. */
const BSV20_ENV =
  '0063036f726451' + '126170706c69636174696f6e2f6273762d3230' + '0002' + '7b7d' + '68'
const FT_ENV =
  '0063036f726451' +
  '186170706c69636174696f6e2f317361742d66742b6a736f6e' +
  '0002' +
  '7b7d' +
  '68'

describe('classifyTokenBasketTip', () => {
  it('moves an image inscription out of the token basket', () => {
    expect(
      classifyTokenBasketTip({
        satoshis: 1,
        lockingScriptHex: IMAGE_ENV + P2PKH,
      }),
    ).toBe('collectable')
  })

  it('keeps a real BSV-21 envelope as a token', () => {
    expect(
      classifyTokenBasketTip({
        satoshis: 1,
        lockingScriptHex: BSV20_ENV + P2PKH,
      }),
    ).toBe('token')
  })

  it('keeps valid BSV-21 remittance unless the tip is already a named collectable', () => {
    const ci = JSON.stringify({
      p: 'bsv-20',
      op: 'transfer',
      id: `${'aa'.repeat(32)}_0`,
      amt: '10',
      sym: 'FOX',
    })
    expect(
      classifyTokenBasketTip({
        satoshis: 1,
        customInstructions: ci,
      }),
    ).toBe('token')
    expect(
      classifyTokenBasketTip({
        satoshis: 1,
        customInstructions: ci,
        cached: { outpoint: 'x.0', origin: `${'aa'.repeat(32)}_0`, name: 'Pixel Foxes #1' },
        importedOneSat: true,
      }),
    ).toBe('collectable')
  })

  it('moves a 1sat remittance / ordinal tag tip', () => {
    expect(
      classifyTokenBasketTip({
        satoshis: 1,
        tags: ['ordinal', `origin:${'bb'.repeat(32)}.0`, 'name:Pixel Foxes #2'],
        importedOneSat: true,
      }),
    ).toBe('collectable')
  })

  it('does not touch non-1sat outputs', () => {
    expect(
      classifyTokenBasketTip({
        satoshis: 2,
        lockingScriptHex: IMAGE_ENV + P2PKH,
      }),
    ).toBe('unknown')
  })

  it('leaves 1sat-ft mime in the token path', () => {
    expect(
      classifyTokenBasketTip({ satoshis: 1, lockingScriptHex: FT_ENV + P2PKH }),
    ).toBe('token')
  })
})
