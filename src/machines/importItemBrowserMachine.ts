import { assign, fromPromise, setup, type SnapshotFrom } from 'xstate'
import type { ImportItem, ImportItemList, ImportItemResult } from '../wallet/import'

/**
 * Settings → Import → a saved source → Items.
 *
 * Browse the source's 1-sat items and move one at a time. Nothing moves while
 * listing; each move is the user's choice of one item (`IMPORT`), runs alone,
 * and returns to `ready` with a named outcome. A moved or not-an-item row
 * leaves the list; every other outcome keeps it so it can be tried again.
 */

/** Wallet calls the chart invokes; the panel binds them to the source. */
export type ImportItemPorts = {
  list: (sourceId: string) => Promise<ImportItemList>
  importOne: (sourceId: string, item: ImportItem) => Promise<ImportItemResult>
}

export type ImportItemNotice = {
  tone: 'success' | 'warning' | 'danger'
  outcome: ImportItemResult['kind']
  title: string
  body: string
}

export const IMPORT_ITEM_PAGE = 24

export type ImportItemBrowserContext = {
  ports: ImportItemPorts
  sourceId: string
  items: ImportItem[]
  complete: boolean
  query: string
  shown: number
  importing: ImportItem | null
  notice: ImportItemNotice | null
  error: string | null
}

export type ImportItemBrowserEvent =
  | { type: 'RETRY' }
  | { type: 'MORE' }
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

export const importItemBrowserMachine = setup({
  types: {
    context: {} as ImportItemBrowserContext,
    events: {} as ImportItemBrowserEvent,
    input: {} as { ports: ImportItemPorts; sourceId: string },
  },
  actors: {
    list: fromPromise(({ input }: { input: { ports: ImportItemPorts; sourceId: string } }) =>
      input.ports.list(input.sourceId),
    ),
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
    pick: assign(({ context, event }) =>
      event.type === 'IMPORT'
        ? { importing: context.items.find((i) => i.outpoint === event.outpoint) ?? null, notice: null }
        : {},
    ),
    more: assign(({ context }) => ({ shown: context.shown + IMPORT_ITEM_PAGE })),
    filter: assign(({ event }) =>
      event.type === 'FILTER' ? { query: event.query, shown: IMPORT_ITEM_PAGE } : {},
    ),
    dismiss: assign({ notice: null }),
  },
}).createMachine({
  id: 'importItemBrowser',
  initial: 'loading',
  context: ({ input }) => ({
    ports: input.ports,
    sourceId: input.sourceId,
    items: [],
    complete: true,
    query: '',
    shown: IMPORT_ITEM_PAGE,
    importing: null,
    notice: null,
    error: null,
  }),
  states: {
    loading: {
      entry: assign({ error: null }),
      invoke: {
        src: 'list',
        input: ({ context }) => ({ ports: context.ports, sourceId: context.sourceId }),
        onDone: {
          target: 'ready',
          actions: assign(({ event }) => ({ items: event.output.items, complete: event.output.complete })),
        },
        onError: {
          target: 'failed',
          actions: assign({ error: ({ event }) => message(event.error) }),
        },
      },
    },
    ready: {
      on: {
        MORE: { actions: 'more' },
        FILTER: { actions: 'filter' },
        DISMISS: { actions: 'dismiss' },
        IMPORT: { guard: 'listed', target: 'importing', actions: 'pick' },
      },
    },
    /** One item, one transaction. Filter and paging stay live; other imports wait. */
    importing: {
      invoke: {
        src: 'importOne',
        input: ({ context }) => ({
          ports: context.ports,
          sourceId: context.sourceId,
          item: context.importing!,
        }),
        onDone: {
          target: 'ready',
          actions: assign(({ context, event }) => {
            const item = context.importing!
            const { notice, keep } = noticeFor(item, event.output)
            return {
              importing: null,
              notice,
              items: keep ? context.items : context.items.filter((i) => i.outpoint !== item.outpoint),
            }
          }),
        },
        onError: {
          target: 'ready',
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
      on: {
        MORE: { actions: 'more' },
        FILTER: { actions: 'filter' },
      },
    },
    failed: {
      on: { RETRY: { target: 'loading' } },
    },
  },
})

export type ImportItemBrowserSnapshot = SnapshotFrom<typeof importItemBrowserMachine>
