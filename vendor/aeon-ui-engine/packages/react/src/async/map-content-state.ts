import type { ContentRegionState } from '@aeon-ui/primitives'

/** Map async machine leaf → Content face (product UI — not Track). */
export function asyncStatusToContentState(status: string): ContentRegionState {
  switch (status) {
    case 'loading':
      return 'pending'
    case 'empty':
      return 'empty'
    case 'failure':
      return 'error'
    case 'success':
      return 'success'
    case 'idle':
    default:
      return 'idle'
  }
}
