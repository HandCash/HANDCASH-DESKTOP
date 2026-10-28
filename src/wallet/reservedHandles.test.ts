import { describe, expect, it } from 'vitest'
import list from './reservedHandles.json'
import {
  handleSkeleton,
  isReservedHandle,
  parseReservedHandleList,
  reservedHandleMatches,
  RESERVED_HANDLES,
  RESERVED_HANDLES_VERSION,
} from './reservedHandles'

describe('reservedHandles', () => {
  it('ships version 1 with the carried-over cloud rules and the added names', () => {
    expect(RESERVED_HANDLES_VERSION).toBe(1)
    expect(list.patterns).toHaveLength(5)
    expect(list.names.length).toBeGreaterThanOrEqual(300)
    expect(RESERVED_HANDLES.rules.filter((r) => r.category === 'carried-over')).toHaveLength(5)
    for (const id of ['guest-prefix', 'business-wallet-prefix', 'versioned-alias-prefix']) {
      expect(RESERVED_HANDLES.rules.some((r) => r.id === id)).toBe(true)
    }
  })

  it('carries over guest0, bw0 and vvNN prefixes from handcash-cloud', () => {
    expect(isReservedHandle('guest0alice')).toBe(true)
    expect(isReservedHandle('guest-0alice')).toBe(true)
    expect(isReservedHandle('bw0corp')).toBe(true)
    expect(isReservedHandle('vv12wallet')).toBe(true)
    expect(isReservedHandle('guest1alice')).toBe(false)
  })

  it('reserves brand, HandCash and system names, including look-alikes and affixes', () => {
    expect(reservedHandleMatches('apple')[0]?.rule.id).toBe('apple')
    expect(reservedHandleMatches('App1e')[0]?.via).toBe('lookalike')
    expect(reservedHandleMatches('g00gle')[0]?.rule.id).toBe('google')
    expect(reservedHandleMatches('gooogle')[0]?.rule.id).toBe('google')
    expect(reservedHandleMatches('аpple')[0]?.rule.id).toBe('apple')
    expect(reservedHandleMatches('rnicrosoft')[0]?.rule.id).toBe('microsoft')
    expect(reservedHandleMatches('apple_official')[0]).toMatchObject({ rule: { id: 'apple' }, via: 'affix' })
    expect(reservedHandleMatches('realelonmusk')[0]?.rule.id).toBe('elonmusk')
    expect(reservedHandleMatches('handcash.support')[0]?.rule.id).toBe('handcash')
    expect(isReservedHandle('admin')).toBe(true)
    expect(isReservedHandle('adm1n')).toBe(true)
    expect(isReservedHandle('s.u.p.p.o.r.t')).toBe(true)
    expect(isReservedHandle('wallet')).toBe(true)
    expect(isReservedHandle('official')).toBe(true)
    expect(isReservedHandle('help')).toBe(true)
  })

  it('leaves ordinary names free and does not fold channel into chanel', () => {
    expect(isReservedHandle('alice')).toBe(false)
    expect(isReservedHandle('wanted')).toBe(false)
    expect(isReservedHandle('channel')).toBe(false)
    expect(isReservedHandle('tall')).toBe(false)
    expect(handleSkeleton('gooogle')).toBe('google')
    expect(handleSkeleton('channel')).toBe('channel')
  })

  it('honours an entry-level owner on the list', () => {
    const custom = parseReservedHandleList({
      version: 1,
      affixes: [],
      patterns: [],
      names: [{ name: 'vip', category: 'brand', reason: 'test', owner: '02' + 'ab'.repeat(32) }],
    })
    expect(reservedHandleMatches('vip', custom)[0]?.rule.owner).toBe('02' + 'ab'.repeat(32))
  })
})
