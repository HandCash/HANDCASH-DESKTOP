import { appendAppLog } from '../appLog'

const STILL_EVERY_MS = 30_000

/**
 * Await one import step, logging `[import] still <stage> after <N>s` every
 * half minute until it settles. A step that never returns then names itself
 * in the next upload instead of leaving a silent gap after the last done line.
 */
export async function watchImportStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    appendAppLog('info', `[import] still ${stage} after ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }, STILL_EVERY_MS)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}
