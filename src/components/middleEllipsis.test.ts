import { describe, expect, it } from 'vitest'
import { middleEllipsisParts } from './middleEllipsis'

describe('middleEllipsisParts', () => {
  it('keeps a trailing #number whole', () => {
    expect(middleEllipsisParts('Pixel Foxes #9999992')).toEqual(['Pixel Foxes ', '#9999992'])
    expect(middleEllipsisParts('Pixel Foxes #7')).toEqual(['Pixel Foxes ', '#7'])
  })

  it('keeps a trailing number after a space', () => {
    expect(middleEllipsisParts('Bubblemint Genesis 042')).toEqual(['Bubblemint Genesis', ' 042'])
  })

  it('falls back to the last characters when the number is too long or absent', () => {
    expect(middleEllipsisParts('Pixel Foxes #12345678901')).toEqual(['Pixel Foxes #12345', '678901'])
    expect(middleEllipsisParts('Bubblemint Genesis Pass')).toEqual(['Bubblemint Genesi', 's Pass'])
  })

  it('leaves short labels alone', () => {
    expect(middleEllipsisParts('Fox')).toEqual(['Fox', ''])
    expect(middleEllipsisParts('#12')).toEqual(['#12', ''])
  })
})
