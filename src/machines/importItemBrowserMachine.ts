import { assign, fromCallback, fromPromise, setup, type SnapshotFrom } from 'xstate'
import type { ImportItem, ImportItemList, ImportItemResult } from '../wallet/import'

/**
 * Settings → Import → a saved source → Items.
 *
 * Two regions. `list` finds the source's 1-sat items and streams them in
 * (`FOUND`) so the grid fills while thousands are still being checked; leaving
 * the browser stops the search. `move` moves one item at a time: each move is
 * the user's choice of one listed item (`IMPORT`), runs alone, and returns to
 * `idle` with a named outcome. A moved or not-an-item row leaves the list and
 * stays out even if a later batch names it again; every other outcome keeps
 * it so it can be tried again.
 */

/** Wallet calls the chart invokes; the panel binds them to the source. */
export type ImportItemPorts = {
  list: (
    sourceId: string,
    onItems: (items: ImportItem[]) => void,
    shouldStop: () => boolean,
  ) => Promise<ImportItemList>
  importOne: (sourceId: string, item: ImportItem) => Promise<ImportItemResult>
}

export type ImportItemNotice = {
  tone: 'success' | 'warning' | 'danger'
  outcome: ImportItemResult['kind']
  title: string
  body: string
}

export type ImportItemBrowserContext = {
  ports: ImportItemPorts
  sourceId: string
  items: ImportItem[]
  /** Outpoints that left the list; later batches must not bring them back. */
  removed: string[]
  complete: boolean
  query: string
  importing: ImportItem | null
  notice: ImportItemNotice | null
  error: string | null
}

export type ImportItemBrowserEvent =
  | { type: 'FOUND'; items: ImportItem[] }
  | { type: 'LISTED'; complete: boolean }
  | { type: 'LIST_FAILED'; error: string }
  | { type: 'RETRY' }
  | { type: 'FILTER'; query: string }
  | { type: 'IMPORT'; outpoint: string }
  | { type: 'DISMISS' }

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function itemTitle(item: ImportItem): string {
  return item.name ?? 'Collectable'
}

/** The outcome as the user reads it, and whether the row stays listed. */
export function noticeFor(
  item: ImportItem,
  result: ImportItemResult,
): { notice: ImportItemNotice; keep: boolean } {
  const title = itemTitle(item)
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

/** Items matching the filter, in list order. Pure. */
export function filteredImportItems(context: Pick<ImportItemBrowserContext, 'items' | 'query'>): ImportItem[] {
  const query = context.query.trim().toLowerCase()
  if (!query) return context.items
  return context.items.filter(
    (item) => (item.name ?? '').toLowerCase().includes(query) || item.outpoint.startsWith(query),
  )
}

type ListInput = { ports: ImportItemPorts; sourceId: string }

export const importItemBrowserMachine = setup({
  types: {
    context: {} as ImportItemBrowserContext,
    events: {} as ImportItemBrowserEvent,
    input: {} as { ports: ImportItemPorts; sourceId: string },
  },
  actors: {
    list: fromCallback<ImportItemBrowserEvent, ListInput>(({ input, sendBack }) => {
      let stopped = false
      input.ports
        .list(
          input.sourceId,
          (items) => {
            if (!stopped) sendBack({ type: 'FOUND', items })
          },
          () => stopped,
        )
        .then(
          (list) => {
            if (!stopped) sendBack({ type: 'LISTED', complete: list.complete })
          },
          (err: unknown) => {
            if (!stopped) sendBack({ type: 'LIST_FAILED', error: message(err) })
          },
        )
      return () => {
        stopped = true
      }
    }),
    importOne: fromPromise(
      ({ input }: { input: { ports: ImportItemPorts; sourceId: string; item: ImportItem } }) =>
        input.ports.importOne(input.sourceId, input.item),
    ),
  },
  guards: {
    listed: ({ context, event }) =>
      event.type === 'IMPORT' && context.items.some((i) => i.outpoint === event.outpoint),
  },
  actions: {
    found: assign(({ context, event }) => {
      if (event.type !== 'FOUND') return {}
      const known = new Set([...context.removed, ...context.items.map((i) => i.outpoint)])
      const fresh = event.items.filter((i) => !known.has(i.outpoint))
      return fresh.length > 0 ? { items: [...context.items, ...fresh] } : {}
    }),
    pick: assign(({ context, event }) =>
      event.type === 'IMPORT'
        ? { importing: context.items.find((i) => i.outpoint === event.outpoint) ?? null, notice: null }
        : {},
    ),
    filter: assign(({ event }) => (event.type === 'FILTER' ? { query: event.query } : {})),
    dismiss: assign({ notice: null }),
  },
}).createMachine({
  id: 'importItemBrowser',
  type: 'parallel',
  context: ({ input }) => ({
    ports: input.ports,
    sourceId: input.sourceId,
    items: [],
    removed: [],
    complete: true,
    query: '',
    importing: null,
    notice: null,
    error: null,
  }),
  on: {
    FILTER: { actions: 'filter' },
    DISMISS: { actions: 'dismiss' },
  },
  states: {
    list: {
      initial: 'loading',
      states: {
        loading: {
          entry: assign({ error: null }),
          invoke: {
            src: 'list',
            input: ({ context }) => ({ ports: context.ports, sourceId: context.sourceId }),
          },
          on: {
            FOUND: { actions: 'found' },
            LISTED: {
              target: 'ready',
              actions: assign(({ event }) => ({ complete: event.complete })),
            },
            LIST_FAILED: {
              target: 'failed',
              actions: assign(({ event }) => ({ error: event.error })),
            },
          },
        },
        ready: {},
        failed: {
          on: { RETRY: { target: 'loading' } },
        },
      },
    },
    move: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            IMPORT: { guard: 'listed', target: 'importing', actions: 'pick' },
          },
        },
        /** One item, one transaction; other imports wait. */
        importing: {
          invoke: {
            src: 'importOne',
            input: ({ context }) => ({
              ports: context.ports,
              sourceId: context.sourceId,
              item: context.importing!,
            }),
            onDone: {
              target: 'idle',
              actions: assign(({ context, event }) => {
                const item = context.importing!
                const { notice, keep } = noticeFor(item, event.output)
                return keep
                  ? { importing: null, notice }
                  : {
                      importing: null,
                      notice,
                      items: context.items.filter((i) => i.outpoint !== item.outpoint),
                      removed: [...context.removed, item.outpoint],
                    }
              }),
            },
            onError: {
              target: 'idle',
              actions: assign(({ context, event }) => ({
                importing: null,
                notice: {
                  tone: 'danger' as const,
                  outcome: 'failed' as const,
                  title: `${itemTitle(context.importing!)} not imported`,
                  body: message(event.error),
                },
              })),
            },
          },
        },
      },
    },
  },
})

export type ImportItemBrowserSnapshot = SnapshotFrom<typeof importItemBrowserMachine>
