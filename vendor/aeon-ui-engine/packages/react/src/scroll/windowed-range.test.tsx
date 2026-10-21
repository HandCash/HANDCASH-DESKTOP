import { act, render } from '@testing-library/react'
import { listWindowPadAttrs } from '@aeon-ui/core'
import { memo, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWindowedRange } from './use-windowed-range.js'

const ROW = 40
const VIEWPORT = 400
let rowRenders = 0

const Row = memo(function Row({ n }: { n: number }) {
  rowRenders += 1
  return (
    <li data-aeon-state={n % 2 ? 'odd' : 'even'} style={{ height: ROW }}>
      Row {n}
    </li>
  )
})

function List({ total, minItems }: { total: number; minItems?: number }) {
  const ref = useRef<HTMLUListElement>(null)
  const w = useWindowedRange({ total, itemExtent: ROW, overscan: 2, minItems, scrollRef: ref })
  const items = Array.from({ length: w.end - w.start }, (_, i) => w.start + i)
  return (
    <ul ref={ref} style={{ overflowY: 'auto' }} data-testid="list">
      {w.padStart > 0 ? <li {...listWindowPadAttrs('start')} style={{ height: w.padStart }} /> : null}
      {items.map((n) => (
        <Row key={n} n={n} />
      ))}
      {w.padEnd > 0 ? <li {...listWindowPadAttrs('end')} style={{ height: w.padEnd }} /> : null}
    </ul>
  )
}

const mountedRows = (el: HTMLElement) => el.querySelectorAll('li:not([data-aeon-window-pad])').length

beforeEach(() => {
  rowRenders = 0
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEWPORT })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => setTimeout(() => cb(0), 0) as unknown as number)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => clearTimeout(id))
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

describe('useWindowedRange', () => {
  it('mounts only the visible rows of a long list, never the whole list first', () => {
    const { getByTestId } = render(<List total={10_000} />)
    const visible = VIEWPORT / ROW + 2 * 2
    expect(mountedRows(getByTestId('list'))).toBe(visible)
    expect(rowRenders).toBeLessThan(10_000 / 100)
  })

  it('mounts a short list whole, with no spacers', () => {
    const { getByTestId } = render(<List total={20} />)
    expect(mountedRows(getByTestId('list'))).toBe(20)
    expect(getByTestId('list').querySelector('[data-aeon-window-pad]')).toBeNull()
  })

  it('moves the window on scroll and keeps the full scroll height', async () => {
    const { getByTestId } = render(<List total={10_000} />)
    const list = getByTestId('list')
    await act(async () => {
      list.scrollTop = ROW * 5_000
      list.dispatchEvent(new Event('scroll'))
      await new Promise((r) => setTimeout(r, 0))
    })
    const first = list.querySelector('li:not([data-aeon-window-pad])')!
    expect(first.textContent).toBe('Row 4998')
    expect(first.getAttribute('data-aeon-state')).toBe('even')
    const pads = [...list.querySelectorAll<HTMLElement>('[data-aeon-window-pad]')]
    const padded = pads.reduce((sum, el) => sum + Number.parseFloat(el.style.height), 0)
    expect(padded + mountedRows(list) * ROW).toBe(10_000 * ROW)
  })

  it('renders nothing for a scroll that stays inside the window', async () => {
    const { getByTestId } = render(<List total={10_000} />)
    const list = getByTestId('list')
    rowRenders = 0
    await act(async () => {
      list.scrollTop = 10
      list.dispatchEvent(new Event('scroll'))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(rowRenders).toBe(0)
  })

  it('windows a horizontal strip by scrollLeft', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
    function Strip() {
      const ref = useRef<HTMLUListElement>(null)
      const w = useWindowedRange({ total: 1_000, itemExtent: 80, overscan: 1, axis: 'x', scrollRef: ref })
      return (
        <ul ref={ref} style={{ overflowX: 'auto' }} data-testid="strip">
          {Array.from({ length: w.end - w.start }, (_, i) => (
            <li key={w.start + i}>Chip {w.start + i}</li>
          ))}
        </ul>
      )
    }
    const { getByTestId } = render(<Strip />)
    const strip = getByTestId('strip')
    await act(async () => {
      strip.scrollLeft = 80 * 500
      strip.dispatchEvent(new Event('scroll'))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(strip.querySelectorAll('li')).toHaveLength(400 / 80 + 2)
    expect(strip.querySelector('li')!.textContent).toBe('Chip 499')
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  })
})
