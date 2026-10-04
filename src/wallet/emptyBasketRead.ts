/**
 * An empty basket read beside held cards.
 *
 * A quiet, complete read is the basket's truth and retires every card it
 * omits. An empty one is also exactly what a storage that has not opened yet
 * answers, and trusting it once blanked the whole list and overwrote the saved
 * copy. So an empty read keeps the cards and asks again; a second empty read
 * at least {@link EMPTY_READ_CONFIRM_MS} later retires them. Any read that
 * lists something ends the wait.
 */

export const EMPTY_READ_CONFIRM_MS = 30_000

export type EmptyReadVerdict =
  /** The read listed something, or nothing was held: judge it as usual. */
  | { kind: 'listed' }
  | { kind: 'wait'; since: number; confirmInMs: number }
  | { kind: 'confirmed'; since: number }

export function judgeEmptyRead(args: {
  listed: number
  held: number
  emptySince: number | null
  now: number
}): EmptyReadVerdict {
  if (args.listed > 0 || args.held === 0) return { kind: 'listed' }
  const since = args.emptySince ?? args.now
  const waited = args.now - since
  if (waited < EMPTY_READ_CONFIRM_MS) {
    return { kind: 'wait', since, confirmInMs: EMPTY_READ_CONFIRM_MS - waited }
  }
  return { kind: 'confirmed', since }
}

export type EmptyReadGate = {
  /** Judge one complete read; schedules `relist` to confirm a wait. */
  judge(listed: number, held: number, now?: number): EmptyReadVerdict
  /** Forget a pending wait — the account changed. */
  reset(): void
}

export function createEmptyReadGate(relist: () => void): EmptyReadGate {
  let since: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const reset = () => {
    since = null
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    judge(listed, held, now = Date.now()) {
      const verdict = judgeEmptyRead({ listed, held, emptySince: since, now })
      if (verdict.kind !== 'wait') {
        reset()
        return verdict
      }
      since = verdict.since
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          relist()
        }, verdict.confirmInMs)
      }
      return verdict
    },
    reset,
  }
}
