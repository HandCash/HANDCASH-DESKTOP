import { describe, expect, it, vi, beforeEach } from 'vitest'

const toastSuccess = vi.fn()
vi.mock('./toast', () => ({
  toastSuccess: (...args: unknown[]) => toastSuccess(...args),
}))

vi.mock('./provenCache', () => ({
  isItemProven: vi.fn(() => false),
}))

describe('itemArrivalToast', () => {
  beforeEach(() => {
    toastSuccess.mockReset()
    vi.resetModules()
  })

  it('toasts receive once, then verify once for the same tip', async () => {
    const { announceItemsReceived, announceItemVerified } = await import(
      './itemArrivalToast'
    )
    const op = `${'a'.repeat(64)}.0`

    announceItemsReceived([op])
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0]![0]).toBe('Item received')
    expect(String(toastSuccess.mock.calls[0]![1])).toMatch(/Verifying/i)

    announceItemsReceived([op])
    expect(toastSuccess).toHaveBeenCalledTimes(1)

    announceItemVerified(op, 'BRC-150 lineage proven')
    expect(toastSuccess).toHaveBeenCalledTimes(2)
    expect(toastSuccess.mock.calls[1]![0]).toBe('Item verified')

    announceItemVerified(op, 'again')
    expect(toastSuccess).toHaveBeenCalledTimes(2)
  })

  it('skips verify toast when the tip was already proven at receive', async () => {
    const { isItemProven } = await import('./provenCache')
    vi.mocked(isItemProven).mockReturnValue(true)
    const { announceItemsReceived, announceItemVerified } = await import(
      './itemArrivalToast'
    )
    const op = `${'b'.repeat(64)}.0`

    announceItemsReceived([op])
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(String(toastSuccess.mock.calls[0]![1])).toMatch(/verified/i)

    announceItemVerified(op, 'BRC-150 lineage proven')
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })
})
