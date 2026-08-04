import { describe, expect, it } from 'vitest'
import { shouldPullRemoteHistory } from './deviceSync'

describe('shouldPullRemoteHistory', () => {
  it('refuses pull when remote age is unknown', () => {
    expect(shouldPullRemoteHistory(null, 100)).toBe(false)
    expect(shouldPullRemoteHistory(0, null)).toBe(false)
  })

  it('allows pull on first link when remote has a timestamp', () => {
    expect(shouldPullRemoteHistory(1_700_000_000_000, null)).toBe(true)
  })

  it('never pulls when remote is older or equal', () => {
    expect(shouldPullRemoteHistory(100, 200)).toBe(false)
    expect(shouldPullRemoteHistory(200, 200)).toBe(false)
  })

  it('pulls only when remote is strictly newer', () => {
    expect(shouldPullRemoteHistory(300, 200)).toBe(true)
  })
})
