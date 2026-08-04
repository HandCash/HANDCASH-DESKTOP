import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Toast, useToast } from './index.js'

function PublishButton() {
  const { publish } = useToast()
  return (
    <button
      type="button"
      onClick={() =>
        publish({
          title: 'Saved',
          description: 'Your preferences were updated.',
          durationMs: 4000,
        })
      }
    >
      Show toast
    </button>
  )
}

describe('Toast', () => {
  it('shows a published toast in the viewport', async () => {
    const user = userEvent.setup()

    render(
      <Toast.Provider>
        <PublishButton />
        <Toast.Viewport />
      </Toast.Provider>,
    )

    await user.click(screen.getByRole('button', { name: 'Show toast' }))

    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    expect(screen.getByRole('status')).toHaveTextContent('Your preferences were updated.')
  })
})
