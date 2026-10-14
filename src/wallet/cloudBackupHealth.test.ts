import { describe, expect, it } from 'vitest'
import { backupCatchupState } from './cloudBackupHealth'

describe('backupCatchupState', () => {
  it('schedules catch-up only when local history is richer', () => {
    expect(backupCatchupState(12, 9)).toBe('behind')
    expect(backupCatchupState(12, 12)).toBe('current')
    expect(backupCatchupState(12, 13)).toBe('remote-newer')
  })

  it('does not guess when an old host has no action metadata', () => {
    expect(backupCatchupState(12, null)).toBe('unknown')
    expect(backupCatchupState(null, 12)).toBe('unknown')
  })
})
