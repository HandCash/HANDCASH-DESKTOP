import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from './index.js'

function Sections({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
  return (
    <Tabs.Root aria-label="Wallet" value={value} onValueChange={onValueChange}>
      <Tabs.List>
        <Tabs.Trigger value="coins">Coins</Tabs.Trigger>
        <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="coins">Coin list</Tabs.Content>
      <Tabs.Content value="activity">Activity list</Tabs.Content>
    </Tabs.Root>
  )
}

describe('Tabs', () => {
  it('controlled: reports a click through onValueChange and shows only the value it is given', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Sections value="coins" onValueChange={onValueChange} />)

    await user.click(screen.getByRole('tab', { name: 'Activity' }))

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('activity')
    expect(screen.getByRole('tab', { name: 'Coins' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Coin list')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Coins' }))
    expect(onValueChange).toHaveBeenCalledOnce()
  })

  it('controlled: switches when the parent takes the reported value', async () => {
    const user = userEvent.setup()
    function Parent() {
      const [value, setValue] = useState('coins')
      return <Sections value={value} onValueChange={setValue} />
    }
    render(<Parent />)

    await user.click(screen.getByRole('tab', { name: 'Activity' }))

    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Activity list')).toBeInTheDocument()
    expect(screen.queryByText('Coin list')).not.toBeInTheDocument()
  })

  it('uncontrolled: selects on click and reports the new value', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <Tabs.Root defaultValue="coins" onValueChange={onValueChange}>
        <Tabs.List>
          <Tabs.Trigger value="coins">Coins</Tabs.Trigger>
          <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>,
    )

    await user.click(screen.getByRole('tab', { name: 'Activity' }))

    expect(onValueChange).toHaveBeenLastCalledWith('activity')
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
  })
})
