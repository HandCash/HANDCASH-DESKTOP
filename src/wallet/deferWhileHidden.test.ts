import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferWhileHidden } from './deferWhileHidden'

function fakeDocument(state: 'hidden' | 'visible') {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: state as 'hidden' | 'visible',
    addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
    show() {
      doc.visibilityState = 'visible'
      for (const fn of [...listeners]) fn()
    },
    listeners,
  }
  vi.stubGlobal('document', doc)
  return doc
}

describe('deferWhileHidden', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs now when visible', () => {
    fakeDocument('visible')
    const task = vi.fn()
    expect(deferWhileHidden('k-visible', task)).toBe(false)
    expect(task).not.toHaveBeenCalled()
  })

  it('coalesces hidden calls into one run on return', () => {
    const doc = fakeDocument('hidden')
    const task = vi.fn()
    expect(deferWhileHidden('k-hidden', task)).toBe(true)
    expect(deferWhileHidden('k-hidden', task)).toBe(true)
    expect(deferWhileHidden('k-hidden', task)).toBe(true)
    expect(task).not.toHaveBeenCalled()
    doc.show()
    expect(task).toHaveBeenCalledOnce()
    expect(doc.listeners.size).toBe(0)
  })
})
