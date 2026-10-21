import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SegmentGroup } from './index.js'

function Modes(props: ComponentProps<typeof SegmentGroup.Root>) {
  return (
    <SegmentGroup.Root aria-label="Mode" {...props}>
      <SegmentGroup.Item value="agent">Agent</SegmentGroup.Item>
      <SegmentGroup.Item value="plan" disabled>
        Plan
      </SegmentGroup.Item>
      <SegmentGroup.Item value="ask">Ask</SegmentGroup.Item>
    </SegmentGroup.Root>
  )
}

describe('SegmentGroup', () => {
  it('selects on click and reports the new value', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Modes defaultValue="agent" onValueChange={onValueChange} />)

    await user.click(screen.getByRole('radio', { name: 'Ask' }))

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('ask')
    expect(screen.getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Ask' })).toHaveAttribute('data-aeon-state', 'selected')
    expect(screen.getByRole('radio', { name: 'Agent' })).toHaveAttribute('tabindex', '-1')
  })

  it('arrow keys move selection and skip disabled items', async () => {
    const user = userEvent.setup()
    render(<Modes defaultValue="agent" />)

    await user.click(screen.getByRole('radio', { name: 'Agent' }))
    await user.keyboard('{ArrowRight}')

    const ask = screen.getByRole('radio', { name: 'Ask' })
    expect(ask).toHaveFocus()
    expect(ask).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Agent' })).toHaveFocus()
  })

  it('Home and End jump to the first and last enabled items', async () => {
    const user = userEvent.setup()
    render(<Modes defaultValue="ask" />)

    await user.click(screen.getByRole('radio', { name: 'Ask' }))
    await user.keyboard('{Home}')
    expect(screen.getByRole('radio', { name: 'Agent' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('radio', { name: 'Ask' })).toHaveFocus()
  })

  it('Tab lands on exactly one item: the selected one, else the first enabled', () => {
    const tabbable = () =>
      screen.getAllByRole('radio').filter((item) => item.getAttribute('tabindex') === '0').map((item) => item.textContent)

    const { unmount } = render(<Modes defaultValue="ask" />)
    expect(tabbable()).toEqual(['Ask'])
    unmount()

    const second = render(<Modes />)
    expect(tabbable()).toEqual(['Agent'])
    second.unmount()

    render(<Modes defaultValue="plan" />)
    expect(tabbable()).toEqual(['Agent'])
  })

  it('reports its orientation and forwards refs', () => {
    let root: HTMLDivElement | null = null
    render(
      <Modes
        orientation="vertical"
        ref={(el) => {
          root = el
        }}
      />,
    )

    expect(root).toBe(screen.getByRole('radiogroup'))
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('stays on the controlled value until the owner changes it', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { rerender } = render(<Modes value="agent" onValueChange={onValueChange} />)

    await user.click(screen.getByRole('radio', { name: 'Ask' }))
    expect(onValueChange).toHaveBeenCalledWith('ask')
    expect(screen.getByRole('radio', { name: 'Agent' })).toHaveAttribute('aria-checked', 'true')

    rerender(<Modes value="ask" onValueChange={onValueChange} />)
    expect(screen.getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true')
  })

  it('ignores input when the whole group is disabled', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Modes defaultValue="agent" disabled onValueChange={onValueChange} />)

    await user.click(screen.getByRole('radio', { name: 'Ask' }))
    expect(onValueChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radiogroup')).toHaveAttribute('data-disabled')
  })
})
