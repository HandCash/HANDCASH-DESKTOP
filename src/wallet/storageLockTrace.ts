/**
 * Name whoever holds the Toolbox storage lock.
 *
 * `WalletStorageManager` takes `readerLocks` first for every reader, writer,
 * sync and storage-provider call, so the whole toolbox is one FIFO. A send that
 * times out behind it, or a receive stuck on "Importing", only ever shows the
 * waiter — the holder logs nothing. This logs both sides:
 *
 * - `[storage-lock] <op> held <N>ms` when a hold passes {@link HOLD_LOG_MS}
 * - `[storage-lock] <op> waited <N>ms behind <holders>` when a wait does
 * - `[storage-lock] <op> still held <N>ms — <k> waiting` while a hold never ends
 * - `[monitor] <task> done <N>ms` for slow Monitor tasks, which take the same
 *   lock from a timer the app does not drive
 */

import { describeUiPhase } from './uiPhase'

const HOLD_LOG_MS = 1_000
const WAIT_LOG_MS = 2_000
const STUCK_FIRST_MS = 10_000
const STUCK_REPEAT_MS = 30_000
const SLOW_TASK_MS = 250
const RELEASES_KEPT = 32

const RUNNERS = ['runAsReader', 'runAsWriter', 'runAsSync', 'runAsStorageProvider'] as const
type Runner = (typeof RUNNERS)[number]

/** Lock plumbing and accessors that never take the lock themselves. */
const UNWRAPPED = new Set<string>([
  'constructor',
  ...RUNNERS,
  'getAuth',
  'getActiveLock',
  'releaseActiveLock',
  'getActiveForReader',
  'releaseActiveForReader',
  'getActiveForWriter',
  'releaseActiveForWriter',
  'getActiveForSync',
  'releaseActiveForSync',
  'getActiveForStorageProvider',
  'releaseActiveForStorageProvider',
  'getActive',
  'isAvailable',
  'verifyActive',
])

type LockedStorage = Record<string, unknown> & { readerLocks?: unknown[] }
type Release = { label: string; start: number; end: number }

/** Manager method whose synchronous prefix is running right now. */
let callingMethod: string | null = null
/** Label handed from a resolved `getAuth` to the `runAs*` right after it. */
let nextLockLabel: string | null = null
/** Monitor task currently running, for unlabeled direct `runAs*` calls. */
let monitorTask: string | null = null
let holder: { label: string; since: number } | null = null
const releases: Release[] = []
const traced = new WeakSet<object>()

/**
 * Module of the direct caller: frames 0–1 are `takeLabel` and `traceRunner`,
 * frame 2 whoever called `runAs*`. Dev serves `/src/wallet/x.ts`, builds emit
 * `x-<hash>.js`.
 */
export function callerModule(stack: string | undefined, depth = 2): string | null {
  const frames = (stack ?? '').split('\n').filter((line) => /\d:\d+\)?\s*$/.test(line))
  const frame = frames[depth]
  const file = frame?.match(/\/([\w.]+?)(?:-[\w-]{6,12})?\.(?:[cm]?js|tsx?)(?:\?[^:]*)?:\d+:\d+/)?.[1]
  return file ?? null
}

function takeLabel(runner: Runner): string {
  let label = callingMethod ?? nextLockLabel
  nextLockLabel = null
  if (label) return label
  if (monitorTask) return `monitor:${monitorTask}`
  const caller = callerModule(new Error().stack)
  label = caller ? `${runner}@${caller}` : runner
  // A production build folds most modules into `index`; the running wallet
  // step is the only name left for the holder.
  const phase = caller === 'index' || !caller ? describeUiPhase() : ''
  return phase ? `${label}(in ${phase})` : label
}

function holdersSince(queuedAt: number): string {
  const byLabel = new Map<string, number>()
  for (const r of releases) {
    if (r.end <= queuedAt) continue
    const overlap = r.end - Math.max(r.start, queuedAt)
    byLabel.set(r.label, (byLabel.get(r.label) ?? 0) + overlap)
  }
  if (holder) byLabel.set(`${holder.label} (still holding)`, Date.now() - Math.max(holder.since, queuedAt))
  const top = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  return top.length ? top.map(([l, ms]) => `${l} ${ms}ms`).join(', ') : 'nothing recorded'
}

function queueDepth(storage: LockedStorage): number {
  return Array.isArray(storage.readerLocks) ? Math.max(0, storage.readerLocks.length - 1) : 0
}

function wrapRunner(storage: LockedStorage, runner: Runner): void {
  const original = storage[runner]
  if (typeof original !== 'function') return
  storage[runner] = function traceRunner(this: unknown, body: unknown, ...rest: unknown[]) {
    // A chained sync call already holds the lock (`activeSync`); nothing to time.
    if (typeof body !== 'function' || (runner === 'runAsSync' && rest[0] != null)) {
      return (original as (...a: unknown[]) => unknown).call(this, body, ...rest)
    }
    const label = takeLabel(runner)
    const queuedAt = Date.now()
    return (original as (...a: unknown[]) => unknown).call(
      this,
      async (active: unknown) => {
        const got = Date.now()
        const waited = got - queuedAt
        if (waited >= WAIT_LOG_MS) {
          console.info(`[storage-lock] ${label} waited ${waited}ms behind ${holdersSince(queuedAt)}`)
        }
        holder = { label, since: got }
        let stuck: ReturnType<typeof setTimeout> | null = null
        const watch = (delay: number) => {
          stuck = setTimeout(() => {
            console.warn(
              `[storage-lock] ${label} still held ${Date.now() - got}ms — ${queueDepth(storage)} waiting`,
            )
            watch(STUCK_REPEAT_MS)
          }, delay)
        }
        watch(STUCK_FIRST_MS)
        try {
          return await (body as (a: unknown) => unknown)(active)
        } finally {
          if (stuck) clearTimeout(stuck)
          const end = Date.now()
          holder = null
          releases.push({ label, start: got, end })
          if (releases.length > RELEASES_KEPT) releases.shift()
          const held = end - got
          if (held >= HOLD_LOG_MS) {
            console.info(`[storage-lock] ${label} held ${held}ms — ${queueDepth(storage)} waiting`)
          }
        }
      },
      ...rest,
    )
  }
}

/**
 * `listOutputs(basket=1sat scripts limit=1000)` instead of a bare method
 * name: which basket and how much per row is what makes one read cost 98s
 * and the next 9ms. Special-operation baskets are 64-hex; eight chars name them.
 */
export function listCallLabel(name: string, vargs: unknown): string {
  if (!vargs || typeof vargs !== 'object') return name
  const v = vargs as Record<string, unknown>
  const parts: string[] = []
  if (typeof v.basket === 'string') parts.push(`basket=${v.basket.length === 64 ? v.basket.slice(0, 8) : v.basket}`)
  const tags = Array.isArray(v.tags) ? v.tags : Array.isArray(v.labels) ? v.labels : []
  if (tags.length) parts.push(`tags=${tags.length}`)
  if (v.includeLockingScripts === true) parts.push('scripts')
  if (v.includeTransactions === true) parts.push('beef')
  if (v.includeCustomInstructions === true) parts.push('remittance')
  if (typeof v.limit === 'number') parts.push(`limit=${v.limit}`)
  if (typeof v.offset === 'number' && v.offset !== 0) parts.push(`offset=${v.offset}`)
  return parts.length ? `${name}(${parts.join(' ')})` : name
}

const LIST_METHODS = new Set(['listOutputs', 'listActions'])

function wrapMethod(storage: LockedStorage, name: string, original: (...a: unknown[]) => unknown): void {
  storage[name] = function traceMethod(this: unknown, ...args: unknown[]) {
    const prev = callingMethod
    callingMethod = LIST_METHODS.has(name) ? listCallLabel(name, args[0]) : name
    try {
      return original.apply(this, args)
    } finally {
      callingMethod = prev
    }
  }
}

/**
 * Readers `await this.getAuth()` before `runAs*`, which drops the synchronous
 * label. Hand it across that one await: the continuation that calls `runAs*`
 * runs as soon as this promise settles.
 */
function wrapGetAuth(storage: LockedStorage): void {
  const original = storage.getAuth
  if (typeof original !== 'function') return
  storage.getAuth = function traceGetAuth(this: unknown, ...args: unknown[]) {
    const label = callingMethod
    const result = (original as (...a: unknown[]) => unknown).apply(this, args)
    if (!label || !(result instanceof Promise)) return result
    return result.then((auth) => {
      nextLockLabel = label
      return auth
    })
  }
}

/** Plain methods only — reading an accessor here would run it. */
function methodNames(storage: object): string[] {
  const names = new Set<string>()
  for (let proto = Object.getPrototypeOf(storage); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function') names.add(name)
    }
  }
  return [...names]
}

type MonitorLike = {
  runScheduledTask?: (task: { name?: string }) => Promise<unknown>
}

function traceMonitorTasks(monitor: MonitorLike | null | undefined): void {
  const original = monitor?.runScheduledTask
  if (!monitor || typeof original !== 'function' || traced.has(monitor)) return
  traced.add(monitor)
  monitor.runScheduledTask = async function traceTask(this: unknown, task: { name?: string }) {
    const name = typeof task?.name === 'string' ? task.name : 'task'
    const prev = monitorTask
    monitorTask = name
    const started = Date.now()
    try {
      return await original.call(this, task)
    } finally {
      monitorTask = prev
      const ms = Date.now() - started
      if (ms >= SLOW_TASK_MS) console.info(`[monitor] ${name} done ${ms}ms`)
    }
  }
}

/** Install once per wallet boot. Idempotent for the same storage manager. */
export function traceStorageLocks(storage: unknown, monitor?: unknown): void {
  if (storage && typeof storage === 'object' && !traced.has(storage)) {
    traced.add(storage)
    const target = storage as LockedStorage
    for (const name of methodNames(target)) {
      if (UNWRAPPED.has(name) || name.startsWith('_')) continue
      wrapMethod(target, name, target[name] as (...a: unknown[]) => unknown)
    }
    wrapGetAuth(target)
    for (const runner of RUNNERS) wrapRunner(target, runner)
  }
  traceMonitorTasks(monitor as MonitorLike | null | undefined)
}

/** Label a direct `runAs*` call from app code (`storage.runAsStorageProvider`). */
export function withStorageLockLabel<T>(label: string, call: () => T): T {
  const prev = callingMethod
  callingMethod = label
  try {
    return call()
  } finally {
    callingMethod = prev
  }
}

export function resetStorageLockTraceForTests(): void {
  callingMethod = null
  nextLockLabel = null
  monitorTask = null
  holder = null
  releases.length = 0
}
