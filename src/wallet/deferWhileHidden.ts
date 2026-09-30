const waiting = new Set<string>()

/**
 * While the document is hidden, run `task` once when it is next visible instead
 * of now. Repeat calls under the same key coalesce into that one run.
 *
 * @returns true when the task was deferred (or already waiting).
 */
export function deferWhileHidden(key: string, task: () => void): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return false
  }
  if (waiting.has(key)) return true
  waiting.add(key)
  const onVisible = () => {
    if (document.visibilityState === 'hidden') return
    document.removeEventListener('visibilitychange', onVisible)
    waiting.delete(key)
    task()
  }
  document.addEventListener('visibilitychange', onVisible)
  return true
}
