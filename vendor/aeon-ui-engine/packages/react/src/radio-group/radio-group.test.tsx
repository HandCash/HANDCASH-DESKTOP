import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RadioGroup } from './index.js'

describe('RadioGroup', () => {
  it('takes aria-label and other div attributes on the root', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <RadioGroup.Root aria-label="Network fee" id="fee" defaultValue="normal" onValueChange={onValueChange}>
        {['normal', 'fast'].map((value) => (
          <RadioGroup.Item key={value} value={value}>
            <RadioGroup.ItemControl aria-label={value} />
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>,
    )

    const group = screen.getByRole('radiogroup', { name: 'Network fee' })
    expect(group).toHaveAttribute('id', 'fee')

    await user.click(screen.getByRole('radio', { name: 'fast' }))
    expect(onValueChange).toHaveBeenLastCalledWith('fast')
    expect(screen.getByRole('radio', { name: 'fast' })).toHaveAttribute('aria-checked', 'true')
  })
})
