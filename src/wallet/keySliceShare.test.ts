import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shareKeySlice } from './keySliceShare'

const payload = {
  share: '1.deadbeef.2.1234abcd',
  index: 0,
  total: 3,
  integrity: '1234abcd',
}

describe('shareKeySlice', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('prefers the shell-native share surface', async () => {
    const shareText = vi.fn(async () => ({ ok: true as const }))
    window.handcash = { shareText } as unknown as HandCashBridge

    await expect(shareKeySlice(payload)).resolves.toBe('shared')
    expect(shareText).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'HandCash key slice 1 of 3',
        text: expect.stringContaining(payload.share),
      }),
    )
  })

  it('uses the Web Share API outside a native shell', async () => {
    const share = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })

    await expect(shareKeySlice(payload)).resolves.toBe('shared')
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: expect.any(String) }))
  })

  it('does not count a cancelled Web Share handoff', async () => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: vi.fn(async () => {
        throw new DOMException('cancelled', 'AbortError')
      }),
    })

    await expect(shareKeySlice(payload)).resolves.toBe('cancelled')
  })

  it('reports unavailable when no share surface exists', async () => {
    await expect(shareKeySlice(payload)).resolves.toBe('unavailable')
  })
})
