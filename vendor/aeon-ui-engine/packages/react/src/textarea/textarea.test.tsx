import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Textarea } from './index.js'

describe('Textarea', () => {
  it('hands row limits to CSS and keeps consumer styles', () => {
    render(<Textarea.Root aria-label="Message" minRows={1} maxRows={8} style={{ color: 'red' }} />)
    const input = screen.getByRole('textbox', { name: 'Message' })

    expect(input).toHaveAttribute('rows', '1')
    expect(input).toHaveAttribute('data-aeon-scope', 'textarea')
    expect(input.style.getPropertyValue('--aeon-textarea-min-rows')).toBe('1')
    expect(input.style.getPropertyValue('--aeon-textarea-max-rows')).toBe('8')
    expect(input.style.color).toBe('red')
  })

  it('leaves the ceiling unset when maxRows is omitted', () => {
    render(<Textarea.Root aria-label="Notes" />)
    const input = screen.getByRole('textbox', { name: 'Notes' })

    expect(input.style.getPropertyValue('--aeon-textarea-min-rows')).toBe('2')
    expect(input.style.getPropertyValue('--aeon-textarea-max-rows')).toBe('')
  })

  it('forwards refs to the textarea', () => {
    let node: HTMLTextAreaElement | null = null
    render(
      <Textarea.Root
        aria-label="Draft"
        ref={(el) => {
          node = el
        }}
      />,
    )

    expect(node).toBe(screen.getByRole('textbox', { name: 'Draft' }))
  })
})
