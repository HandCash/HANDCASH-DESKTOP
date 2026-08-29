import { describe, expect, it } from 'vitest'
import { errorText, flattenJsonError } from './errorText'

describe('errorText', () => {
  it('uses Error.message', () => {
    expect(errorText(new Error('ITEM_ORIGIN_UNPROVEN'))).toBe('ITEM_ORIGIN_UNPROVEN')
  })

  it('returns a string as-is', () => {
    expect(errorText('amt-mismatch')).toBe('amt-mismatch')
  })

  it('picks the first string among description, error, message, code, reason', () => {
    expect(
      errorText({ code: 'ITEM_ORIGIN_UNPROVEN', description: 'amt-mismatch' }),
    ).toBe('amt-mismatch')
    expect(errorText({ code: 'ITEM_ORIGIN_UNPROVEN' })).toBe('ITEM_ORIGIN_UNPROVEN')
    expect(errorText({ reason: 'seller receipt missing' })).toBe('seller receipt missing')
  })

  it('unwraps a nested error/description object once', () => {
    expect(
      errorText({
        code: 'MARKET_LISTING_REFUSED',
        description: { code: 'ITEM_ORIGIN_UNPROVEN', description: 'amt-mismatch' },
      }),
    ).toBe('amt-mismatch')
    expect(
      errorText({
        error: { code: 'ITEM_ORIGIN_UNPROVEN', message: 'origin not proven' },
      }),
    ).toBe('origin not proven')
  })

  it('JSON.stringifies as a last resort instead of [object Object]', () => {
    expect(errorText({ foo: 1 })).toBe('{"foo":1}')
    expect(errorText({})).toBe('{}')
    expect(errorText({ foo: 1 })).not.toBe('[object Object]')
  })
})

describe('flattenJsonError', () => {
  it('keeps description a string when MarketListingError is {code, description: object}', () => {
    const flat = flattenJsonError({
      code: 'ITEM_ORIGIN_UNPROVEN',
      description: { code: 'ITEM_ORIGIN_UNPROVEN', description: 'amt-mismatch' },
    })
    expect(flat.code).toBe('ITEM_ORIGIN_UNPROVEN')
    expect(flat.description).toBe('amt-mismatch')
    expect(typeof flat.description).toBe('string')
    expect(flat.description).not.toBe('[object Object]')
  })

  it('uses Error.message and enumerable code', () => {
    const error = Object.assign(new Error('Wallet refused the listing proof.'), {
      code: 'ITEM_ORIGIN_UNPROVEN',
    })
    expect(flattenJsonError(error)).toEqual({
      code: 'ITEM_ORIGIN_UNPROVEN',
      description: 'Wallet refused the listing proof.',
    })
  })
})
