import { describe, expect, it } from 'vitest'
import { exclusiveActionWidget, EXCLUSIVE_ACTION_STATES } from './exclusive-action.js'
import { uncoveredStates, widgetStates } from './totality.js'
import { host } from './widget.js'

const project = (state: string) =>
  exclusiveActionWidget({
    scope: 'example',
    part: 'form',
    state,
    busy: state === 'busy' || state === 'confirming',
    error: state === 'failure' ? 'nope' : null,
    body: host('body'),
    idleLabel: 'Save',
    pendingLabel: 'Saving…',
    onSubmit: () => {},
    confirm: state === 'confirming',
  })

describe('exclusiveActionWidget', () => {
  it('covers every state of the chart', () => {
    expect(uncoveredStates(EXCLUSIVE_ACTION_STATES, project)).toEqual([])
  })

  it('shows the failure copy only on failure', () => {
    expect(widgetStates(project('idle'))).not.toContain('failure')
    const failure = project('failure')
    const error = failure.type === 'el' && failure.children.find((c) => c.type === 'el' && c.part === 'error')
    expect(error && error.type === 'el' && error.children[0]).toEqual({ type: 'text', text: 'nope' })
  })

  it('mounts the confirm host only while confirming', () => {
    const confirming = project('confirming')
    const idle = project('idle')
    const hasConfirm = (tree: ReturnType<typeof project>) =>
      tree.type === 'el' && tree.children.some((c) => c.type === 'host' && c.id === 'confirm')
    expect(hasConfirm(confirming)).toBe(true)
    expect(hasConfirm(idle)).toBe(false)
  })

  it('labels the primary from busy, and refuses a second click', () => {
    const busy = project('busy')
    const primary =
      busy.type === 'el'
        ? busy.children
            .flatMap((c) => (c.type === 'el' ? c.children : []))
            .find((c) => c.type === 'el' && c.part === 'primary')
        : undefined
    expect(primary && primary.type === 'el' && primary.disabled).toBe(true)
    expect(primary && primary.type === 'el' && primary.children).toEqual([
      { type: 'text', text: 'Saving…' },
    ])
  })
})
