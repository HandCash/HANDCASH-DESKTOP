import { describe, expect, it } from 'vitest'
import { splitPanelQuery } from './PanelFilter'

describe('splitPanelQuery', () => {
  it('hints only the term after the last comma', () => {
    expect(splitPanelQuery('fox, glas')).toEqual({ terms: ['fox'], draft: 'glas' })
  })

  it('has no draft right after a comma and drops empty terms', () => {
    expect(splitPanelQuery(' fox ,, hat,')).toEqual({ terms: ['fox', 'hat'], draft: '' })
  })

  it('treats a plain word as the draft', () => {
    expect(splitPanelQuery('fox')).toEqual({ terms: [], draft: 'fox' })
  })
})
