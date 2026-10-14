import { describe, expect, it } from 'vitest'
import {
  LEGACY_TOKEN_BASKET,
  P2PFT_BASKET,
  filingTags,
  isFilingTag,
  isTokenFilingBasket,
  isTokenPermissionScheme,
  mergeFilingRows,
  tokenIdFromFilingTags,
} from './filing'

const TOKEN = `${'ab'.repeat(32)}_0`

describe('P2P-FT filing', () => {
  it('writes new outputs under p2pft', () => {
    expect(filingTags(TOKEN)).toEqual([P2PFT_BASKET, `${P2PFT_BASKET}:${TOKEN}`])
    expect(P2PFT_BASKET).toBe('p2pft')
  })

  it('reads a token id from either filing tag', () => {
    expect(tokenIdFromFilingTags([`p2pft:${TOKEN}`])).toBe(TOKEN)
    expect(tokenIdFromFilingTags([LEGACY_TOKEN_BASKET, `bsv21:${TOKEN}`])).toBe(TOKEN)
    expect(tokenIdFromFilingTags(['amt:1'])).toBeNull()
  })

  it('treats both basket names as the token filing', () => {
    expect(isTokenFilingBasket('p2pft')).toBe(true)
    expect(isTokenFilingBasket('BSV21')).toBe(true)
    expect(isTokenFilingBasket('1sat')).toBe(false)
    expect(isFilingTag('p2pft')).toBe(true)
    expect(isFilingTag(`bsv21:${TOKEN}`)).toBe(true)
    expect(isFilingTag('amt:1')).toBe(false)
  })

  it('keeps the existing app permission schemes', () => {
    expect(isTokenPermissionScheme('bsv21')).toBe(true)
    expect(isTokenPermissionScheme('p2pft')).toBe(true)
    expect(isTokenPermissionScheme('1sat')).toBe(false)
  })

  it('counts an output once when it appears in both filings', () => {
    const rows = mergeFilingRows(
      [
        { outpoint: 'aa.0', basket: 'p2pft' },
        { outpoint: 'AA.0', basket: 'bsv21' },
        { outpoint: 'bb.1', basket: 'bsv21' },
      ],
      (row) => row.outpoint,
    )
    expect(rows).toEqual([
      { outpoint: 'aa.0', basket: 'p2pft' },
      { outpoint: 'bb.1', basket: 'bsv21' },
    ])
  })
})
