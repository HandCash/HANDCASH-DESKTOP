import { describe, expect, it, vi, beforeEach } from 'vitest'

const toastSuccess = vi.fn()
vi.mock('./toast', () => ({
  toastSuccess: (...args: unknown[]) => toastSuccess(...args),
}))

const noteAwaitingVerification = vi.fn()
const clearAwaitingVerification = vi.fn()
vi.mock('./verificationProgress', () => ({
  noteAwaitingVerification: (...args: unknown[]) => noteAwaitingVerification(...args),
  clearAwaitingVerification: (...args: unknown[]) => clearAwaitingVerification(...args),
}))

vi.mock('./provenCache', () => ({
  isItemProven: vi.fn(() => false),
}))

describe('itemArrivalToast', () => {
  beforeEach(() => {
    toastSuccess.mockReset()
    noteAwaitingVerification.mockReset()
    clearAwaitingVerification.mockReset()
    vi.resetModules()
  })

  it('toasts receive once with spinner, then verify once', async () => {
    const { announceItemsReceived, announceItemVerified } = await import(
      './itemArrivalToast'
    )
    const op = `${'a'.repeat(64)}.0`

    announceItemsReceived([op])
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0]![0]).toBe('Item received')
    expect(String(toastSuccess.mock.calls[0]![1])).toMatch(/Verifying/i)
    expect(noteAwaitingVerification).toHaveBeenCalled()

    announceItemsReceived([op])
    expect(toastSuccess).toHaveBeenCalledTimes(1)

    announceItemVerified(op, 'BRC-150 lineage proven')
    expect(toastSuccess).toHaveBeenCalledTimes(2)
    expect(toastSuccess.mock.calls[1]![0]).toBe('Item verified')
    expect(clearAwaitingVerification).toHaveBeenCalled()

    announceItemVerified(op, 'again')
    expect(toastSuccess).toHaveBeenCalledTimes(2)
  })

  it('defers verify toast until after receive when proven during classify', async () => {
    const { isItemProven } = await import('./provenCache')
    const { announceItemVerified, announceItemsReceived } = await import(
      './itemArrivalToast'
    )
    const op = `${'b'.repeat(64)}.0`

    announceItemVerified(op, 'BRC-156 covenant verified')
    expect(toastSuccess).not.toHaveBeenCalled()

    vi.mocked(isItemProven).mockReturnValue(true)
    announceItemsReceived([op])
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0]![0]).toBe('Item received')
    expect(String(toastSuccess.mock.calls[0]![1])).toMatch(/verified/i)
  })
})
