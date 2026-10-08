/**
 * React commit timings by surface, for the log ring.
 *
 * Long Animation Frames name the script that held the main thread, and on the
 * phone 82% of it was `performWorkUntilDeadline` — React's own work loop —
 * which says "rendering" and nothing about what rendered. Each `RenderProbe`
 * reports its subtree's commits here: one line per slow commit, and one per
 * surface that commits far more often than a person can see.
 */

/** A commit this long drops several frames on its own. */
export const SLOW_COMMIT_MS = 100
const STORM_WINDOW_MS = 10_000
/** Commits per window that only a feedback loop or a hot subscription produces. */
const STORM_COMMITS = 40
/** Render time per window that is lag even when no single commit is slow. */
const STORM_MS = 500

type Bucket = { since: number; commits: number; ms: number; worstMs: number }

const buckets = new Map<string, Bucket>()

export function recordRender(
  id: string,
  phase: string,
  actualMs: number,
  baseMs: number,
  now: number = Date.now(),
): void {
  if (actualMs >= SLOW_COMMIT_MS) {
    console.warn(`[render] ${id} ${phase} ${Math.round(actualMs)}ms base ${Math.round(baseMs)}ms`)
  }
  let bucket = buckets.get(id)
  if (!bucket || now - bucket.since >= STORM_WINDOW_MS) {
    if (bucket && (bucket.commits >= STORM_COMMITS || bucket.ms >= STORM_MS)) {
      const seconds = Math.max(1, Math.round((now - bucket.since) / 1000))
      console.warn(
        `[render] ${id} storm ${bucket.commits} commits ${Math.round(bucket.ms)}ms in ${seconds}s worst ${Math.round(bucket.worstMs)}ms`,
      )
    }
    bucket = { since: now, commits: 0, ms: 0, worstMs: 0 }
    buckets.set(id, bucket)
  }
  bucket.commits += 1
  bucket.ms += actualMs
  bucket.worstMs = Math.max(bucket.worstMs, actualMs)
}

export function resetRenderLogForTests(): void {
  buckets.clear()
}
