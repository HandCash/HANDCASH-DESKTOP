/**
 * Main-thread side of the compute port.
 *
 * One worker serves every request and is let go after a quiet spell, so a
 * screen that paints a hundred received items spawns it once. Worker failure
 * rejects the request: optional background decoding must never migrate onto
 * the UI thread and freeze input. Callers retain their last painted result.
 */
import { errorText } from '../errorText'
import { fromPromise } from 'xstate'
import type {
  ComputeInput,
  ComputeOp,
  ComputeOutput,
  ComputePort,
  ComputeReply,
  ComputeRequest,
} from '../../ports/computePort'
import { appendAppLog } from '../appLog'
import { runComputeOp } from './computeOps'

const IDLE_MS = 30_000
const TIMEOUT_MS = 30_000

export type ComputeWorker = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((event: MessageEvent<ComputeReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export const inProcessComputePort: ComputePort = {
  run: async (op, input) => runComputeOp(op, input),
}

function spawnComputeWorker(): ComputeWorker {
  return new Worker(new URL('./compute.worker.ts', import.meta.url), {
    type: 'module',
    name: 'handcash-compute',
  }) as ComputeWorker
}

type Pending = {
  resolve: (output: ComputeOutput<ComputeOp>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class WorkerFailed extends Error {}

export function createWorkerComputePort(
  spawn: () => ComputeWorker = spawnComputeWorker,
  opts: { idleMs?: number; timeoutMs?: number } = {},
): ComputePort {
  const idleMs = opts.idleMs ?? IDLE_MS
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  let worker: ComputeWorker | null = null
  let usable = true
  let nextId = 1
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const pending = new Map<number, Pending>()

  const release = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    worker?.terminate()
    worker = null
  }

  const settleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = pending.size === 0 ? setTimeout(release, idleMs) : null
  }

  const fail = (message: string) => {
    usable = false
    release()
    appendAppLog('warn', '[compute] worker unavailable — background decoding deferred')
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      pending.delete(id)
      p.reject(new WorkerFailed(message))
    }
  }

  const ensure = (): ComputeWorker => {
    if (worker) return worker
    const next = spawn()
    next.onmessage = (event) => {
      const reply = event.data
      const p = pending.get(reply.id)
      if (!p) return
      pending.delete(reply.id)
      clearTimeout(p.timer)
      settleIdle()
      if (reply.ok) p.resolve(reply.output)
      else p.reject(new Error(reply.error))
    }
    next.onerror = (event) => fail(event.message || 'worker error')
    worker = next
    return next
  }

  const post = <K extends ComputeOp>(op: K, input: ComputeInput<K>) =>
    new Promise<ComputeOutput<K>>((resolve, reject) => {
      let target: ComputeWorker
      try {
        target = ensure()
      } catch (err) {
        const message = errorText(err)
        fail(message)
        reject(new WorkerFailed(message))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        // A timed-out decode is still consuming CPU until its worker is stopped.
        fail(`compute ${op} timed out`)
      }, timeoutMs)
      pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer })
      settleIdle()
      try {
        target.postMessage({ id, op, input } as ComputeRequest)
      } catch {
        fail('request could not be posted')
      }
    })

  return {
    async run(op, input) {
      if (!usable) throw new WorkerFailed('Background compute unavailable')
      return post(op, input)
    },
  }
}

let port: ComputePort | null = null

export function getComputePort(): ComputePort {
  // Pure in-process execution is for non-UI hosts/tests, never a browser fallback.
  port ??= typeof window === 'undefined' && typeof Worker === 'undefined'
    ? inProcessComputePort
    : createWorkerComputePort()
  return port
}

export function setComputePortForTests(next: ComputePort | null): void {
  port = next
}

/** A chart invokes an op like any promise actor: `actors: { art: computeActor('itemArtFromProvenance') }`. */
export function computeActor<K extends ComputeOp>(op: K) {
  return fromPromise<ComputeOutput<K>, ComputeInput<K>>(({ input }) => getComputePort().run(op, input))
}
