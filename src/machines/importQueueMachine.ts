import { assign, enqueueActions, fromPromise, setup, type ActorRefFrom, type SnapshotFrom } from 'xstate'
import type { ImportItemResult, ImportItemsResult } from '../wallet/import'

/**
 * Settings → Import → Browse items, moved off the page: the wallet's one
 * queue of chosen items, running in the background.
 *
 * The browser only enqueues. Leaving it, opening another source, or choosing
 * more while a chunk moves all leave the queue running. It hands the wallet
 * `IMPORT_CHUNK` items of one source at a time, packed 25 to a transaction,
 * and reads the next chunk's source transactions while the current one
 * signs. Chunks run one after another: every chunk spends this wallet's
 * change.
 *
 * - Out of BSV: that wallet's waiting items drop, reported per source.
 * - Fee coin spent elsewhere: the untried items wait `STALE_FUNDING_PAUSE_MS`
 *   and go again, up to `STALE_FUNDING_PAUSES` times, then drop.
 * - A chunk queued for a wallet that is no longer open refuses without
 *   moving anything; that wallet's items drop.
 * - `STOP` drops a source's waiting items; the chunk in flight finishes.
 */

export const IMPORT_CHUNK = 100
export const STALE_FUNDING_PAUSE_MS = 8_000
export const STALE_FUNDING_PAUSES = 2

export type ImportItemNotice = {
  tone: 'success' | 'warning' | 'danger'
  outcome: ImportItemResult['kind'] | 'batch'
  title: string
  body: string
}

export type ImportTally = {
  total: number
  moved: number
  failure: ImportItemNotice | null
  stopped: boolean
  /** The latest single answer, for a run of one item. */
  last: ImportItemNotice | null
}

export type ImportQueueEntry = { sourceId: string; identityKey: string; outpoint: string }

export type ImportQueuePorts = {
  importMany: (chunk: { sourceId: string; identityKey: string; outpoints: string[] }) => Promise<ImportItemsResult>
  /** Warm the source transactions of the chunk after this one. Never throws. */
  prefetch: (chunk: { sourceId: string; outpoints: string[] }) => Promise<void>
}

export type ImportQueueContext = {
  ports: ImportQueuePorts
  /** Waiting, in the order chosen. */
  queue: ImportQueueEntry[]
  /** The chunk in flight, or waiting out a spent fee coin. */
  moving: ImportQueueEntry[]
  /** Each running source's answers so far. */
  tallies: Record<string, ImportTally>
  /** Each finished source's outcome, until dismissed or run again. */
  reports: Record<string, ImportItemNotice>
  names: Record<string, string | null>
  stopping: string[]
  pauses: number
}

export type ImportQueueEvent =
  | {
      type: 'ENQUEUE'
      sourceId: string
      identityKey: string
      items: ReadonlyArray<{ outpoint: string; name: string | null }>
    }
  | { type: 'STOP'; sourceId: string }
  | { type: 'DISMISS'; sourceId: string }

/** One chunk's answers, for whichever browser is showing that source. */
export type ImportQueueEmitted = {
  type: 'answered'
  sourceId: string
  results: ImportItemsResult['results']
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function itemTitle(name: string | null | undefined): string {
  return name ?? 'Item'
}

/** The outcome as the user reads it, and whether the row stays listed. */
export function noticeFor(
  name: string | null,
  result: ImportItemResult,
): { notice: ImportItemNotice; keep: boolean } {
  const title = itemTitle(name)
  switch (result.kind) {
    case 'moved':
      return {
        keep: false,
        notice: { tone: 'success', outcome: result.kind, title: `${title} imported`, body: 'It is in this wallet now.' },
      }
    case 'skipped':
      return {
        keep: false,
        notice: { tone: 'warning', outcome: result.kind, title: `${title} stays at the source`, body: result.message },
      }
    case 'funds':
      return {
        keep: true,
        notice: { tone: 'warning', outcome: result.kind, title: 'Add BSV to import', body: result.message },
      }
    case 'deferred':
      return {
        keep: true,
        notice: { tone: 'warning', outcome: result.kind, title: 'Import paused', body: result.message },
      }
    case 'refused':
      return {
        keep: true,
        notice: { tone: 'warning', outcome: result.kind, title: `${title} not imported`, body: result.message },
      }
    case 'unreadable':
    case 'failed':
      return {
        keep: true,
        notice: { tone: 'danger', outcome: result.kind, title: `${title} not imported`, body: result.message },
      }
  }
}

/** What a finished run says: how many moved, and why it stopped short. */
export function batchNotice(tally: Pick<ImportTally, 'total' | 'moved' | 'failure' | 'stopped'>): ImportItemNotice {
  const { total, moved, failure, stopped } = tally
  const count = `${moved.toLocaleString()} of ${total.toLocaleString()} imported`
  if (moved === total) {
    return { tone: 'success', outcome: 'batch', title: `${total.toLocaleString()} items imported`, body: 'They are in this wallet now.' }
  }
  if (failure?.outcome === 'funds' || failure?.outcome === 'deferred') return { ...failure, body: `${count}. ${failure.body}` }
  if (stopped) return { tone: 'warning', outcome: 'batch', title: 'Import stopped', body: `${count}.` }
  return { tone: failure?.tone ?? 'warning', outcome: 'batch', title: count, body: failure ? `${failure.title}: ${failure.body}` : '' }
}

/** The next chunk: the head entry's source and wallet, in queue order, up to `IMPORT_CHUNK`. Pure. */
export function nextChunk(queue: readonly ImportQueueEntry[]): ImportQueueEntry[] {
  const head = queue[0]
  if (!head) return []
  const chunk: ImportQueueEntry[] = []
  for (const entry of queue) {
    if (entry.sourceId !== head.sourceId || entry.identityKey !== head.identityKey) continue
    chunk.push(entry)
    if (chunk.length >= IMPORT_CHUNK) break
  }
  return chunk
}

/** A source's run as a browser shows it. Pure. */
export function sourceRun(
  context: Pick<ImportQueueContext, 'queue' | 'moving' | 'tallies' | 'stopping'>,
  sourceId: string,
): { moving: string[]; waiting: string[]; total: number; done: number; stopping: boolean } | null {
  const tally = context.tallies[sourceId]
  if (!tally) return null
  const moving = context.moving.filter((e) => e.sourceId === sourceId).map((e) => e.outpoint)
  const waiting = context.queue.filter((e) => e.sourceId === sourceId).map((e) => e.outpoint)
  return {
    moving,
    waiting,
    total: tally.total,
    done: Math.max(0, tally.total - moving.length - waiting.length),
    stopping: context.stopping.includes(sourceId),
  }
}

const NO_TALLY: ImportTally = { total: 0, moved: 0, failure: null, stopped: false, last: null }

type DoneEvent = { output: ImportItemsResult }

function settled(
  context: ImportQueueContext,
  queue: readonly ImportQueueEntry[],
  moving: readonly ImportQueueEntry[],
  tallies: Record<string, ImportTally>,
): Pick<ImportQueueContext, 'tallies' | 'reports' | 'stopping'> {
  const live = new Set([...queue, ...moving].map((e) => e.sourceId))
  const nextTallies: Record<string, ImportTally> = {}
  const reports = { ...context.reports }
  for (const [sourceId, tally] of Object.entries(tallies)) {
    if (live.has(sourceId)) nextTallies[sourceId] = tally
    else reports[sourceId] = tally.total === 1 && tally.last ? tally.last : batchNotice(tally)
  }
  return { tallies: nextTallies, reports, stopping: context.stopping.filter((s) => live.has(s)) }
}

export const importQueueMachine = setup({
  types: {
    context: {} as ImportQueueContext,
    events: {} as ImportQueueEvent,
    emitted: {} as ImportQueueEmitted,
    input: {} as { ports: ImportQueuePorts },
  },
  actors: {
    importMany: fromPromise(
      ({ input }: { input: { ports: ImportQueuePorts; chunk: ImportQueueEntry[] } }) =>
        input.ports.importMany({
          sourceId: input.chunk[0]!.sourceId,
          identityKey: input.chunk[0]!.identityKey,
          outpoints: input.chunk.map((e) => e.outpoint),
        }),
    ),
    prefetch: fromPromise(async ({ input }: { input: { ports: ImportQueuePorts; chunk: ImportQueueEntry[] } }) => {
      if (input.chunk.length === 0) return
      await input.ports.prefetch({ sourceId: input.chunk[0]!.sourceId, outpoints: input.chunk.map((e) => e.outpoint) })
    }),
  },
  delays: {
    staleFundingPause: STALE_FUNDING_PAUSE_MS,
  },
  guards: {
    hasQueue: ({ context }) => context.queue.length > 0,
    staleFunding: ({ context, event }) =>
      (event as unknown as DoneEvent).output?.stopped === 'stale-funding' && context.pauses < STALE_FUNDING_PAUSES,
    movingStopped: ({ context, event }) =>
      event.type === 'STOP' && context.moving.some((e) => e.sourceId === event.sourceId),
  },
  actions: {
    enqueue: assign(({ context, event }) => {
      if (event.type !== 'ENQUEUE') return {}
      const known = new Set(
        [...context.queue, ...context.moving].filter((e) => e.sourceId === event.sourceId).map((e) => e.outpoint),
      )
      const fresh = event.items.filter((item) => {
        if (known.has(item.outpoint)) return false
        known.add(item.outpoint)
        return true
      })
      if (fresh.length === 0) return {}
      const tally = context.tallies[event.sourceId] ?? NO_TALLY
      const { [event.sourceId]: _finished, ...reports } = context.reports
      const names = { ...context.names }
      for (const item of fresh) names[item.outpoint] = item.name
      return {
        queue: [
          ...context.queue,
          ...fresh.map((item) => ({ sourceId: event.sourceId, identityKey: event.identityKey, outpoint: item.outpoint })),
        ],
        tallies: { ...context.tallies, [event.sourceId]: { ...tally, total: tally.total + fresh.length } },
        reports,
        names,
        stopping: context.stopping.filter((s) => s !== event.sourceId),
      }
    }),
    takeChunk: assign(({ context }) => {
      const chunk = nextChunk(context.queue)
      const taken = new Set(chunk)
      return { moving: chunk, queue: context.queue.filter((e) => !taken.has(e)) }
    }),
    /** A stop drops the source's waiting items now; the chunk in flight finishes. */
    stopSource: assign(({ context, event }) => {
      if (event.type !== 'STOP' || !context.tallies[event.sourceId]) return {}
      const tally = context.tallies[event.sourceId]!
      return {
        queue: context.queue.filter((e) => e.sourceId !== event.sourceId),
        tallies: { ...context.tallies, [event.sourceId]: { ...tally, stopped: true } },
        stopping: [...new Set([...context.stopping, event.sourceId])],
      }
    }),
    /** Stopping while paused drops the paused chunk too: nothing of it is in flight. */
    dropPausedSource: assign(({ context, event }) => {
      if (event.type !== 'STOP') return {}
      const moving = context.moving.filter((e) => e.sourceId !== event.sourceId)
      return { moving, ...settled(context, context.queue, moving, context.tallies) }
    }),
    dismiss: assign(({ context, event }) => {
      if (event.type !== 'DISMISS') return {}
      const { [event.sourceId]: _gone, ...reports } = context.reports
      return { reports }
    }),
    /**
     * One chunk's answers: tally them per source and tell the browser. A
     * missing-funds, still-busy or abandoned-send answer drops every waiting item of that
     * wallet; a spent fee coin keeps the untried items for one more pass after
     * a pause.
     */
    recordChunk: enqueueActions(({ context, event, enqueue }) => {
      const { results, stopped } = (event as unknown as DoneEvent).output
      const chunk = context.moving
      const sourceId = chunk[0]?.sourceId ?? ''
      const identityKey = chunk[0]?.identityKey ?? ''
      const pausing = stopped === 'stale-funding' && context.pauses < STALE_FUNDING_PAUSES
      const tally = { ...(context.tallies[sourceId] ?? NO_TALLY) }
      const retry: ImportQueueEntry[] = []
      const answered: ImportItemsResult['results'] = []
      for (const answer of results) {
        if (pausing && answer.result.kind === 'deferred') {
          const entry = chunk.find((e) => e.outpoint === answer.outpoint)
          if (entry) retry.push(entry)
          continue
        }
        answered.push(answer)
        const { notice } = noticeFor(context.names[answer.outpoint] ?? null, answer.result)
        tally.last = notice
        if (answer.result.kind === 'moved') tally.moved += 1
        else if (tally.failure?.outcome !== 'funds') tally.failure = notice
      }
      let queue = context.queue
      const tallies = { ...context.tallies, [sourceId]: tally }
      if (stopped === 'funds' || stopped === 'busy' || stopped === 'abandoned' || (stopped === 'stale-funding' && !pausing)) {
        queue = queue.filter((e) => e.identityKey !== identityKey)
        const dropped = new Set(context.queue.filter((e) => e.identityKey === identityKey).map((e) => e.sourceId))
        dropped.delete(sourceId)
        for (const id of dropped) {
          const other = tallies[id] ?? NO_TALLY
          tallies[id] = { ...other, failure: other.failure ?? tally.failure }
        }
      }
      const names = { ...context.names }
      for (const answer of answered) delete names[answer.outpoint]
      enqueue.assign({
        queue,
        moving: retry,
        names,
        pauses: pausing ? context.pauses + 1 : 0,
        ...settled({ ...context, names }, queue, retry, tallies),
      })
      if (answered.length > 0) enqueue.emit({ type: 'answered', sourceId, results: answered })
    }),
    /** The chunk threw: its source's items drop, or the whole wallet's when the wallet changed. */
    recordFailure: assign(({ context, event }) => {
      const err = (event as { error?: unknown }).error
      const chunk = context.moving
      const sourceId = chunk[0]?.sourceId ?? ''
      const identityKey = chunk[0]?.identityKey ?? ''
      const walletChanged = (err as { name?: unknown } | null)?.name === 'ImportWalletChangedError'
      const failure: ImportItemNotice = {
        tone: 'danger',
        outcome: 'failed',
        title: chunk.length === 1 ? `${itemTitle(context.names[chunk[0]!.outpoint])} not imported` : 'Items not imported',
        body: message(err),
      }
      const queue = context.queue.filter((e) =>
        walletChanged ? e.identityKey !== identityKey : e.sourceId !== sourceId,
      )
      const tallies = { ...context.tallies }
      for (const id of new Set([sourceId, ...context.queue.filter((e) => !queue.includes(e)).map((e) => e.sourceId)])) {
        const tally = tallies[id] ?? NO_TALLY
        tallies[id] = { ...tally, failure, last: failure }
      }
      return { queue, moving: [], pauses: 0, ...settled(context, queue, [], tallies) }
    }),
    requeuePaused: assign(({ context }) => ({ queue: [...context.moving, ...context.queue], moving: [] })),
  },
}).createMachine({
  id: 'importQueue',
  initial: 'idle',
  context: ({ input }) => ({
    ports: input.ports,
    queue: [],
    moving: [],
    tallies: {},
    reports: {},
    names: {},
    stopping: [],
    pauses: 0,
  }),
  on: {
    DISMISS: { actions: 'dismiss' },
  },
  states: {
    idle: {
      on: {
        ENQUEUE: { target: 'deciding', actions: 'enqueue' },
      },
    },
    /** Transient: move the next chunk, or rest. */
    deciding: {
      always: [{ guard: 'hasQueue', target: 'moving' }, { target: 'idle' }],
    },
    /** One chunk in shared transactions; the next chunk's sources are read meanwhile. */
    moving: {
      entry: 'takeChunk',
      invoke: [
        {
          id: 'importMany',
          src: 'importMany',
          input: ({ context }) => ({ ports: context.ports, chunk: context.moving }),
          onDone: [
            { guard: 'staleFunding', target: 'cooling', actions: 'recordChunk' },
            { target: 'deciding', actions: 'recordChunk' },
          ],
          onError: { target: 'deciding', actions: 'recordFailure' },
        },
        {
          id: 'prefetch',
          src: 'prefetch',
          input: ({ context }) => ({ ports: context.ports, chunk: nextChunk(context.queue) }),
        },
      ],
      on: {
        ENQUEUE: { actions: 'enqueue' },
        STOP: { actions: 'stopSource' },
      },
    },
    /** The fee coin was spent elsewhere; give the wallet a moment to retire it. */
    cooling: {
      after: {
        staleFundingPause: { target: 'deciding', actions: 'requeuePaused' },
      },
      on: {
        ENQUEUE: { actions: 'enqueue' },
        STOP: [
          { guard: 'movingStopped', target: 'deciding', actions: ['stopSource', 'dropPausedSource'] },
          { actions: 'stopSource' },
        ],
      },
    },
  },
})

export type ImportQueueSnapshot = SnapshotFrom<typeof importQueueMachine>

/** What a browser shows for one source: its run, if any, and its last outcome. */
export type ImportSourceView = {
  run: ReturnType<typeof sourceRun>
  report: ImportItemNotice | null
  /** Chunks are waiting out a spent fee coin. */
  paused: boolean
}

export function sourceView(snapshot: ImportQueueSnapshot, sourceId: string): ImportSourceView {
  return {
    run: sourceRun(snapshot.context, sourceId),
    report: snapshot.context.reports[sourceId] ?? null,
    paused: snapshot.matches('cooling'),
  }
}

/** Watch one source of a running queue: its view on every change, and each chunk's answers. */
export function watchSource(
  queue: ActorRefFrom<typeof importQueueMachine>,
  sourceId: string,
  onView: (view: ImportSourceView) => void,
  onAnswered: (results: ImportQueueEmitted['results']) => void,
): () => void {
  onView(sourceView(queue.getSnapshot(), sourceId))
  const sub = queue.subscribe((snapshot) => onView(sourceView(snapshot, sourceId)))
  const answered = queue.on('answered', (event) => {
    if (event.sourceId === sourceId) onAnswered(event.results)
  })
  return () => {
    sub.unsubscribe()
    answered.unsubscribe()
  }
}
