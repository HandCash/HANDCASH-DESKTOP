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
    const visible = VIEWPORT / ROW + 2
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

  it('keeps rows of different heights where they are drawn while scrolling down', async () => {
    const heightOf = (n: number) => (n % 3 === 0 ? 120 : 40)
    const offsetOf = (n: number) => Array.from({ length: n }, (_, i) => heightOf(i)).reduce((a, b) => a + b, 0)
    function Mixed() {
      const ref = useRef<HTMLUListElement>(null)
      const w = useWindowedRange({ total: 3_000, itemExtent: ROW, overscan: 2, scrollRef: ref })
      return (
        <ul ref={ref} style={{ overflowY: 'auto' }} data-testid="mixed">
          {w.padStart > 0 ? <li {...listWindowPadAttrs('start')} style={{ height: w.padStart }} /> : null}
          {Array.from({ length: w.end - w.start }, (_, i) => w.start + i).map((n) => (
            <li key={n} data-row={n} style={{ height: heightOf(n) }} />
          ))}
          {w.padEnd > 0 ? <li {...listWindowPadAttrs('end')} style={{ height: w.padEnd }} /> : null}
        </ul>
      )
    }
    const box = (top: number, height: number) =>
      ({ top, left: 0, width: 300, height, bottom: top + height, right: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'UL') return box(0, VIEWPORT)
      const parent = this.parentElement!
      let top = -parent.scrollTop
      for (const sibling of Array.from(parent.children)) {
        if (sibling === this) break
        top += Number.parseFloat((sibling as HTMLElement).style.height) || 0
      }
      return box(top, Number.parseFloat(this.style.height) || 0)
    })
    const { getByTestId } = render(<Mixed />)
    const list = getByTestId('mixed')
    let previous = 0
    for (let past = 0; past <= 30_000; past += 230) {
      await act(async () => {
        list.scrollTop = past
        list.dispatchEvent(new Event('scroll'))
        for (let tick = 0; tick < 3; tick++) await new Promise((r) => setTimeout(r, 0))
      })
      const rows = [...list.querySelectorAll<HTMLElement>('[data-row]')]
      const first = Number(rows[0]!.dataset.row)
      expect(first).toBeGreaterThanOrEqual(previous)
      for (const row of rows) {
        expect(row.getBoundingClientRect().top + past).toBe(offsetOf(Number(row.dataset.row)))
      }
      const lastRow = rows[rows.length - 1]!
      expect(lastRow.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(VIEWPORT)
      previous = first
    }
  })

  it('keeps rows a fling skipped where they were while the scroll goes on', async () => {
    const heightOf = (n: number) => (n % 3 === 0 ? 120 : 40)
    function Mixed() {
      const ref = useRef<HTMLUListElement>(null)
      const w = useWindowedRange({ total: 3_000, itemExtent: ROW, overscan: 2, scrollRef: ref })
      return (
        <ul ref={ref} style={{ overflowY: 'auto' }} data-testid="mixed">
          {w.padStart > 0 ? <li {...listWindowPadAttrs('start')} style={{ height: w.padStart }} /> : null}
          {Array.from({ length: w.end - w.start }, (_, i) => w.start + i).map((n) => (
            <li key={n} data-row={n} style={{ height: heightOf(n) }} />
          ))}
          {w.padEnd > 0 ? <li {...listWindowPadAttrs('end')} style={{ height: w.padEnd }} /> : null}
        </ul>
      )
    }
    const box = (top: number, height: number) =>
      ({ top, left: 0, width: 300, height, bottom: top + height, right: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'UL') return box(0, VIEWPORT)
      const parent = this.parentElement!
      let top = -parent.scrollTop
      for (const sibling of Array.from(parent.children)) {
        if (sibling === this) break
        top += Number.parseFloat((sibling as HTMLElement).style.height) || 0
      }
      return box(top, Number.parseFloat(this.style.height) || 0)
    })
    const { getByTestId } = render(<Mixed />)
    const list = getByTestId('mixed')
    const seenAt = new Map<number, number>()
    for (const past of [20_000, ...Array.from({ length: 30 }, (_, i) => 20_000 + (i + 1) * 230)]) {
      await act(async () => {
        list.scrollTop = past
        list.dispatchEvent(new Event('scroll'))
        for (let tick = 0; tick < 3; tick++) await new Promise((r) => setTimeout(r, 0))
      })
      for (const row of list.querySelectorAll<HTMLElement>('[data-row]')) {
        const at = row.getBoundingClientRect().top + past
        const n = Number(row.dataset.row)
        if (seenAt.has(n)) expect(at).toBe(seenAt.get(n))
        else seenAt.set(n, at)
      }
    }
    expect(seenAt.size).toBeGreaterThan(50)
  })

  it('keeps its window while hidden and re-windows when shown, without a scroll', async () => {
    let resized: (() => void) | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    const { getByTestId, rerender } = render(<List total={10_000} />)
    const list = getByTestId('list')
    await act(async () => {
      list.scrollTop = ROW * 5_000
      list.dispatchEvent(new Event('scroll'))
      await new Promise((r) => setTimeout(r, 0))
    })
    // Hidden: no layout box, so no height and no scroll offset.
    let viewport = 0
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => viewport })
    list.scrollTop = 0
    rerender(<List total={10_001} />)
    // Shown again: the offset comes back with the box, and nothing scrolls.
    viewport = VIEWPORT
    list.scrollTop = ROW * 5_000
    await act(async () => {
      resized?.()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(list.querySelector('li:not([data-aeon-window-pad])')!.textContent).toBe('Row 4998')
    expect(mountedRows(list)).toBe(VIEWPORT / ROW + 4)
    vi.unstubAllGlobals()
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

  it('windows a padded vertical grid under a scrolled header without looping', async () => {
    const HEADER = 120
    const COLS = 3
    const TOTAL = 600
    const TOTAL_ROWS = Math.ceil(TOTAL / COLS)
    let renders = 0

    function PaddedGrid() {
      renders += 1
      const ref = useRef<HTMLUListElement>(null)
      const w = useWindowedRange({
        total: TOTAL,
        itemExtent: ROW,
        columns: COLS,
        overscan: 2,
        scrollRef: ref,
      })
      const padStyle =
        w.padStart > 0 || w.padEnd > 0 ? { paddingTop: w.padStart, paddingBottom: w.padEnd } : undefined
      return (
        <div style={{ overflowY: 'auto' }} data-testid="scroller">
          <div style={{ height: HEADER }} />
          <ul ref={ref} style={padStyle} data-testid="padded-grid">
            {Array.from({ length: w.end - w.start }, (_, i) => w.start + i).map((n) => (
              <li key={n} data-item={n} style={{ height: ROW }}>
                Item {n}
              </li>
            ))}
          </ul>
        </div>
      )
    }

    const box = (top: number, height: number) =>
      ({ top, left: 0, width: 300, height, bottom: top + height, right: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'scroller') return box(0, VIEWPORT)
      if (this.dataset.testid === 'padded-grid') {
        const scroller = this.parentElement!
        return box(HEADER - scroller.scrollTop, TOTAL_ROWS * ROW)
      }
      const list = this.parentElement!
      const scroller = list.parentElement!
      const padTop = Number.parseFloat(list.style.paddingTop) || 0
      const indexInWindow = Array.from(list.children).indexOf(this)
      const rowInWindow = Math.floor(Math.max(0, indexInWindow) / COLS)
      return box(HEADER - scroller.scrollTop + padTop + rowInWindow * ROW, ROW)
    })

    const { getByTestId } = render(<PaddedGrid />)
    const scroller = getByTestId('scroller')
    const list = getByTestId('padded-grid')

    for (const scrollTop of [HEADER + ROW * 20, HEADER + ROW * 90, 0]) {
      const before = renders
      await act(async () => {
        scroller.scrollTop = scrollTop
        scroller.dispatchEvent(new Event('scroll'))
        for (let tick = 0; tick < 3; tick++) await new Promise((r) => setTimeout(r, 0))
      })
      expect(renders - before).toBeLessThan(10)
    }

    await act(async () => {
      scroller.scrollTop = HEADER + ROW * 40
      scroller.dispatchEvent(new Event('scroll'))
      for (let tick = 0; tick < 3; tick++) await new Promise((r) => setTimeout(r, 0))
    })
    const first = list.querySelector<HTMLElement>('li')!
    expect(Number(first.dataset.item)).toBe(38 * COLS)
    const padTop = Number.parseFloat(list.style.paddingTop) || 0
    const padBottom = Number.parseFloat(list.style.paddingBottom) || 0
    const mountedRowCount = Math.ceil(list.querySelectorAll('li').length / COLS)
    expect(padTop + mountedRowCount * ROW + padBottom).toBe(TOTAL_ROWS * ROW)
  })

  it('windows a horizontal strip using paddingInlineStart without looping', async () => {
    const ITEM = 80
    const TOTAL = 1_000
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
    let renders = 0

    function PaddedStrip() {
      renders += 1
      const ref = useRef<HTMLUListElement>(null)
      const w = useWindowedRange({ total: TOTAL, itemExtent: ITEM, overscan: 1, axis: 'x', scrollRef: ref })
      const padStyle =
        w.padStart > 0 || w.padEnd > 0
          ? { paddingInlineStart: w.padStart, paddingInlineEnd: w.padEnd }
          : undefined
      return (
        <ul ref={ref} style={{ overflowX: 'auto', ...padStyle }} data-testid="padded-strip">
          {Array.from({ length: w.end - w.start }, (_, i) => w.start + i).map((n) => (
            <li key={n} data-chip={n} style={{ width: ITEM }}>
              Chip {n}
            </li>
          ))}
        </ul>
      )
    }

    const box = (left: number, width: number) =>
      ({ top: 0, left, width, height: 100, bottom: 100, right: left + width, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'padded-strip') return box(0, 400)
      const list = this.parentElement!
      const padStart = Number.parseFloat(list.style.paddingInlineStart) || Number.parseFloat(list.style.paddingLeft) || 0
      const indexInWindow = Array.from(list.children).indexOf(this)
      return box(-list.scrollLeft + padStart + Math.max(0, indexInWindow) * ITEM, ITEM)
    })

    const { getByTestId } = render(<PaddedStrip />)
    const strip = getByTestId('padded-strip')
    const before = renders
    await act(async () => {
      strip.scrollLeft = ITEM * 500
      strip.dispatchEvent(new Event('scroll'))
      for (let tick = 0; tick < 3; tick++) await new Promise((r) => setTimeout(r, 0))
    })
    expect(renders - before).toBeLessThan(10)
    expect(strip.querySelector('li')!.textContent).toBe('Chip 499')
    const padStart = Number.parseFloat(strip.style.paddingInlineStart) || 0
    const padEnd = Number.parseFloat(strip.style.paddingInlineEnd) || 0
    expect(padStart + strip.querySelectorAll('li').length * ITEM + padEnd).toBe(TOTAL * ITEM)
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  })

  it('keeps spacer-mode scroll margin exact when the list also has base CSS padding', async () => {
    const HEADER = 100
    const BASE_PAD = 16
    function PaddedSpacerList() {
      const ref = useRef<HTMLUListElement>(null)
      const w = useWindowedRange({ total: 1_000, itemExtent: ROW, overscan: 2, scrollRef: ref })
      return (
        <div style={{ overflowY: 'auto' }} data-testid="spacer-scroller">
          <div style={{ height: HEADER }} />
          <ul ref={ref} style={{ paddingTop: BASE_PAD }} data-testid="spacer-list">
            {w.padStart > 0 ? <li {...listWindowPadAttrs('start')} style={{ height: w.padStart }} /> : null}
            {Array.from({ length: w.end - w.start }, (_, i) => w.start + i).map((n) => (
              <li key={n} data-row={n} style={{ height: ROW }}>
                Row {n}
              </li>
            ))}
            {w.padEnd > 0 ? <li {...listWindowPadAttrs('end')} style={{ height: w.padEnd }} /> : null}
          </ul>
        </div>
      )
    }

    const box = (top: number, height: number) =>
      ({ top, left: 0, width: 300, height, bottom: top + height, right: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'spacer-scroller') return box(0, VIEWPORT)
      if (this.dataset.testid === 'spacer-list') {
        const scroller = this.parentElement!
        return box(HEADER - scroller.scrollTop, BASE_PAD + 1_000 * ROW)
      }
      const list = this.parentElement!
      const scroller = list.parentElement!
      let top = HEADER - scroller.scrollTop + BASE_PAD
      for (const sibling of Array.from(list.children)) {
        if (sibling === this) break
        top += Number.parseFloat((sibling as HTMLElement).style.height) || 0
      }
      return box(top, Number.parseFloat(this.style.height) || 0)
    })

    const { getByTestId } = render(<PaddedSpacerList />)
    const scroller = getByTestId('spacer-scroller')
    const list = getByTestId('spacer-list')
    const past = HEADER + BASE_PAD + ROW * 200
    await act(async () => {
      scroller.scrollTop = past
      scroller.dispatchEvent(new Event('scroll'))
      for (let tick = 0; tick < 3; tick++) await new Promise((r) => setTimeout(r, 0))
    })
    const first = list.querySelector<HTMLElement>('[data-row]')!
    expect(Number(first.dataset.row)).toBe(198)
    expect(first.getBoundingClientRect().top + past).toBe(HEADER + BASE_PAD + 198 * ROW)
  })
})
