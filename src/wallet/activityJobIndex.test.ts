import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => void store.set(key, value),
}))

import {
  isItemMigrateTxDescription,
  itemMigrateTxDescription,
  jobOfTxid,
  noteJobTxids,
  resetActivityJobIndexForTests,
} from './activityJobIndex'

const tx = (n: number) => n.toString(16).padStart(64, '0')

beforeEach(() => {
  store.clear()
  resetActivityJobIndexForTests()
})

describe('activityJobIndex', () => {
  it('remembers which job wrote a transaction across a reload', () => {
    noteJobTxids('job:item-import:a', [tx(1), tx(2).toUpperCase(), 'not-a-txid'])
    resetActivityJobIndexForTests()
    expect(jobOfTxid(tx(1))).toBe('job:item-import:a')
    expect(jobOfTxid(tx(2))).toBe('job:item-import:a')
    expect(jobOfTxid(tx(3))).toBeNull()
  })

  it('keeps the newest transactions when it is full', () => {
    noteJobTxids('job:item-import:old', Array.from({ length: 600 }, (_, i) => tx(i + 1)))
    noteJobTxids('job:item-import:new', [tx(1_000)])
    expect(jobOfTxid(tx(1))).toBeNull()
    expect(jobOfTxid(tx(2))).toBe('job:item-import:old')
    expect(jobOfTxid(tx(1_000))).toBe('job:item-import:new')
  })

  it('recognises every migrate description it writes, and nothing else', () => {
    expect(isItemMigrateTxDescription(itemMigrateTxDescription(1, `${tx(1)}.0`))).toBe(true)
    expect(isItemMigrateTxDescription(itemMigrateTxDescription(25, `${tx(1)}.0`))).toBe(true)
    expect(isItemMigrateTxDescription('Import 1Sat ordinal')).toBe(false)
    expect(isItemMigrateTxDescription('Migrate everything')).toBe(false)
    expect(isItemMigrateTxDescription(undefined)).toBe(false)
  })
})
