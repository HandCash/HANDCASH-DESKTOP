import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Avatar } from './index.js'

describe('Avatar', () => {
  it('shows fallback until image loads', () => {
    render(
      <Avatar.Root>
        <Avatar.Image src="/photo.jpg" alt="User" />
        <Avatar.Fallback>AB</Avatar.Fallback>
      </Avatar.Root>,
    )

    expect(screen.getByText('AB')).toBeVisible()
    expect(document.querySelector('[data-aeon-part="image"]')).toHaveAttribute('hidden')
  })

  it('shows fallback when there is no src', () => {
    render(
      <Avatar.Root>
        <Avatar.Fallback>?</Avatar.Fallback>
      </Avatar.Root>,
    )

    expect(screen.getByText('?')).toBeVisible()
  })
})
