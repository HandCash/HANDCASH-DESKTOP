import { createActor } from 'xstate'
import {
  importQueueMachine,
  sourceRun,
  sourceView,
  watchSource,
  type ImportItemNotice,
  type ImportQueueEmitted,
  type ImportQueuePorts,
  type ImportQueueSnapshot,
  type ImportSourceView,
} from '../../machines/importQueueMachine'
import { appendAppLog } from '../appLog'
import { getWalletRuntime } from '../walletRuntime'
import { beginWalletJob, type WalletJobHandle } from '../walletJobs'
import { finishWalletProgress, getWalletProgress, startWalletProgress, updateWalletProgress } from '../walletProgress'
import { importItems, prefetchImportItems } from './items'

/**
 * The wallet's import queue: one `importQueueMachine` for the life of the
 * app, so chosen items keep moving after their browser closes. Browsers
 * enqueue and watch. Each run, idle to idle, is one wallet job: one Activity
 * row with a bar while it moves, one folded record once it ends. The status
 * pill mirrors the same counts through `walletProgress`.
 */

type Run = {
  job: WalletJobHandle
  /** The job belongs to a sweep waiting on this run: the sweep reports progress and ends it. */
  adopted: boolean
  startedAt: number
  /** Every source this run touched, with its largest total and last done count. */
  sources: Map<string, { total: number; done: number }>
  /** Items the chunk in flight has already broadcast, before the chunk answers. */
  landed: { chunk: string; count: number } | null
}

let run: Run | null = null
/** Sweep jobs waiting on the queue, by wallet; a run that opens for one reports on its row. */
const adoptable = new Map<string, WalletJobHandle>()

/** The machine starts a chunk before subscribers see the snapshot that started it; whoever arrives first opens the run. */
function openRun(identityKey: string): Run {
  if (!run) {
    const adopted = adoptable.get(identityKey)
    run = {
      job: adopted ?? beginWalletJob({ kind: 'item-import', identityKey }),
      adopted: Boolean(adopted),
      startedAt: Date.now(),
      sources: new Map(),
      landed: null,
    }
  }
  return run
}

const PORTS: ImportQueuePorts = {
  importMany: (chunk) => {
    const current = openRun(chunk.identityKey)
    const key = chunk.outpoints.join(',')
    current.landed = { chunk: key, count: 0 }
    return importItems({
      ...chunk,
      activityGroup: current.job.id,
      onProgress: (moved) => {
        if (current.landed?.chunk === key) current.landed.count += moved
        if (actor) report(actor.getSnapshot())
      },
      onWaiting: (waiting) => {
        if (waiting && !current.adopted) current.job.wait('Waiting for the wallet to finish syncing…')
        else if (actor) report(actor.getSnapshot())
      },
    })
  },
  prefetch: (chunk) => prefetchImportItems(chunk),
}

let actor: ReturnType<typeof createActor<typeof importQueueMachine>> | null = null

function queue() {
  if (actor) return actor
  actor = createActor(importQueueMachine, { input: { ports: PORTS } })
  actor.subscribe(report)
  actor.start()
  return actor
}

function runIdentity(snapshot: ImportQueueSnapshot): string | null {
  const { context } = snapshot
  return context.moving[0]?.identityKey ?? context.queue[0]?.identityKey ?? null
}

/**
 * Totals across the whole run. A source that finished has left the queue's
 * tallies; it counts as fully answered, so the bar never steps backwards.
 */
function runTotals(snapshot: ImportQueueSnapshot, current: Run): { total: number; done: number } {
  const live = new Set<string>()
  for (const sourceId of Object.keys(snapshot.context.tallies)) {
    const tally = sourceRun(snapshot.context, sourceId)
    if (!tally) continue
    live.add(sourceId)
    const seen = current.sources.get(sourceId)
    current.sources.set(sourceId, { total: Math.max(seen?.total ?? 0, tally.total), done: tally.done })
  }
  let total = 0
  let done = 0
  for (const [sourceId, seen] of current.sources) {
    total += seen.total
    done += live.has(sourceId) ? seen.done : seen.total
  }
  return { total, done }
}

/** The run's verdict: the worst report of the sources it touched. */
function runVerdict(snapshot: ImportQueueSnapshot, current: Run): ImportItemNotice | null {
  const reports = [...current.sources.keys()]
    .map((id) => snapshot.context.reports[id])
    .filter((r): r is ImportItemNotice => Boolean(r))
  return reports.find((r) => r.tone === 'danger') ?? reports.find((r) => r.tone === 'warning') ?? reports[0] ?? null
}

function report(snapshot: ImportQueueSnapshot): void {
  const busy = !snapshot.matches('idle')
  if (busy && !run) {
    const identityKey = runIdentity(snapshot)
    if (!identityKey) return
    openRun(identityKey)
  }
  if (!run) return
  const current = run
  const totals = runTotals(snapshot, current)
  const total = totals.total
  // Once the chunk answers, its items count in `done` and `moving` holds another chunk.
  const landed =
    current.landed && current.landed.chunk === snapshot.context.moving.map((e) => e.outpoint).join(',')
      ? current.landed.count
      : 0
  const done = Math.min(total, totals.done + landed)
  if (busy) {
    const detail = `${done.toLocaleString()} of ${total.toLocaleString()} imported`
    if (current.adopted) {
      // The sweep that owns the row reports on it.
    } else if (snapshot.matches('cooling')) current.job.wait(COOLING_DETAIL)
    else current.job.progress(done, total > 0 ? total : null, detail)
    mirrorPill(snapshot, done, total)
    return
  }
  run = null
  const verdict = runVerdict(snapshot, current)
  const summary = verdict ? [verdict.title, verdict.body].filter(Boolean).join(' — ') : `${done.toLocaleString()} imported`
  if (current.adopted) {
    // The sweep ends its own row once its other steps finish.
  } else if (verdict?.tone === 'danger') current.job.fail(summary)
  else if (verdict?.tone === 'warning') current.job.stop(summary)
  else current.job.finish(summary)
  appendAppLog(
    verdict && verdict.tone !== 'success' ? 'warn' : 'info',
    `[import] run done ${Date.now() - current.startedAt}ms items=${total} answered=${done} sources=${current.sources.size}` +
      ` outcome=${verdict?.tone ?? 'success'}`,
  )
  closePill(verdict)
}

const COOLING_DETAIL = 'Waiting for the last import to clear…'

let pillOpen = false

/** A Refresh may take the shared pill mid-run; the import steps aside and takes it back once that job ends. */
function mirrorPill(snapshot: ImportQueueSnapshot, done: number, total: number): void {
  const bus = getWalletProgress()
  const ours = bus.kind === 'item-import' && bus.status === 'running'
  if (total <= 0 || (!ours && bus.status === 'running')) return
  const identityKey = runIdentity(snapshot)
  const message = snapshot.matches('cooling')
    ? COOLING_DETAIL
    : `${done.toLocaleString()} of ${total.toLocaleString()} imported`
  const job = { current: done, total, message, ...(identityKey ? { identityKey } : {}) }
  if (ours) updateWalletProgress(job)
  else startWalletProgress({ kind: 'item-import', phase: 'importing-items', ...job })
  pillOpen = true
}

function closePill(verdict: ImportItemNotice | null): void {
  if (!pillOpen) return
  pillOpen = false
  const bus = getWalletProgress()
  if (bus.kind !== 'item-import' || bus.status !== 'running') return
  finishWalletProgress(verdict?.tone === 'danger' ? 'failed' : verdict?.tone === 'warning' ? 'needs-resume' : 'done', {
    message: verdict && verdict.tone !== 'success' ? verdict.title : 'Items imported',
    ...(bus.identityKey ? { identityKey: bus.identityKey } : {}),
  })
}

/** Queue chosen items of a saved source for this wallet. */
export function enqueueImportItems(
  sourceId: string,
  items: ReadonlyArray<{ outpoint: string; name: string | null }>,
): void {
  const identityKey = getWalletRuntime()?.instance?.identityKey
  if (!identityKey) throw new Error('Unlock this wallet first')
  if (items.length === 0) return
  appendAppLog('info', `[import] queued ${items.length} item(s)`)
  queue().send({ type: 'ENQUEUE', sourceId, identityKey, items })
}

export type QueuedImportOutcome = {
  moved: number
  /** Not a collectable after all; stays at the source. */
  skipped: number
  failed: number
  /** The first failure's message. */
  error: string | null
  /** The source's verdict once the queue answered every item; null when nothing was queued. */
  report: ImportItemNotice | null
}

/**
 * Queue a source's items and wait until the queue has answered every one. A
 * sweep moves its items this way, so they take the same path, pauses and
 * stops as chosen items, and never race a second runner over the same tips.
 * A run that opens for these items reports on `job`; the caller reports
 * progress on it and ends it.
 */
export function importItemsThroughQueue(args: {
  sourceId: string
  outpoints: readonly string[]
  job: WalletJobHandle
  onProgress?: (progress: { done: number; total: number; paused: boolean }) => void
  shouldStop?: () => boolean
}): Promise<QueuedImportOutcome> {
  const identityKey = getWalletRuntime()?.instance?.identityKey
  if (!identityKey) return Promise.reject(new Error('Unlock this wallet first'))
  const outcome: QueuedImportOutcome = { moved: 0, skipped: 0, failed: 0, error: null, report: null }
  if (args.outpoints.length === 0) return Promise.resolve(outcome)
  appendAppLog('info', `[import] sweep queued ${args.outpoints.length} item(s)`)
  adoptable.set(identityKey, args.job)
  return new Promise((resolve) => {
    let started = false
    let stopSent = false
    let unwatch: (() => void) | null = null
    const settle = (report: ImportItemNotice | null) => {
      unwatch?.()
      if (adoptable.get(identityKey) === args.job) adoptable.delete(identityKey)
      // Other sources may keep this run going; they get a row of their own.
      if (run?.job === args.job) {
        run.job = beginWalletJob({ kind: 'item-import', identityKey })
        run.adopted = false
      }
      resolve({ ...outcome, report })
    }
    unwatch = watchImportSource(
      args.sourceId,
      (view) => {
        if (!view.run) {
          if (started) settle(view.report)
          return
        }
        started = true
        args.onProgress?.({ done: view.run.done, total: view.run.total, paused: view.paused })
        if (!stopSent && args.shouldStop?.() === true) {
          stopSent = true
          stopImportItems(args.sourceId)
        }
      },
      (results) => {
        for (const { result } of results) {
          if (result.kind === 'moved') outcome.moved += 1
          else if (result.kind === 'skipped') outcome.skipped += 1
          else if (result.kind === 'failed' || result.kind === 'unreadable') {
            outcome.failed += 1
            outcome.error ??= result.message
          }
        }
      },
    )
    queue().send({
      type: 'ENQUEUE',
      sourceId: args.sourceId,
      identityKey,
      items: args.outpoints.map((outpoint) => ({ outpoint, name: null })),
    })
    if (!started) settle(null)
  })
}

/** Drop a source's waiting items; the chunk in flight finishes. */
export function stopImportItems(sourceId: string): void {
  queue().send({ type: 'STOP', sourceId })
}

export function dismissImportReport(sourceId: string): void {
  queue().send({ type: 'DISMISS', sourceId })
}

export type { ImportSourceView }

export function importSourceView(sourceId: string): ImportSourceView {
  return sourceView(queue().getSnapshot(), sourceId)
}

/** Watch one source: its view on every change, and each chunk's answers. */
export function watchImportSource(
  sourceId: string,
  onView: (view: ImportSourceView) => void,
  onAnswered: (results: ImportQueueEmitted['results']) => void,
): () => void {
  return watchSource(queue(), sourceId, onView, onAnswered)
}

/** Test seam. */
export function resetImportQueueForTests(): void {
  actor?.stop()
  actor = null
  run = null
  adoptable.clear()
  pillOpen = false
}
