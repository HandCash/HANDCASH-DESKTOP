import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Clipboard } from './index.js'

function CopyCode({ value }: { value: string }) {
  return (
    <Clipboard.Root value={value}>
      <Clipboard.Trigger aria-label="Copy code">
        <Clipboard.Indicator copied="done">copy</Clipboard.Indicator>
      </Clipboard.Trigger>
    </Clipboard.Root>
  )
}

describe('Clipboard', () => {
  it('copies the current value, swaps the indicator and announces it', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const { rerender } = render(<CopyCode value="first" />)
    rerender(<CopyCode value="pnpm build" />)

    await user.click(screen.getByRole('button', { name: 'Copy code' }))

    expect(writeText).toHaveBeenCalledWith('pnpm build')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy code' })).toHaveAttribute('data-aeon-state', 'copied'))
    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveTextContent('done')
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('reports a refused write as failed', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    render(<CopyCode value="x" />)

    await user.click(screen.getByRole('button', { name: 'Copy code' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copy failed'))
    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveTextContent('copy')
  })
})
