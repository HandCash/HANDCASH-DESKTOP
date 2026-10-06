/**
 * Name the wallet steps that currently own the main thread.
 *
 * A freeze report names the layer (`active: chainIngest`), but a layer runs for
 * minutes while the freeze is one step inside it — so the log says "something in
 * chain ingest" and the search starts from scratch every time. Marking phases
 * makes the next uploaded log name the step instead.
 *
 * Chain maintenance runs several steps concurrently, so this is a multiset of
 * what is in flight, not a stack: "innermost" has no meaning when five tasks
 * share the thread.
 *
 * Diagnostics only. It must never gate behaviour, and it stays dependency-free
 * so any layer can mark a phase without an import cycle.
 */

const active = new Map<string, number>()

/** Every step in flight right now, e.g. `heal-ghost+restore-spendable`. */
export function describeUiPhase(): string {
  if (active.size === 0) return ''
  return [...active.keys()].sort().join('+')
}

/** Mark a step as in flight. Returns the leave function; call it exactly once. */
export function beginUiPhase(name: string): () => void {
  active.set(name, (active.get(name) ?? 0) + 1)
  let left = false
  return () => {
    if (left) return
    left = true
    const n = (active.get(name) ?? 1) - 1
    if (n > 0) active.set(name, n)
    else active.delete(name)
  }
}

/** Phases shorter than this cannot own a freeze; logging them is noise. */
const TIMED_PHASE_MS = 250

const now = (): number =>
  typeof performance?.now === 'function' ? performance.now() : Date.now()

/**
 * Run `fn` inside a named phase. A phase that ran {@link TIMED_PHASE_MS} or
 * longer logs `[ui-phase] <name> done <N>ms`, which triage turns into a
 * workload span — so a freeze inside it has an owner without anyone reading.
 */
export async function inUiPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const leave = beginUiPhase(name)
  const startedAt = now()
  try {
    return await fn()
  } finally {
    leave()
    const ms = Math.round(now() - startedAt)
    if (ms >= TIMED_PHASE_MS) console.info(`[ui-phase] ${name} done ${ms}ms`)
  }
}

export function __resetUiPhasesForTests(): void {
  active.clear()
}
