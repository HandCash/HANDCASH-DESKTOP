/**
 * One deadline over everything a token send awaits before `createAction`:
 * reservation cleanup, recipient resolve, tip bodies, ancestry fates. None of
 * it holds a reservation, so a stuck step fails the send by name and frees
 * the spend region instead of queueing every later send behind it.
 */
export const TOKEN_PRE_SIGN_DEADLINE_MS = 45_000

/** A step past this is logged, so triage can name where a slow send waited. */
const SLOW_STEP_MS = 250

export class TokenPreSignTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly elapsedMs: number,
  ) {
    super(`Token send stalled while ${step} — nothing was signed. Try again.`)
    this.name = 'TokenPreSignTimeoutError'
  }
}

export type PreSignDeadline = {
  step<T>(name: string, work: Promise<T> | (() => Promise<T>)): Promise<T>
}

export function startPreSignDeadline(
  tag: string,
  deadlineMs = TOKEN_PRE_SIGN_DEADLINE_MS,
): PreSignDeadline {
  const startedAt = Date.now()
  return {
    async step<T>(name: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
      const stepAt = Date.now()
      const left = startedAt + deadlineMs - stepAt
      const pending = typeof work === 'function' ? work() : work
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const elapsed = Date.now() - startedAt
              console.warn(`[${tag}] pre-sign timed out in ${name} after ${elapsed}ms`)
              reject(new TokenPreSignTimeoutError(name, elapsed))
            }, Math.max(0, left))
          }),
        ])
        const ms = Date.now() - stepAt
        if (ms >= SLOW_STEP_MS) console.info(`[${tag}] pre-sign ${name} done ${ms}ms`)
        return result
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}
