import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from './index.js'

function mockPrefersHover(matches: boolean) {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(),
    })
  }
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('hover: hover') ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList)
}

describe('Tooltip', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on hover when the device supports hover', async () => {
    mockPrefersHover(true)
    const user = userEvent.setup()

    render(
      <Tooltip.Root openDelay={0}>
        <Tooltip.Trigger>Anchor</Tooltip.Trigger>
        <Tooltip.Positioner portalled={false}>
          <Tooltip.Content>Hint</Tooltip.Content>
        </Tooltip.Positioner>
      </Tooltip.Root>,
    )

    await user.hover(screen.getByText('Anchor'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Hint')
  })

  it('toggles on tap when hover is unavailable', async () => {
    mockPrefersHover(false)
    const user = userEvent.setup()

    render(
      <Tooltip.Root>
        <Tooltip.Trigger>Anchor</Tooltip.Trigger>
        <Tooltip.Positioner portalled={false}>
          <Tooltip.Content>Hint</Tooltip.Content>
        </Tooltip.Positioner>
      </Tooltip.Root>,
    )

    const trigger = screen.getByText('Anchor')
    await user.click(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hint')

    await user.click(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('stays open for touchDurationMs on touch devices', () => {
    vi.useFakeTimers()
    mockPrefersHover(false)

    render(
      <Tooltip.Root touchDurationMs={5000}>
        <Tooltip.Trigger>Anchor</Tooltip.Trigger>
        <Tooltip.Positioner portalled={false}>
          <Tooltip.Content>Hint</Tooltip.Content>
        </Tooltip.Positioner>
      </Tooltip.Root>,
    )

    fireEvent.click(screen.getByText('Anchor'))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes on outside tap when hover is unavailable', async () => {
    mockPrefersHover(false)
    const user = userEvent.setup()

    render(
      <div>
        <Tooltip.Root touchOutsideGraceMs={0}>
          <Tooltip.Trigger>Anchor</Tooltip.Trigger>
          <Tooltip.Positioner portalled={false}>
            <Tooltip.Content>Hint</Tooltip.Content>
          </Tooltip.Positioner>
        </Tooltip.Root>
        <button type="button">Elsewhere</button>
      </div>,
    )

    await user.click(screen.getByText('Anchor'))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
