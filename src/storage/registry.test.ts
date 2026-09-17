import { describe, expect, it } from 'vitest'
import { migrateEnvelope, storageRegistry } from './registry'

describe('storage registry', () => {
  it('has one owner and one key per registered store', () => {
    const entries = Object.values(storageRegistry)
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length)
    expect(entries.every((entry) => entry.version > 0)).toBe(true)
  })

  it('runs migrations in order', () => {
    const result = migrateEnvelope(
      { v: 0, data: ['old'] },
      2,
      [
        { from: 0, to: 1, migrate: (data) => ({ rows: data }) },
        {
          from: 1,
          to: 2,
          migrate: (data) => ({ ...(data as object), stable: true }),
        },
      ],
      (data) => data as { rows: string[]; stable: boolean },
    )
    expect(result).toEqual({ v: 2, data: { rows: ['old'], stable: true } })
  })

  it('refuses migration gaps and newer unknown data', () => {
    expect(() => migrateEnvelope({ v: 0, data: null }, 1, [], () => null)).toThrow(
      'Missing storage migration',
    )
    expect(() => migrateEnvelope({ v: 2, data: null }, 1, [], () => null)).toThrow(
      'is newer',
    )
  })
})
