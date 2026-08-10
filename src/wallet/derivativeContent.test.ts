import { describe, expect, it } from 'vitest'
import { parseContentReference, isReferenceMime } from './derivativeContent'
import { resolveDerivativeContent } from './derivativeContentResolve'
import { parseOrdEnvelope, hasOrdEnvelope } from './ordinalOwnership'

const PARENT = 'aa'.repeat(32) + '_0'
const PARENT_DOT = 'aa'.repeat(32) + '.0'

describe('parseContentReference', () => {
  it('reads OrdFS /content paths', () => {
    expect(
      parseContentReference(`/content/${PARENT}.png`, 'text/uri-list'),
    ).toBe(PARENT)
    expect(
      parseContentReference(`/content/${PARENT_DOT}.webp\n`, 'text/uri-list'),
    ).toBe(PARENT)
  })

  it('reads ord:// and sat:// schemes', () => {
    expect(parseContentReference(`ord://${PARENT}`, 'text/plain')).toBe(PARENT)
    expect(parseContentReference(`sat://${PARENT_DOT}`, 'text/uri-list')).toBe(PARENT)
  })

  it('skips comments and off-chain urls without outpoints', () => {
    expect(
      parseContentReference('# ignore\nhttps://example.com/kitkat.png', 'text/uri-list'),
    ).toBeNull()
  })
})

describe('resolveDerivativeContent', () => {
  it('prefers an explicit remittance claim', () => {
    expect(
      resolveDerivativeContent({
        claimed: PARENT_DOT,
        originScriptHex: undefined,
      }),
    ).toBe(PARENT)
  })

  it('reads BRC-160 field 3 parent from the origin envelope', () => {
    // OP_FALSE OP_IF "ord" OP_1 <text/plain> OP_3 <36-byte parent> OP_0 <hi> OP_ENDIF
    const parentBytes = [
      ...Array.from({ length: 32 }, () => 0xaa),
      0x00,
      0x00,
      0x00,
      0x00, // vout 0 LE
    ]
    const parentPush =
      parentBytes.length.toString(16).padStart(2, '0') +
      parentBytes.map((b) => b.toString(16).padStart(2, '0')).join('')
    const envelope =
      '0063036f7264' + // OP_FALSE OP_IF "ord"
      '51' +
      '0a746578742f706c61696e' + // OP_1 text/plain
      '53' +
      parentPush + // OP_3 parent
      '00' +
      '02' +
      '6869' + // OP_0 hi
      '68'
    expect(hasOrdEnvelope(envelope)).toBe(true)
    const parsed = parseOrdEnvelope(envelope)
    expect(parsed?.parent).toBe(PARENT)
    expect(
      resolveDerivativeContent({ originScriptHex: envelope }),
    ).toBe(PARENT)
  })

  it('reads uri-list body when field 3 is absent', () => {
    const body = `/content/${PARENT}.png`
    const bodyHex = Array.from(new TextEncoder().encode(body))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const bodyPush =
      (body.length <= 75
        ? body.length.toString(16).padStart(2, '0')
        : '4c' + body.length.toString(16).padStart(2, '0')) + bodyHex
    const envelope =
      '0063036f7264' +
      '51' +
      '0d746578742f7572692d6c697374' + // text/uri-list
      '00' +
      bodyPush +
      '68'
    expect(parseOrdEnvelope(envelope)?.contentType).toBe('text/uri-list')
    expect(resolveDerivativeContent({ originScriptHex: envelope })).toBe(PARENT)
  })
})

describe('isReferenceMime', () => {
  it('flags uri-list', () => {
    expect(isReferenceMime('text/uri-list')).toBe(true)
    expect(isReferenceMime('image/png')).toBe(false)
  })
})
