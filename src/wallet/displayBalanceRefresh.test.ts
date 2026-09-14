import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISPLAY_BALANCE_REFRESH_EVENT,
  publishDisplayBalanceRefresh,
} from './displayBalanceRefresh'

describe('displayBalanceRefresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dispatches a balance event on document', () => {
    const handler = vi.fn()
    vi.stubGlobal('document', {
      dispatchEvent: (event: Event) => {
        handler(event)
        return true
      },
    })
    publishDisplayBalanceRefresh(12345, 'ik-child')
    expect(handler).toHaveBeenCalledTimes(1)
    const event = handler.mock.calls[0]![0] as CustomEvent<{
      balanceSats: number
      identityKey: string | null
    }>
    expect(event.detail.balanceSats).toBe(12345)
    expect(event.detail.identityKey).toBe('ik-child')
    expect(event.type).toBe(DISPLAY_BALANCE_REFRESH_EVENT)
  })

  it('ignores invalid amounts', () => {
    const handler = vi.fn()
    vi.stubGlobal('document', {
      dispatchEvent: (event: Event) => {
        handler(event)
        return true
      },
    })
    publishDisplayBalanceRefresh(-1)
    publishDisplayBalanceRefresh(NaN)
    expect(handler).not.toHaveBeenCalled()
  })
})
