/**
 * Wallet jobs: one `walletJobMachine` actor per long job the wallet is running
 * — an item import run, a balance heal. Activity paints each as a single row
 * with a bar; the rows the job writes carry its id as `sendGroupId` and fold
 * into one record once it ends.
 */
import { createActor, type Actor } from 'xstate'
import {
  JOB_GROUP_PREFIX,
  walletJobFace,
  walletJobMachine,
  walletJobProgress,
  type WalletJobFace,
  type WalletJobInput,
  type WalletJobKind,
} from '../machines/walletJobMachine'

export type { WalletJobFace, WalletJobKind }

export type WalletJob = {
  id: string
  kind: WalletJobKind
  identityKey: string
  face: WalletJobFace
  current: number
  total: number | null
  detail: string | null
  error: string | null
  startedAt: number
  /** Null while the total is unknown: the bar runs indeterminate. */
  progress: { value: number; max: number } | null
}

export type WalletJobHandle = {
  readonly id: string
  progress(current: number, total: number | null, detail?: string | null): void
  wait(detail: string): void
  resume(): void
  finish(detail?: string | null): void
  stop(detail?: string | null): void
  fail(reason: string): void
}

type Entry = {
  actor: Actor<typeof walletJobMachine>
  retire: ReturnType<typeof setTimeout> | null
}

/** Long enough to see the bar fill; then the folded record speaks. */
const DONE_RETIRE_MS = 1_800
/** Failures and stops stay long enough to be read. */
const ENDED_RETIRE_MS = 8_000

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let views: readonly WalletJob[] = []

function project(actor: Actor<typeof walletJobMachine>): WalletJob {
  const snapshot = actor.getSnapshot()
  const c = snapshot.context
  return {
    id: c.id,
    kind: c.kind,
    identityKey: c.identityKey,
    face: walletJobFace(snapshot),
    current: c.current,
    total: c.total,
    detail: c.detail,
    error: c.error,
    startedAt: c.startedAt,
    progress: walletJobProgress(snapshot),
  }
}

function publish(): void {
  views = Object.freeze(
    Array.from(entries.values(), (entry) => project(entry.actor)).sort(
      (a, b) => b.startedAt - a.startedAt,
    ),
  )
  for (const listener of listeners) listener()
}

function drop(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.retire) clearTimeout(entry.retire)
  entry.actor.stop()
  entries.delete(id)
  publish()
}

function handleFor(id: string): WalletJobHandle {
  const send = (event: Parameters<Actor<typeof walletJobMachine>['send']>[0]) => {
    const entry = entries.get(id)
    if (!entry || entry.actor.getSnapshot().status !== 'active') return
    entry.actor.send(event)
    const face = walletJobFace(entry.actor.getSnapshot())
    if (face === 'done' || face === 'stopped' || face === 'failed') {
      if (entry.retire) clearTimeout(entry.retire)
      entry.retire = setTimeout(() => drop(id), face === 'done' ? DONE_RETIRE_MS : ENDED_RETIRE_MS)
    }
    publish()
  }
  return {
    id,
    progress: (current, total, detail) => send({ type: 'PROGRESS', current, total, detail }),
    wait: (detail) => send({ type: 'WAIT', detail }),
    resume: () => send({ type: 'RESUME' }),
    finish: (detail) => send({ type: 'FINISH', detail }),
    stop: (detail) => send({ type: 'STOP', detail }),
    fail: (reason) => send({ type: 'FAIL', reason }),
  }
}

/** Start a job. Its id doubles as the Activity group id of every row it writes. */
export function beginWalletJob(input: Omit<WalletJobInput, 'id'> & { id?: string }): WalletJobHandle {
  const startedAt = input.startedAt ?? Date.now()
  const id = input.id ?? `${JOB_GROUP_PREFIX}${input.kind}:${startedAt.toString(36)}`
  if (entries.has(id)) drop(id)
  const actor = createActor(walletJobMachine, { input: { ...input, id, startedAt } })
  actor.start()
  entries.set(id, { actor, retire: null })
  publish()
  return handleFor(id)
}

const TITLES: Readonly<Record<WalletJobKind, Readonly<Record<WalletJobFace, string>>>> = {
  'item-import': {
    running: 'Importing collectables',
    waiting: 'Import waiting',
    done: 'Import complete',
    stopped: 'Import stopped',
    failed: 'Import failed',
  },
  'balance-heal': {
    running: 'Healing balance',
    waiting: 'Heal waiting',
    done: 'Balance healed',
    stopped: 'Heal stopped',
    failed: 'Balance heal failed',
  },
}

export function walletJobTitle(job: Pick<WalletJob, 'kind' | 'face'>): string {
  return TITLES[job.kind][job.face]
}

/** "12 / 40" while countable; null while the bar is indeterminate. */
export function walletJobCount(job: Pick<WalletJob, 'progress' | 'kind' | 'total'>): string | null {
  const { progress } = job
  if (!progress || job.total == null || job.total <= 0) return null
  if (job.kind === 'balance-heal') return `${Math.round((progress.value / progress.max) * 100)}%`
  return `${progress.value.toLocaleString()} / ${progress.max.toLocaleString()}`
}

/** Ids of jobs still on screen; their durable rows wait until the job row leaves. */
export function walletJobIds(jobs: readonly WalletJob[]): ReadonlySet<string> {
  return new Set(jobs.map((job) => job.id))
}

export function listWalletJobs(identityKey?: string | null): readonly WalletJob[] {
  if (!identityKey) return views
  const key = identityKey.toLowerCase()
  return views.filter((job) => job.identityKey.toLowerCase() === key)
}

export function subscribeWalletJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget every job. */
export function resetWalletJobsForTests(): void {
  for (const id of Array.from(entries.keys())) drop(id)
}
