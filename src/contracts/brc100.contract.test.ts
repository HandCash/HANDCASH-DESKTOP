import { describe, expect, it } from 'vitest'
import {
  ACTION_BRC100_METHODS,
  MIGRATION_BRC100_METHODS,
  NO_COALESCE_BRC100_ACTIONS,
  brc100Contract,
} from './brc100'

describe('frozen BRC-100 contract', () => {
  it('classifies every declared action and migration method', () => {
    for (const method of ACTION_BRC100_METHODS) {
      expect(brc100Contract.isActionMethod(method)).toBe(true)
    }
    for (const method of MIGRATION_BRC100_METHODS) {
      expect(brc100Contract.isMigrationMethod(method)).toBe(true)
    }
  })

  it('keeps signature and market mutations distinct', () => {
    for (const method of NO_COALESCE_BRC100_ACTIONS) {
      expect(brc100Contract.actionMayCoalesce(method)).toBe(false)
    }
    expect(brc100Contract.actionMayCoalesce('encrypt')).toBe(true)
  })

  it('does not make unknown methods public by default', () => {
    expect(brc100Contract.isPublicMethod('futureMethod')).toBe(false)
    expect(brc100Contract.isActionMethod('futureMethod')).toBe(false)
    expect(brc100Contract.isMigrationMethod('futureMethod')).toBe(false)
  })
})
