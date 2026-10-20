export type SearchKeyAction = 'clear' | 'leave' | null

/** Escape empties a filled field first, and only an empty one gives up focus. */
export function searchKeyAction(key: string, value: string): SearchKeyAction {
  if (key !== 'Escape') return null
  return value ? 'clear' : 'leave'
}
