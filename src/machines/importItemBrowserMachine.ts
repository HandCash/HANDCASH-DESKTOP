import { assign, enqueueActions, fromCallback, fromPromise, setup, type SnapshotFrom } from 'xstate'
import type {
  ImportItem,
  ImportItemChange,
  ImportItemPage,
  ImportItemsResult,
  ImportItemShelf,
  ImportItemSync,
} from '../wallet/import'
import { noticeFor, type ImportItemNotice, type ImportSourceView } from './importQueueMachine'

export { batchNotice, IMPORT_CHUNK, noticeFor, type ImportItemNotice } from './importQueueMachine'

/**
 * Settings → Import → a saved source → Browse items. Collect's face, with
 * Import instead of Send.
 *
 * The list is saved on the device, so it paints from disk first and `sync`
 * then checks only what was never checked, saving as it goes (`CHANGED`).
 * Leaving stops the check; what it found stays.
 *
 * - `shelves`: the list grouped by issuer, re-read (debounced) as it changes.
 * - `page`: one open shelf, or search results, a page at a time (`MORE`).
 * - `gather`: selecting a whole shelf reads its outpoints from disk.
 * - `move`: `IMPORT` hands one item to the wallet's background import queue;
 *   `IMPORT_SELECTED` hands the selection over behind a confirm and clears
 *   it, so more can be chosen while it moves. Nothing here waits on the
 *   import: the queue keeps going when the browser closes.
 * - `watchQueue` (root): the queue's run for this source (`QUEUE_VIEW`) and
 *   each chunk's answers (`ANSWERED`) — a moved or not-an-item row leaves
 *   the list; every other outcome keeps it so it can be tried again.
 */

export const IMPORT_PAGE_SIZE = 60
const SHELF_REREAD_MS = 1_200

/** The background queue as this browser sees one source. */
export type ImportQueueView = ImportSourceView

/** Wallet calls the chart invokes; the panel binds them to the source. */
export type ImportItemPorts = {
  sync: (
    sourceId: string,
    onChange: (change: ImportItemChange) => void,
    shouldStop: () => boolean,
  ) => Promise<ImportItemSync>
  readShelves: (sourceId: string) => Promise<ImportItemShelf[]>
  readPage: (
    sourceId: string,
    opts: { group?: string; after: number | null; limit: number; query?: string },
  ) => Promise<ImportItemPage>
  shelfOutpoints: (sourceId: string, group: string) => Promise<string[]>
  enqueue: (sourceId: string, items: Array<{ outpoint: string; name: string | null }>) => void
  stop: (sourceId: string) => void
  dismiss: (sourceId: string) => void
  watch: (
    sourceId: string,
    onView: (view: ImportQueueView) => void,
    onAnswered: (results: ImportItemsResult['results']) => void,
  ) => () => void
}

/** A chosen item and the shelf it sits on. */
export type ImportSelection = { outpoint: string; group: string }

export type ImportItemBrowserContext = {
  ports: ImportItemPorts
  sourceId: string
  shelves: ImportItemShelf[]
  /** The list changed since the shelves were read. */
  shelvesStale: boolean
  /** Every output the source names was checked. */
  complete: boolean
  syncError: string | null
  readError: string | null
  /** Shelf whose items are paged in, or null. */
  open: string | null
  query: string
  items: ImportItem[]
  last: number | null
  more: boolean
  /** Items were saved while a page read was in flight. */
  grew: boolean
  selected: ImportSelection[]
  gathering: string | null
  queue: ImportQueueView
  /** The queue refused the hand-over (a locked wallet). */
  notice: ImportItemNotice | null
}

export type ImportItemBrowserEvent =
  | { type: 'CHANGED'; change: ImportItemChange }
  | { type: 'SYNCED'; sync: ImportItemSync }
  | { type: 'SYNC_FAILED'; error: string }
  | { type: 'QUEUE_VIEW'; view: ImportQueueView }
  | { type: 'ANSWERED'; results: ImportItemsResult['results'] }
  | { type: 'RETRY' }
  | { type: 'OPEN'; group: string | null }
  | { type: 'FILTER'; query: string }
  | { type: 'MORE' }
  | { type: 'SELECT'; items: ImportSelection[]; checked: boolean }
  | { type: 'SELECT_SHELF'; group: string; checked: boolean }
  | { type: 'CLEAR' }
  | { type: 'IMPORT'; outpoint: string }
  | { type: 'IMPORT_SELECTED' }
  | { type: 'CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'STOP' }
  | { type: 'DISMISS' }

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Chosen items per shelf. Pure. */
export function selectedPerShelf(selected: readonly ImportSelection[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const { group } of selected) out.set(group, (out.get(group) ?? 0) + 1)
  return out
}

/** Items listed across every shelf. Pure. */
export function shelvedTotal(shelves: readonly ImportItemShelf[]): number {
  return shelves.reduce((sum, shelf) => sum + shelf.count, 0)
}

/** Outpoints the queue holds for this source: moving now, and waiting. Pure. */
export function queuedOutpoints(view: ImportQueueView): { moving: Set<string>; waiting: Set<string> } {
  return { moving: new Set(view.run?.moving ?? []), waiting: new Set(view.run?.waiting ?? []) }
}

function withSelection(
  selected: readonly ImportSelection[],
  items: readonly ImportSelection[],
  checked: boolean,
): ImportSelection[] {
  const touched = new Set(items.map((i) => i.outpoint))
  const rest = selected.filter((s) => !touched.has(s.outpoint))
  return checked ? [...rest, ...items] : rest
}

const NO_QUEUE: ImportQueueView = { run: null, report: null, paused: false }

type SyncInput = { ports: ImportItemPorts; sourceId: string }
type PageInput = { ports: ImportItemPorts; sourceId: string; open: string | null; query: string; after: number | null }

export const importItemBrowserMachine = setup({
  types: {
    context: {} as ImportItemBrowserContext,
    events: {} as ImportItemBrowserEvent,
    input: {} as { ports: ImportItemPorts; sourceId: string },
  },
  actors: {
    sync: fromCallback<ImportItemBrowserEvent, SyncInput>(({ input, sendBack }) => {
      let stopped = false
      input.ports
        .sync(
          input.sourceId,
          (change) => {
            if (!stopped) sendBack({ type: 'CHANGED', change })
          },
          () => stopped,
        )
        .then(
          (sync) => {
            if (!stopped) sendBack({ type: 'SYNCED', sync })
          },
          (err: unknown) => {
            if (!stopped) sendBack({ type: 'SYNC_FAILED', error: message(err) })
          },
        )
      return () => {
        stopped = true
      }
    }),
    watchQueue: fromCallback<ImportItemBrowserEvent, SyncInput>(({ input, sendBack }) =>
      input.ports.watch(
        input.sourceId,
        (view) => sendBack({ type: 'QUEUE_VIEW', view }),
        (results) => sendBack({ type: 'ANSWERED', results }),
      ),
    ),
    readShelves: fromPromise(({ input }: { input: SyncInput }) => input.ports.readShelves(input.sourceId)),
    readPage: fromPromise(({ input }: { input: PageInput }) =>
      input.ports.readPage(input.sourceId, {
        ...(input.query.trim() ? { query: input.query } : input.open != null ? { group: input.open } : {}),
        after: input.after,
        limit: IMPORT_PAGE_SIZE,
      }),
    ),
    shelfOutpoints: fromPromise(({ input }: { input: SyncInput & { group: string } }) =>
      input.ports.shelfOutpoints(input.sourceId, input.group),
    ),
  },
  guards: {
    showing: ({ context }) => context.open != null || context.query.trim() !== '',
    otherShelf: ({ context, event }) => event.type === 'OPEN' && event.group !== context.open,
    hasMore: ({ context }) => context.more,
    shelvesStale: ({ context }) => context.shelvesStale,
    hasSelection: ({ context }) => context.selected.length > 0,
    oneSelected: ({ context }) => context.selected.length === 1,
    deselectShelf: ({ event }) => event.type === 'SELECT_SHELF' && !event.checked,
    selectShelf: ({ event }) => event.type === 'SELECT_SHELF' && event.checked,
  },
  actions: {
    changed: assign(({ context, event }) => {
      if (event.type !== 'CHANGED') return {}
      const gone = new Set(event.change.gone)
      return {
        shelvesStale: true,
        items: gone.size > 0 ? context.items.filter((i) => !gone.has(i.outpoint)) : context.items,
        selected: gone.size > 0 ? context.selected.filter((s) => !gone.has(s.outpoint)) : context.selected,
        grew: context.grew || event.change.added > 0,
        more: context.more || event.change.added > 0,
      }
    }),
    showFrom: assign(({ event }) => {
      if (event.type === 'OPEN') return { open: event.group, items: [], last: null, more: false, readError: null }
      if (event.type === 'FILTER') return { query: event.query, items: [], last: null, more: false, readError: null }
      return {}
    }),
    select: assign(({ context, event }) =>
      event.type === 'SELECT' ? { selected: withSelection(context.selected, event.items, event.checked) } : {},
    ),
    deselectShelf: assign(({ context, event }) =>
      event.type === 'SELECT_SHELF' ? { selected: context.selected.filter((s) => s.group !== event.group) } : {},
    ),
    /** Hand items to the background queue; a refusal (locked wallet) is the only answer here. */
    enqueue: enqueueActions(({ context, event, enqueue }) => {
      const outpoints =
        event.type === 'IMPORT' ? [event.outpoint] : context.selected.map((s) => s.outpoint)
      if (outpoints.length === 0) return
      const names = new Map(context.items.map((i) => [i.outpoint, i.name]))
      try {
        context.ports.enqueue(
          context.sourceId,
          outpoints.map((outpoint) => ({ outpoint, name: names.get(outpoint) ?? null })),
        )
        enqueue.assign({ notice: null, ...(event.type === 'IMPORT' ? {} : { selected: [] }) })
      } catch (err) {
        enqueue.assign({
          notice: { tone: 'danger', outcome: 'failed', title: 'Items not imported', body: message(err) },
        })
      }
    }),
    /** A chunk's answers: rows that moved or are not items leave the list. */
    answered: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'ANSWERED') return
      const names = new Map(context.items.map((i) => [i.outpoint, i.name]))
      const gone = event.results
        .filter(({ outpoint, result }) => !noticeFor(names.get(outpoint) ?? null, result).keep)
        .map(({ outpoint }) => outpoint)
      if (gone.length > 0) enqueue.raise({ type: 'CHANGED', change: { added: 0, gone } })
    }),
    stop: ({ context }) => context.ports.stop(context.sourceId),
    dismiss: enqueueActions(({ context, enqueue }) => {
      if (context.notice) enqueue.assign({ notice: null })
      else if (context.queue.report) context.ports.dismiss(context.sourceId)
    }),
  },
}).createMachine({
  id: 'importItemBrowser',
  type: 'parallel',
  context: ({ input }) => ({
    ports: input.ports,
    sourceId: input.sourceId,
    shelves: [],
    shelvesStale: false,
    complete: false,
    syncError: null,
    readError: null,
    open: null,
    query: '',
    items: [],
    last: null,
    more: false,
    grew: false,
    selected: [],
    gathering: null,
    queue: NO_QUEUE,
    notice: null,
  }),
  invoke: {
    src: 'watchQueue',
    input: ({ context }) => ({ ports: context.ports, sourceId: context.sourceId }),
  },
  on: {
    CHANGED: { actions: 'changed' },
    QUEUE_VIEW: { actions: assign(({ event }) => ({ queue: event.view })) },
    ANSWERED: { actions: 'answered' },
    SELECT: { actions: 'select' },
    SELECT_SHELF: { guard: 'deselectShelf', actions: 'deselectShelf' },
    CLEAR: { actions: assign({ selected: [] }) },
    STOP: { actions: 'stop' },
    DISMISS: { actions: 'dismiss' },
  },
  states: {
    sync: {
      initial: 'checking',
      states: {
        checking: {
          entry: assign({ syncError: null }),
          invoke: {
            src: 'sync',
            input: ({ context }) => ({ ports: context.ports, sourceId: context.sourceId }),
          },
          on: {
            SYNCED: {
              target: 'done',
              actions: assign(({ event }) => ({ complete: event.sync.complete, shelvesStale: true })),
            },
            SYNC_FAILED: {
              target: 'failed',
              actions: assign(({ event }) => ({ syncError: event.error })),
            },
          },
        },
        done: {},
        failed: {
          on: { RETRY: { target: 'checking' } },
        },
      },
    },
    shelves: {
      initial: 'reading',
      states: {
        reading: {
          entry: assign({ shelvesStale: false }),
          invoke: {
            src: 'readShelves',
            input: ({ context }) => ({ ports: context.ports, sourceId: context.sourceId }),
            onDone: {
              target: 'idle',
              actions: assign(({ event }) => ({ shelves: event.output })),
            },
            onError: {
              target: 'failed',
              actions: assign(({ event }) => ({ readError: message(event.error) })),
            },
          },
        },
        idle: {
          always: { guard: 'shelvesStale', target: 'settling' },
        },
        /** Batches arrive every few hundred ms while checking; read once they pause. */
        settling: {
          after: { [SHELF_REREAD_MS]: { target: 'reading' } },
        },
        failed: {
          on: { RETRY: { target: 'reading' } },
        },
      },
    },
    page: {
      initial: 'closed',
      on: {
        OPEN: { guard: 'otherShelf', target: '.routing', actions: 'showFrom' },
        FILTER: { target: '.routing', actions: 'showFrom' },
      },
      states: {
        routing: {
          always: [{ guard: 'showing', target: 'reading' }, { target: 'closed' }],
        },
        closed: {},
        reading: {
          entry: assign({ grew: false }),
          invoke: {
            src: 'readPage',
            input: ({ context }) => ({
              ports: context.ports,
              sourceId: context.sourceId,
              open: context.open,
              query: context.query,
              after: context.last,
            }),
            onDone: {
              target: 'ready',
              actions: assign(({ context, event }) => {
                const known = new Set(context.items.map((i) => i.outpoint))
                const fresh = event.output.items.filter((i) => !known.has(i.outpoint))
                return {
                  items: fresh.length > 0 ? [...context.items, ...fresh] : context.items,
                  last: event.output.last ?? context.last,
                  more: event.output.more || context.grew,
                }
              }),
            },
            onError: {
              target: 'failed',
              actions: assign(({ event }) => ({ readError: message(event.error) })),
            },
          },
        },
        ready: {
          on: { MORE: { guard: 'hasMore', target: 'reading' } },
        },
        failed: {
          on: { RETRY: { target: 'reading', actions: assign({ readError: null }) } },
        },
      },
    },
    gather: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            SELECT_SHELF: {
              guard: 'selectShelf',
              target: 'reading',
              actions: assign(({ event }) => ({ gathering: event.group })),
            },
          },
        },
        reading: {
          invoke: {
            src: 'shelfOutpoints',
            input: ({ context }) => ({ ports: context.ports, sourceId: context.sourceId, group: context.gathering! }),
            onDone: {
              target: 'idle',
              actions: assign(({ context, event }) => ({
                gathering: null,
                selected: withSelection(
                  context.selected,
                  event.output.map((outpoint) => ({ outpoint, group: context.gathering! })),
                  true,
                ),
              })),
            },
            onError: {
              target: 'idle',
              actions: assign(({ event }) => ({ gathering: null, readError: message(event.error) })),
            },
          },
        },
      },
    },
    move: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            IMPORT: { actions: 'enqueue' },
            IMPORT_SELECTED: [
              { guard: 'oneSelected', actions: 'enqueue' },
              { guard: 'hasSelection', target: 'confirming' },
            ],
          },
        },
        /** More than one item spends fees across several transactions, so ask once. */
        confirming: {
          on: {
            CONFIRM: [
              { guard: 'hasSelection', target: 'idle', actions: 'enqueue' },
              { target: 'idle' },
            ],
            CANCEL: { target: 'idle' },
          },
        },
      },
    },
  },
})

export type ImportItemBrowserSnapshot = SnapshotFrom<typeof importItemBrowserMachine>
