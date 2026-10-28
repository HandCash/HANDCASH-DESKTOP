import { describe, expect, it } from 'vitest'
import { recordingNotice } from './recordingNotice'

describe('recording notice', () => {
  it('names everyone recording, this side first', () => {
    expect(recordingNotice(false, [])).toBeNull()
    expect(recordingNotice(true, [])).toBe('You’re recording this call')
    expect(recordingNotice(false, ['Bob'])).toBe('Bob is recording this call')
    expect(recordingNotice(true, ['Bob'])).toBe('You and Bob are recording this call')
    expect(recordingNotice(false, ['Bob', 'Carol', 'Dave'])).toBe('Bob, Carol and Dave are recording this call')
  })
})
