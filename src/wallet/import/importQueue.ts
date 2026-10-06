import { createActor } from 'xstate'
import {
  importQueueMachine,
  sourceRun,
  sourceView,
  watchSource,
  type ImportQueueEmitted,
  type ImportQueuePorts,
  type ImportQueueSnapshot,
  type ImportSourceView,
} from '../../machines/importQueueMachine'
import { appendAppLog } from '../appLog'
import { getWalletRuntime } from '../walletRuntime'
import { finishWalletProgress, getWalletProgress, startWalletProgress, updateWalletProgress } from '../walletProgress'
import { importItems, prefetchImportItems } from './items'

/**
 * The wallet's import queue: one `importQueueMachine` for the life of the
 * app, so chosen items keep moving after their browser closes. Browsers
 * enqueue and watch; the status pill shows the run through `walletProgress`.
 */

const PORTS: ImportQueuePorts = {
  importMany: (chunk) => importItems(chunk),
  prefetch: (chunk) => prefetchImportItems(chunk),
}

let actor: ReturnType<typeof createActor<typeof importQueueMachine>> | null = null

function queue() {
  if (actor) return actor
  actor = createActor(importQueueMachine, { input: { ports: PORTS } })
  actor.subscribe(reportProgress)
  actor.start()
  return actor
}

/** Running items across every source, and the wallet they move into. */
function runTotals(snapshot: ImportQueueSnapshot): { total: number; done: number; identityKey: string | null } {
  const { context } = snapshot
  let total = 0
  let done = 0
  for (const sourceId of Object.keys(context.tallies)) {
    const run = sourceRun(context, sourceId)
    if (!run) continue
    total += run.total
    done += run.done
  }
  const identityKey = context.moving[0]?.identityKey ?? context.queue[0]?.identityKey ?? null
  return { total, done, identityKey }
}

let progressOpen = false

/**
 * Mirror the run onto the shared progress bus. A Refresh may take the bus
 * mid-run; the import steps aside and takes it back once that job ends.
 */
function reportProgress(snapshot: ImportQueueSnapshot): void {
  const { total, done, identityKey } = runTotals(snapshot)
  const bus = getWalletProgress()
  const ours = bus.kind === 'item-import' && bus.status === 'running'
  if (!snapshot.matches('idle') && total > 0) {
    if (!ours && bus.status === 'running') return
    const message = snapshot.matches('cooling')
      ? 'Waiting for a spent fee coin to clear…'
      : `${done.toLocaleString()} of ${total.toLocaleString()} imported`
    const job = { current: done, total, message, ...(identityKey ? { identityKey } : {}) }
    if (ours) updateWalletProgress(job)
    else startWalletProgress({ kind: 'item-import', phase: 'importing-items', ...job })
    progressOpen = true
    return
  }
  if (!progressOpen) return
  progressOpen = false
  if (!ours) return
  const reports = Object.values(snapshot.context.reports)
  const worst = reports.find((r) => r.tone === 'danger') ?? reports.find((r) => r.tone === 'warning') ?? null
  finishWalletProgress(worst?.tone === 'danger' ? 'failed' : worst ? 'needs-resume' : 'done', {
    message: worst ? worst.title : 'Items imported',
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
  progressOpen = false
}
