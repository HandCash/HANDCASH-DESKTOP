/**
 * Main-thread side of the compute port.
 *
 * One worker serves every request and is let go after a quiet spell, so a
 * screen that paints a hundred received items spawns it once. A worker that
 * cannot start or dies hands its requests to the same ops in process: slower
 * frames, never a missing result.
 */
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
    appendAppLog('warn', `[compute] worker unavailable (${message}) — computing inline`)
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
        const message = err instanceof Error ? err.message : String(err)
        fail(message)
        reject(new WorkerFailed(message))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        settleIdle()
        reject(new Error(`compute ${op} timed out`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer })
      settleIdle()
      target.postMessage({ id, op, input } as ComputeRequest)
    })

  return {
    async run(op, input) {
      if (usable) {
        try {
          return await post(op, input)
        } catch (err) {
          if (!(err instanceof WorkerFailed)) throw err
        }
      }
      return runComputeOp(op, input)
    },
  }
}

let port: ComputePort | null = null

export function getComputePort(): ComputePort {
  port ??= typeof Worker === 'undefined' ? inProcessComputePort : createWorkerComputePort()
  return port
}

export function setComputePortForTests(next: ComputePort | null): void {
  port = next
}

/** A chart invokes an op like any promise actor: `actors: { art: computeActor('itemArtFromProvenance') }`. */
export function computeActor<K extends ComputeOp>(op: K) {
  return fromPromise<ComputeOutput<K>, ComputeInput<K>>(({ input }) => getComputePort().run(op, input))
}
