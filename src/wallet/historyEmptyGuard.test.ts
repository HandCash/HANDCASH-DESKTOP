import { describe, expect, it } from 'vitest'
import {
  allowEmptyLocalHistoryPull,
  decideEmptyHistoryOverwrite,
  MIN_REMOTE_BYTES_TO_PROTECT,
} from './historyEmptyGuard'

describe('decideEmptyHistoryOverwrite (isolated edge case)', () => {
  it('refuses empty local over a protected remote', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: 10_000,
      localLooksEmpty: true,
    })
    expect(d.refusePush).toBe(true)
    expect(d.reason).toMatch(/refuse empty/i)
  })

  it('allows push when local has history', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: 10_000,
      localLooksEmpty: false,
    })
    expect(d.refusePush).toBe(false)
  })

  it('allows first upload when remote is missing', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: false,
      remoteBytes: null,
      localLooksEmpty: true,
    })
    expect(d.refusePush).toBe(false)
  })

  it('treats tiny remote stubs as unprotected', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: MIN_REMOTE_BYTES_TO_PROTECT - 1,
      localLooksEmpty: true,
    })
    expect(d.refusePush).toBe(false)
  })

  it('allows forced manual overwrite', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: 10_000,
      localLooksEmpty: true,
      force: true,
    })
    expect(d.refusePush).toBe(false)
  })
})

describe('allowEmptyLocalHistoryPull', () => {
  it('allows recovery paths only', () => {
    expect(allowEmptyLocalHistoryPull('unlock')).toBe(true)
    expect(allowEmptyLocalHistoryPull('restore')).toBe(true)
    expect(allowEmptyLocalHistoryPull('recompose')).toBe(true)
    expect(allowEmptyLocalHistoryPull('createAction')).toBe(false)
    expect(allowEmptyLocalHistoryPull('send')).toBe(false)
  })
})
