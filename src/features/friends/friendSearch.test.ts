import { describe, expect, it } from 'vitest'
import type { Friend } from '../../wallet/friends'
import { filterFriends, suggestFriends } from './friendSearch'

function friend(label: string, identityKey: string): Friend {
  return { id: label, label, identityKey, createdAt: 1 }
}

const alice = friend('Alice', '02aaa111')
const malia = friend('Malia', '03bbb222')
const bob = friend('Bob', '02ccc333')
const friends = [alice, malia, bob]

describe('filterFriends', () => {
  it('keeps everyone for an empty query', () => {
    expect(filterFriends(friends, '')).toEqual(friends)
  })

  it('matches name or wallet key, case-insensitively', () => {
    expect(filterFriends(friends, 'ALI')).toEqual([alice, malia])
    expect(filterFriends(friends, '02')).toEqual([alice, bob])
  })

  it('requires every comma-separated term to match', () => {
    expect(filterFriends(friends, 'ali, 02')).toEqual([alice])
    expect(filterFriends(friends, 'ali,zzz')).toEqual([])
  })
})

describe('suggestFriends', () => {
  it('offers nothing for a blank draft', () => {
    expect(suggestFriends(friends, '  ', [])).toEqual([])
  })

  it('puts names starting with the draft first, each with what would remain', () => {
    expect(suggestFriends([malia, alice, bob], 'ali', [])).toEqual([
      { term: 'Alice', label: 'Alice', kind: 'Friend', count: 1 },
      { term: 'Malia', label: 'Malia', kind: 'Friend', count: 1 },
    ])
  })

  it('matches names only, not wallet keys', () => {
    expect(suggestFriends(friends, '02', [])).toEqual([])
  })

  it('suggests only from friends the applied terms left', () => {
    expect(suggestFriends(friends, 'a', ['03']).map((s) => s.term)).toEqual(['Malia'])
  })

  it('offers at most six', () => {
    const many = Array.from({ length: 9 }, (_, i) => friend(`Ann ${i}`, `02${i}`))
    expect(suggestFriends(many, 'ann', [])).toHaveLength(6)
  })
})
