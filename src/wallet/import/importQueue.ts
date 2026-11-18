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
import { importItems, prefetchImportItems, ImportWalletChangedError } from './items'
import { pinAccountKeyScope, type BoundAccountKeyScope } from '../accountLocalKeys'
import { ImportCheckpoint } from './importCheckpoint'

/**
 * The wallet's import queue: one `importQueueMachine` for the life of the
 * app, so chosen items keep moving after their browser closes. Browsers
 * enqueue and watch. Each run, idle to idle, is one wallet job: one Activity
 * row with a bar while it moves, one folded record once it ends. The status
 * pill mirrors the same counts through `walletProgress`.
 */

type Run = {
  job: WalletJobHandle
  startedAt: number
  /** Every source this run touched, with its largest total and last done count. */
  sources: Map<string, { total: number; done: number }>
}

let run: Run | null = null

/** The machine starts a chunk before subscribers see the snapshot that started it; whoever arrives first opens the run. */
function openRun(identityKey: string): Run {
  run ??= { job: beginWalletJob({ kind: 'item-import', identityKey }), startedAt: Date.now(), sources: new Map() }
  return run
}

let actor: ReturnType<typeof createActor<typeof importQueueMachine>> | null = null
let checkpoint: ImportCheckpoint | null = null

function currentOwner(): BoundAccountKeyScope | undefined {
  return pinAccountKeyScope(getWalletRuntime()?.instance)
}

function sameOwner(a: BoundAccountKeyScope, b: BoundAccountKeyScope | undefined): boolean {
  return !!b && a.identityKey === b.identityKey && a.accountIndex === b.accountIndex && a.chain === b.chain
}

function queue() {
  const owner = currentOwner()
  if (actor && (!owner || (checkpoint && sameOwner(checkpoint.owner, owner)))) return actor
  // Stopping the actor does not abort a signed transaction: its promise/outbox
  // finishes, while the old account's checkpoint remains available on return.
  actor?.stop()
  actor = null
  run?.job.stop('Wallet changed; import waits for its wallet')
  run = null
  checkpoint = owner ? new ImportCheckpoint(owner) : null
  const saved = checkpoint
  const ports: ImportQueuePorts = {
    importMany: async ({ onLanded, ...chunk }) => {
      if (!saved || !sameOwner(saved.owner, currentOwner())) throw new ImportWalletChangedError()
      const result = await importItems({
        ...chunk, owner: saved.owner, onLanded, activityGroup: openRun(chunk.identityKey).job.id,
      })
      // Failures/offline/deferred work stay durable. Only a decided spend is
      // removed; a crash before here re-enters the sealed-tip recovery path.
      saved.settled(chunk.sourceId, result.results
        .filter(({ result }) => result.kind === 'moved' || result.kind === 'skipped')
        .map(({ outpoint }) => outpoint))
      return result
    },
    prefetch: (chunk) => sameOwner(owner!, currentOwner()) ? prefetchImportItems(chunk) : Promise.resolve(),
  }
  actor = createActor(importQueueMachine, { input: { ports } })
  actor.subscribe(report)
  actor.start()
  // Read only this account's journal. ENQUEUE deduplicates a repeated resume.
  for (const entry of saved?.entries() ?? []) {
    actor.send({ type: 'ENQUEUE', identityKey: saved!.owner.identityKey, ...entry })
  }
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

/** "12 of 2,630 imported" — the whole run, never the chunk in flight. */
function runDetail(done: number, total: number): string {
  return `${done.toLocaleString()} of ${total.toLocaleString()} imported`
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
  const { total, done } = runTotals(snapshot, current)
  if (busy) {
    const detail = runDetail(done, total)
    if (snapshot.matches('cooling')) current.job.wait('Waiting for a spent fee coin to clear…')
    else current.job.progress(done, total > 0 ? total : null, detail)
    mirrorPill(snapshot, done, total)
    return
  }
  run = null
  const verdict = runVerdict(snapshot, current)
  const summary = verdict ? [verdict.title, verdict.body].filter(Boolean).join(' — ') : `${done.toLocaleString()} imported`
  if (verdict?.tone === 'danger') current.job.fail(summary)
  else if (verdict?.tone === 'warning') current.job.stop(summary)
  else current.job.finish(summary)
  appendAppLog(
    verdict && verdict.tone !== 'success' ? 'warn' : 'info',
    `[import] run done ${Date.now() - current.startedAt}ms items=${total} answered=${done} sources=${current.sources.size}` +
      ` outcome=${verdict?.tone ?? 'success'}`,
  )
  closePill(verdict)
}

let pillOpen = false

/** A Refresh may take the shared pill mid-run; the import steps aside and takes it back once that job ends. */
function mirrorPill(snapshot: ImportQueueSnapshot, done: number, total: number): void {
  const bus = getWalletProgress()
  const ours = bus.kind === 'item-import' && bus.status === 'running'
  if (total <= 0 || (!ours && bus.status === 'running')) return
  const identityKey = runIdentity(snapshot)
  const message = snapshot.matches('cooling') ? 'Waiting for a spent fee coin to clear…' : runDetail(done, total)
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
  const owner = currentOwner()
  if (!owner) throw new Error('Unlock this wallet first')
  if (items.length === 0) return
  const target = queue()
  checkpoint!.enqueue(sourceId, items)
  appendAppLog('info', `[import] queued ${items.length} item(s)`)
  target.send({ type: 'ENQUEUE', sourceId, identityKey: owner.identityKey, items })
}

/** Drop a source's waiting items; the chunk in flight finishes. */
export function stopImportItems(sourceId: string): void {
  const target = queue()
  checkpoint?.stop(sourceId)
  target.send({ type: 'STOP', sourceId })
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
  checkpoint = null
  run = null
  pillOpen = false
}
