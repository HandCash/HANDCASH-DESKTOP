import { describe, expect, it } from 'vitest'
import { describeHistorySide, replaceFromCloudVerdict } from './historyReplaceGuard'

const local = (actionCount: number, spendableSats: number) => ({
  actionCount,
  spendableSats,
  defaultOutputCount: 0,
  looksEmpty: actionCount === 0,
})
const remote = (actionCount: number | null, spendableSats: number | null) => ({
  exists: true,
  exportedAt: 1,
  actionCount,
  spendableSats,
})

describe('replaceFromCloudVerdict', () => {
  it('refuses without a reachable cloud copy or a readable device', () => {
    expect(replaceFromCloudVerdict({ remote: null, local: local(1, 1) }).allowed).toBe(false)
    expect(
      replaceFromCloudVerdict({ remote: { ...remote(1, 1), exists: false }, local: local(1, 1) }).allowed,
    ).toBe(false)
    expect(replaceFromCloudVerdict({ remote: remote(1, 1), local: null }).allowed).toBe(false)
  })

  it('refuses when the cloud copy does not report its size', () => {
    expect(replaceFromCloudVerdict({ remote: remote(null, 5), local: local(0, 0) }).allowed).toBe(false)
    expect(replaceFromCloudVerdict({ remote: remote(5, null), local: local(0, 0) }).allowed).toBe(false)
  })

  it('refuses when this device holds actions or sats the cloud lacks', () => {
    const more = replaceFromCloudVerdict({ remote: remote(3, 100), local: local(5, 100) })
    expect(more).toEqual({ allowed: false, reason: expect.stringContaining('2 actions') })
    const richer = replaceFromCloudVerdict({ remote: remote(5, 100), local: local(5, 150) })
    expect(richer).toEqual({ allowed: false, reason: expect.stringContaining('50 more spendable sats') })
  })

  it('allows when the cloud copy is at least as rich', () => {
    expect(replaceFromCloudVerdict({ remote: remote(5, 100), local: local(5, 100) })).toEqual({ allowed: true })
    expect(replaceFromCloudVerdict({ remote: remote(9, 200), local: local(5, 100) })).toEqual({ allowed: true })
  })
})

describe('describeHistorySide', () => {
  it('names both counts and marks unknowns', () => {
    expect(describeHistorySide({ actionCount: 2, spendableSats: 1000 })).toBe('2 actions · 1,000 sats')
    expect(describeHistorySide({ actionCount: null, spendableSats: null })).toBe('? actions · unknown balance')
    expect(describeHistorySide(null)).toBe('Unknown')
  })
})
