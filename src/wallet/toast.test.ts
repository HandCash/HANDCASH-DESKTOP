import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  dismissToast,
  getToasts,
  showToast,
  subscribeToasts,
  toastError,
  toastSuccess,
} from './toast'

describe('toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const toast of getToasts()) dismissToast(toast.id)
  })

  it('lets a newer toast override the one on screen', () => {
    toastSuccess('Item received', 'Verifying authenticity…')
    toastSuccess('Item verified', 'Authenticity proven on chain')

    expect(getToasts().map((t) => t.title)).toEqual(['Item verified'])
  })

  it('does not bring an older toast back when the newer one expires', () => {
    toastSuccess('Item received', 'Verifying authenticity…')
    const latest = toastSuccess('Item verified', 'Authenticity proven on chain')

    vi.advanceTimersByTime(60_000)

    expect(getToasts()).toEqual([])
    expect(getToasts().some((t) => t.id === latest)).toBe(false)
  })

  it('reports each arrival to subscribers as it lands', () => {
    const seen: string[] = []
    const stop = subscribeToasts((items) => {
      seen.push(items.map((t) => t.title).join(',') || '(none)')
    })

    toastError('Send failed', 'Miner rejected the transaction')
    showToast({ title: 'Copied', durationMs: 0 })
    stop()

    expect(seen).toEqual(['(none)', 'Send failed', 'Copied'])
  })
})
