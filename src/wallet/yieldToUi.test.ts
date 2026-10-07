import { afterEach, describe, expect, it, vi } from 'vitest'
import { yieldToUi } from './yieldToUi'

describe('yieldToUi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('yields through the scheduler while the page is on screen', async () => {
    const schedYield = vi.fn(async () => {})
    vi.stubGlobal('scheduler', { yield: schedYield })
    vi.stubGlobal('document', { visibilityState: 'visible' })
    await yieldToUi()
    expect(schedYield).toHaveBeenCalledTimes(1)
  })

  it('never hands a hidden page to the budget-throttled scheduler', async () => {
    const schedYield = vi.fn(() => new Promise<void>(() => {}))
    vi.stubGlobal('scheduler', { yield: schedYield })
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    await yieldToUi()
    expect(schedYield).not.toHaveBeenCalled()
  })
})
