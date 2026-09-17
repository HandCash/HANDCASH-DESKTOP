import { describe, expect, it } from 'vitest'
import { scrollRootScrolledPast } from './scrollRoot'

describe('scrollRootScrolledPast', () => {
  it('uses scrollTop when the list is its own scroll root', () => {
    const list = { scrollTop: 864 } as HTMLElement
    expect(scrollRootScrolledPast(list, list)).toBe(864)
  })
})
