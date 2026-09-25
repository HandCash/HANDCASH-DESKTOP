import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetUiPhasesForTests,
  beginUiPhase,
  describeUiPhase,
  inUiPhase,
} from './uiPhase'

describe('ui phase reporting', () => {
  beforeEach(() => {
    __resetUiPhasesForTests()
  })

  it('is empty when the wallet is doing nothing named', () => {
    expect(describeUiPhase()).toBe('')
  })

  it('names every step in flight, since maintenance runs them concurrently', async () => {
    const leaveA = beginUiPhase('restore-spendable')
    const leaveB = beginUiPhase('heal-ghost-sent')
    expect(describeUiPhase()).toBe('heal-ghost-sent+restore-spendable')
    leaveB()
    expect(describeUiPhase()).toBe('restore-spendable')
    leaveA()
    expect(describeUiPhase()).toBe('')
  })

  it('keeps a phase named while another pass of it is still running', () => {
    const first = beginUiPhase('reclaim-sealed')
    const second = beginUiPhase('reclaim-sealed')
    first()
    expect(describeUiPhase()).toBe('reclaim-sealed')
    second()
    expect(describeUiPhase()).toBe('')
  })

  it('leaves the phase when the step throws', async () => {
    await expect(
      inUiPhase('legacy-ingest', async () => {
        throw new Error('ingest failed')
      }),
    ).rejects.toThrow('ingest failed')
    expect(describeUiPhase()).toBe('')
  })

  it('ignores a leave called twice', () => {
    const leave = beginUiPhase('brc150-verify')
    leave()
    leave()
    expect(describeUiPhase()).toBe('')
  })
})
