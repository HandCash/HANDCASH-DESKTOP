import { describe, expect, it, vi, beforeEach } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
}))

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
  beforeEach(async () => {
    store.clear()
    toastSuccess.mockReset()
    noteAwaitingVerification.mockReset()
    clearAwaitingVerification.mockReset()
    vi.resetModules()
    const { resetItemArrivalAnnouncementsForTests } = await import('./itemArrivalToast')
    resetItemArrivalAnnouncementsForTests()
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

  it('opens a pending Activity receive row while the tip is unproven', async () => {
    const { isItemProven } = await import('./provenCache')
    vi.mocked(isItemProven).mockReturnValue(false)
    const { announceItemsReceived, announceItemVerified } = await import(
      './itemArrivalToast'
    )
    const { listRecentActivity } = await import('./appActivity')
    const txid = 'e'.repeat(64)
    const op = `${txid}.0`

    announceItemsReceived([op])
    const pending = listRecentActivity(20).find((r) => r.txid === txid)
    expect(pending?.status).toBe('pending')
    expect(pending?.item?.outpoint).toBe(op)

    announceItemVerified(op, 'BRC-150 lineage proven')
    const settled = listRecentActivity(20).find((r) => r.txid === txid)
    // Settled rows drop the status field entirely — only pending/failed persist.
    expect(settled).toBeDefined()
    expect(settled?.status).toBeUndefined()
  })

  it('does not re-toast receive across sessions for the same outpoint', async () => {
    const op = `${'c'.repeat(64)}.0`
    const first = await import('./itemArrivalToast')
    first.announceItemsReceived([op])
    expect(toastSuccess).toHaveBeenCalledTimes(1)

    vi.resetModules()
    toastSuccess.mockReset()
    const second = await import('./itemArrivalToast')
    second.announceItemsReceived([op])
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
