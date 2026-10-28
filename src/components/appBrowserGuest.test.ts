import { afterEach, describe, expect, it, vi } from 'vitest'
import { coversGuest } from './appBrowserGuest'

function box(parked = false): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    closest: (selector: string) =>
      parked && selector.includes('data-parked') ? ({} as Element) : null,
  } as unknown as HTMLElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('coversGuest', () => {
  it('leaves the page up when every probe lands inside the panel', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const host = box()
    const panel = { contains: () => true } as unknown as HTMLElement
    expect(coversGuest(host, panel, () => ({ closest: () => null }) as Element)).toBe(false)
  })

  it('covers the page when a prompt sits over a probe point', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const host = box()
    const panel = { contains: () => false } as unknown as HTMLElement
    expect(coversGuest(host, panel, () => ({ closest: () => null }) as Element)).toBe(true)
  })

  it('lets a toast sit over the page', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const host = box()
    const panel = { contains: () => false } as unknown as HTMLElement
    const toast = { closest: (selector: string) => (selector.includes('aria-live') ? toast : null) }
    expect(coversGuest(host, panel, () => toast as unknown as Element)).toBe(false)
  })

  it('covers a parked tab so the guest cannot take clicks', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })
    expect(
      coversGuest(box(true), { contains: () => true } as unknown as HTMLElement, () => null),
    ).toBe(true)
  })
})
