import { describe, expect, it, vi } from 'vitest'

import { createFallbackChainTracker } from './chainTrackerFallback'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

const wocOk = vi.fn(async () => true)
const wocHeight = vi.fn(async () => 961_050)

vi.mock('@bsv/sdk', () => ({
  WhatsOnChain: class {
    isValidRootForHeight = wocOk
    currentHeight = wocHeight
  },
}))

describe('createFallbackChainTracker', () => {
  it('falls back to WhatsOnChain when the primary host errors', async () => {
    // The real outage: mainnet-chaintracks answers 500 with "At least one bulk
    // ingestor must implement getPresentHeight", which surfaces to the user as
    // "valid AtomicBEEF" and blocks every incoming item.
    const primary = {
      isValidRootForHeight: vi.fn(async () => {
        throw new Error('ERR_INTERNAL: At least one bulk ingestor must implement getPresentHeight.')
      }),
      currentHeight: vi.fn(async () => {
        throw new Error('ERR_INTERNAL')
      }),
    }
    const tracker = createFallbackChainTracker('main', primary)

    expect(await tracker.isValidRootForHeight('root', 961_047)).toBe(true)
    expect(await tracker.currentHeight()).toBe(961_050)
  })

  it('prefers the primary while it answers', async () => {
    const primary = {
      isValidRootForHeight: vi.fn(async () => false),
      currentHeight: vi.fn(async () => 900),
    }
    const tracker = createFallbackChainTracker('main', primary)

    // A primary "false" is a real answer and must not be second-guessed.
    expect(await tracker.isValidRootForHeight('root', 1)).toBe(false)
    expect(primary.isValidRootForHeight).toHaveBeenCalledTimes(1)
  })

  it('works with no primary at all', async () => {
    const tracker = createFallbackChainTracker('main', null)
    expect(await tracker.isValidRootForHeight('root', 1)).toBe(true)
  })
})
