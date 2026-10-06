import { assign, enqueueActions, fromCallback, fromPromise, setup, type SnapshotFrom } from 'xstate'
import type {
  ImportItem,
  ImportItemChange,
  ImportItemPage,
  ImportItemResult,
  ImportItemShelf,
  ImportItemSync,
} from '../wallet/import'

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
 * - `move`: one item at a time. `IMPORT` moves one; `IMPORT_SELECTED` queues
 *   the selection behind a confirm, one transaction per item, and stops at
 *   the first missing-funds answer or on `STOP`. A moved or not-an-item row
 *   leaves the list; every other outcome keeps it so it can be tried again.
 */

export const IMPORT_PAGE_SIZE = 60
const SHELF_REREAD_MS = 1_200

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
  importOne: (sourceId: string, outpoint: string) => Promise<ImportItemResult>
}

export type ImportItemNotice = {
  tone: 'success' | 'warning' | 'danger'
  outcome: ImportItemResult['kind'] | 'batch'
  title: string
  body: string
}

/** A chosen item and the shelf it sits on. */
export type ImportSelection = { outpoint: string; group: string }

type Tally = { total: number; moved: number; failure: ImportItemNotice | null; stopped: boolean }

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
  /** Outpoints still to move; the head is moving. */
  queue: string[]
  tally: Tally
  notice: ImportItemNotice | null
}

export type ImportItemBrowserEvent =
  | { type: 'CHANGED'; change: ImportItemChange }
  | { type: 'SYNCED'; sync: ImportItemSync }
  | { type: 'SYNC_FAILED'; error: string }
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

/** What a finished selection import says: how many moved, and why it stopped short. */
export function batchNotice(tally: Tally): ImportItemNotice {
  const { total, moved, failure, stopped } = tally
  const count = `${moved.toLocaleString()} of ${total.toLocaleString()} imported`
  if (moved === total) {
    return { tone: 'success', outcome: 'batch', title: `${total.toLocaleString()} items imported`, body: 'They are in this wallet now.' }
  }
  if (failure?.outcome === 'funds') return { ...failure, body: `${count}. ${failure.body}` }
  if (stopped) return { tone: 'warning', outcome: 'batch', title: 'Import stopped', body: `${count}.` }
  return { tone: failure?.tone ?? 'warning', outcome: 'batch', title: count, body: failure ? `${failure.title}: ${failure.body}` : '' }
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

function withSelection(
  selected: readonly ImportSelection[],
  items: readonly ImportSelection[],
  checked: boolean,
): ImportSelection[] {
  const touched = new Set(items.map((i) => i.outpoint))
  const rest = selected.filter((s) => !touched.has(s.outpoint))
  return checked ? [...rest, ...items] : rest
}

const NO_TALLY: Tally = { total: 0, moved: 0, failure: null, stopped: false }

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
    importOne: fromPromise(({ input }: { input: SyncInput & { outpoint: string } }) =>
      input.ports.importOne(input.sourceId, input.outpoint),
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
    outOfFunds: ({ event }) =>
      (event as { output?: ImportItemResult }).output?.kind === 'funds',
    queueContinues: ({ context }) => context.queue.length > 1 && !context.tally.stopped,
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
    queueOne: assign(({ event }) =>
      event.type === 'IMPORT'
        ? { queue: [event.outpoint], tally: { ...NO_TALLY, total: 1 }, notice: null }
        : {},
    ),
    queueSelected: assign(({ context }) => ({
      queue: context.selected.map((s) => s.outpoint),
      tally: { ...NO_TALLY, total: context.selected.length },
      notice: null,
    })),
    /** One queue answer: tally it, drop it from the selection, and from the list unless it stays. */
    recordImport: enqueueActions(({ context, event, enqueue }) => {
      const result = (event as unknown as { output: ImportItemResult }).output
      const outpoint = context.queue[0]!
      const name = context.items.find((i) => i.outpoint === outpoint)?.name ?? null
      const { notice, keep } = noticeFor(name, result)
      const moved = result.kind === 'moved'
      const tally: Tally = {
        ...context.tally,
        moved: context.tally.moved + (moved ? 1 : 0),
        failure: moved ? context.tally.failure : notice,
      }
      const rest = context.queue.slice(1)
      const finished = rest.length === 0 || result.kind === 'funds' || tally.stopped
      enqueue.assign({
        queue: finished ? [] : rest,
        tally,
        selected: context.selected.filter((s) => s.outpoint !== outpoint),
        notice: finished ? (tally.total === 1 ? notice : batchNotice(tally)) : null,
      })
      if (!keep) enqueue.raise({ type: 'CHANGED', change: { added: 0, gone: [outpoint] } })
    }),
    dismiss: assign({ notice: null }),
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
    queue: [],
    tally: NO_TALLY,
    notice: null,
  }),
  on: {
    CHANGED: { actions: 'changed' },
    SELECT: { actions: 'select' },
    SELECT_SHELF: { guard: 'deselectShelf', actions: 'deselectShelf' },
    CLEAR: { actions: assign({ selected: [] }) },
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
            IMPORT: { target: 'importing', actions: 'queueOne' },
            IMPORT_SELECTED: [
              { guard: 'oneSelected', target: 'importing', actions: 'queueSelected' },
              { guard: 'hasSelection', target: 'confirming' },
            ],
          },
        },
        /** More than one item: each is its own transaction, so ask once. */
        confirming: {
          on: {
            CONFIRM: [
              { guard: 'hasSelection', target: 'importing', actions: 'queueSelected' },
              { target: 'idle' },
            ],
            CANCEL: { target: 'idle' },
          },
        },
        /** The queue head moves alone; the next waits for its answer. */
        importing: {
          on: {
            STOP: { actions: assign(({ context }) => ({ tally: { ...context.tally, stopped: true } })) },
          },
          invoke: {
            src: 'importOne',
            input: ({ context }) => ({ ports: context.ports, sourceId: context.sourceId, outpoint: context.queue[0]! }),
            onDone: [
              { guard: 'outOfFunds', target: 'idle', actions: 'recordImport' },
              { guard: 'queueContinues', target: 'importing', reenter: true, actions: 'recordImport' },
              { target: 'idle', actions: 'recordImport' },
            ],
            onError: {
              target: 'idle',
              actions: assign(({ context, event }) => {
                const outpoint = context.queue[0]!
                const name = context.items.find((i) => i.outpoint === outpoint)?.name ?? null
                const failure: ImportItemNotice = {
                  tone: 'danger',
                  outcome: 'failed',
                  title: `${itemTitle(name)} not imported`,
                  body: message(event.error),
                }
                const tally = { ...context.tally, failure }
                return {
                  queue: [],
                  tally,
                  notice: tally.total === 1 ? failure : batchNotice(tally),
                }
              }),
            },
          },
        },
      },
    },
  },
})

export type ImportItemBrowserSnapshot = SnapshotFrom<typeof importItemBrowserMachine>
