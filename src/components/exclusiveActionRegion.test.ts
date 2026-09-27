import { describe, expect, it } from 'vitest'
import {
  EXCLUSIVE_ACTION_STATES,
  exclusiveActionWidget,
  host,
  uncoveredStates,
} from '@aeon-ui/tree'

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

describe('exclusive action widget', () => {
  it('has a face for every state of the chart', () => {
    expect(uncoveredStates(EXCLUSIVE_ACTION_STATES, project)).toEqual([])
  })
})
