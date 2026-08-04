import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './index.js'

describe('Select', () => {
  it('opens listbox and selects an option', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()

    render(
      <Select.Root value="a" onValueChange={onValueChange}>
        <Select.Trigger>
          <Select.ValueText>Alpha</Select.ValueText>
        </Select.Trigger>
        <Select.Positioner portalled={false}>
          <Select.Content>
            <Select.Item value="a">Alpha</Select.Item>
            <Select.Item value="b">Beta</Select.Item>
          </Select.Content>
        </Select.Positioner>
      </Select.Root>,
    )

    const trigger = screen.getByRole('button', { name: /alpha/i })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    const beta = screen.getByRole('option', { name: 'Beta' })
    await user.click(beta)

    expect(onValueChange).toHaveBeenCalledWith('b')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('portals listbox when Content is used without Positioner', async () => {
    const user = userEvent.setup()

    render(
      <Select.Root value="a">
        <Select.Trigger>
          <Select.ValueText>Alpha</Select.ValueText>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="a">Alpha</Select.Item>
        </Select.Content>
      </Select.Root>,
    )

    const root = screen.getByRole('button').parentElement!
    await user.click(screen.getByRole('button'))

    const listbox = screen.getByRole('listbox')
    expect(root).not.toContainElement(listbox)
  })

  it('closes on escape', async () => {
    const user = userEvent.setup()

    render(
      <Select.Root value="a">
        <Select.Trigger>
          <Select.ValueText>Alpha</Select.ValueText>
        </Select.Trigger>
        <Select.Positioner portalled={false}>
          <Select.Content>
            <Select.Item value="a">Alpha</Select.Item>
          </Select.Content>
        </Select.Positioner>
      </Select.Root>,
    )

    await user.click(screen.getByRole('button'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
