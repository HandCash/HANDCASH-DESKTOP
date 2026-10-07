import { createActor, waitFor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportItem, ImportItemChange, ImportItemResult, ImportItemsResult, ImportItemShelf, ImportItemSync } from '../wallet/import'
import {
  batchNotice,
  IMPORT_CHUNK,
  importItemBrowserMachine,
  noticeFor,
  queuedOutpoints,
  selectedPerShelf,
  type ImportItemPorts,
} from './importItemBrowserMachine'
import { IMPORT_RAMP, importChunkSize, importQueueMachine, watchSource, type ImportQueuePorts } from './importQueueMachine'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`

/** The chunk sizes the queue hands the wallet for a run of `n` items. */
const chunkSizes = (n: number) => {
  const sizes: number[] = []
  for (let taken = 0; taken < n; ) {
    const size = Math.min(importChunkSize(taken), n - taken)
    sizes.push(size)
    taken += size
  }
  return sizes
}

const item = (n: number, name: string | null = `Item ${n}`): ImportItem => ({
  outpoint: op(n),
  address: '1addr',
  origin: null,
  media: null,
  name,
  mimeType: null,
  app: null,
  collectionId: null,
  signer: null,
  imageUrl: null,
})

const MOVED: ImportItemResult = { kind: 'moved', txid: 'f'.repeat(64) }

/** The wallet's answer for a chunk, one result per outpoint. */
const answer = (outpoints: string[], resultOf: (outpoint: string) => ImportItemResult): ImportItemsResult => {
  const results = outpoints.map((outpoint) => ({ outpoint, result: resultOf(outpoint) }))
  return { results, stopped: results.some((r) => r.result.kind === 'funds') ? 'funds' : null }
}

const shelf = (key: string, count: number): ImportItemShelf => ({
  key,
  kind: 'app',
  label: key,
  app: key,
  signer: null,
  collectionId: null,
  count,
  faces: [],
})

/** A saved list in memory: shelves keyed by group, pages by position. */
function savedList(groups: Record<string, ImportItem[]>) {
  const all = () => Object.values(groups).flat()
  return {
    groups,
    readShelves: vi.fn(async () =>
      Object.entries(groups)
        .filter(([, items]) => items.length > 0)
        .map(([key, items]) => shelf(key, items.length)),
    ),
    readPage: vi.fn<ImportItemPorts['readPage']>(async (_id, opts) => {
      const pool = opts.query
        ? all().filter((i) => (i.name ?? '').toLowerCase().includes(opts.query!.toLowerCase()))
        : opts.group != null
          ? (groups[opts.group] ?? [])
          : all()
      const from = opts.after == null ? 0 : opts.after + 1
      const items = pool.slice(from, from + opts.limit)
      return { items, last: items.length > 0 ? from + items.length - 1 : opts.after, more: from + opts.limit < pool.length, total: all().length }
    }),
    shelfOutpoints: vi.fn(async (_id: string, group: string) => (groups[group] ?? []).map((i) => i.outpoint)),
    drop(outpoint: string) {
      for (const key of Object.keys(groups)) groups[key] = groups[key]!.filter((i) => i.outpoint !== outpoint)
    },
  }
}

type Sync = { onChange: (change: ImportItemChange) => void; finish: (sync: ImportItemSync) => void }

type ImportMany = ImportQueuePorts['importMany']

/** A real background queue behind the browser's ports, for wallet `id1`. */
function backgroundQueue(importMany: ImportMany) {
  const queue = createActor(importQueueMachine, {
    input: { ports: { importMany: vi.fn(importMany), prefetch: vi.fn(async () => undefined) } },
  }).start()
  const ports: Pick<ImportItemPorts, 'enqueue' | 'stop' | 'dismiss' | 'watch'> = {
    enqueue: (sourceId, items) => queue.send({ type: 'ENQUEUE', sourceId, identityKey: 'id1', items }),
    stop: (sourceId) => queue.send({ type: 'STOP', sourceId }),
    dismiss: (sourceId) => queue.send({ type: 'DISMISS', sourceId }),
    watch: (sourceId, onView, onAnswered) => watchSource(queue, sourceId, onView, onAnswered),
  }
  const importManyMock = queue.getSnapshot().context.ports.importMany as ReturnType<typeof vi.fn<ImportMany>>
  return { queue, ports, importMany: importManyMock }
}

const outpointsOf = (mock: ReturnType<typeof vi.fn<ImportMany>>) => mock.mock.calls.map(([chunk]) => chunk.outpoints)

function start(
  groups: Record<string, ImportItem[]>,
  opts: { ports?: Partial<ImportItemPorts>; importMany?: ImportMany } = {},
) {
  const list = savedList(groups)
  const syncs: Sync[] = []
  const background = backgroundQueue(
    opts.importMany ??
      (async ({ outpoints }) => {
        for (const outpoint of outpoints) list.drop(outpoint)
        return answer(outpoints, () => MOVED)
      }),
  )
  const full: ImportItemPorts = {
    sync: vi.fn(
      (_id, onChange) =>
        new Promise<ImportItemSync>((finish) => {
          syncs.push({ onChange, finish })
        }),
    ),
    readShelves: list.readShelves,
    readPage: list.readPage,
    shelfOutpoints: list.shelfOutpoints,
    ...background.ports,
    ...opts.ports,
  }
  const actor = createActor(importItemBrowserMachine, { input: { ports: full, sourceId: 's1' } }).start()
  return { actor, ports: full, list, syncs, queue: background.queue, importMany: background.importMany }
}

/** Hold each chunk until the test releases it. */
function heldChunks() {
  const releases: Array<() => void> = []
  const importMany: ImportMany = ({ outpoints }) =>
    new Promise<ImportItemsResult>((resolve) => {
      releases.push(() => resolve(answer(outpoints, () => MOVED)))
    })
  return { importMany, release: () => releases.shift()?.() }
}

const settledReport = (actor: ReturnType<typeof start>['actor']) =>
  waitFor(actor, (s) => s.context.queue.run == null && s.context.queue.report != null)

afterEach(() => {
  vi.useRealTimers()
})

describe('importItemBrowserMachine', () => {
  it('paints the saved shelves before the check finishes, then pages the opened shelf', async () => {
    const zoo = Array.from({ length: 70 }, (_, i) => item(i + 1))
    const { actor, list, syncs } = start({ zoo, alpha: [item(100)] })
    const shelved = await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    expect(shelved.context.shelves.map((s) => [s.key, s.count])).toEqual([
      ['zoo', 70],
      ['alpha', 1],
    ])
    expect(shelved.matches({ sync: 'checking' })).toBe(true)

    actor.send({ type: 'OPEN', group: 'zoo' })
    const first = await waitFor(actor, (s) => s.matches({ page: 'ready' }))
    expect(first.context.items).toHaveLength(60)
    expect(first.context.more).toBe(true)
    actor.send({ type: 'MORE' })
    const second = await waitFor(actor, (s) => s.matches({ page: 'ready' }) && s.context.items.length === 70)
    expect(second.context.more).toBe(false)
    expect(list.readPage).toHaveBeenLastCalledWith('s1', { group: 'zoo', after: 59, limit: 60 })

    actor.send({ type: 'FILTER', query: 'Item 100' })
    const found = await waitFor(actor, (s) => s.matches({ page: 'ready' }) && s.context.items.length === 1)
    expect(found.context.items[0]!.outpoint).toBe(op(100))
    syncs[0]!.finish({ complete: true, total: 71 })
    expect((await waitFor(actor, (s) => s.matches({ sync: 'done' }))).context.complete).toBe(true)
  })

  it('re-reads shelves once a burst of saved batches pauses, and drops what left', async () => {
    vi.useFakeTimers()
    const { actor, list, syncs } = start({ zoo: [item(1), item(2)] })
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ shelves: 'idle' })).toBe(true))
    actor.send({ type: 'OPEN', group: 'zoo' })
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ page: 'ready' })).toBe(true))
    expect(list.readShelves).toHaveBeenCalledTimes(1)

    list.groups.zoo = [item(2), item(3)]
    syncs[0]!.onChange({ added: 1, gone: [] })
    syncs[0]!.onChange({ added: 0, gone: [op(1)] })
    expect(actor.getSnapshot().context.items.map((i) => i.outpoint)).toEqual([op(2)])
    expect(actor.getSnapshot().context.more).toBe(true)
    expect(list.readShelves).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_300)
    expect(list.readShelves).toHaveBeenCalledTimes(2)
  })

  it('moves exactly the chosen item and drops it from the list', async () => {
    const { actor, importMany } = start({ zoo: [item(1), item(2)] })
    actor.send({ type: 'OPEN', group: 'zoo' })
    await waitFor(actor, (s) => s.matches({ page: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: op(2) })
    expect(actor.getSnapshot().context.queue.run?.moving).toEqual([op(2)])
    const done = await settledReport(actor)
    expect(importMany).toHaveBeenCalledTimes(1)
    expect(importMany).toHaveBeenCalledWith({ sourceId: 's1', identityKey: 'id1', outpoints: [op(2)] })
    expect(done.context.items.map((i) => i.outpoint)).toEqual([op(1)])
    expect(done.context.queue.report).toMatchObject({ tone: 'success', outcome: 'moved', title: 'Item 2 imported' })
  })

  it('keeps every button live while a chunk moves, and queues what is chosen next', async () => {
    const held = heldChunks()
    const { actor, importMany } = start({ zoo: [item(1), item(2), item(3)] }, { importMany: held.importMany })
    actor.send({ type: 'OPEN', group: 'zoo' })
    await waitFor(actor, (s) => s.matches({ page: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: op(1) })
    expect(actor.getSnapshot().matches({ move: 'idle' })).toBe(true)

    actor.send({ type: 'SELECT', items: [{ outpoint: op(2), group: 'zoo' }, { outpoint: op(3), group: 'zoo' }], checked: true })
    actor.send({ type: 'IMPORT_SELECTED' })
    actor.send({ type: 'CONFIRM' })
    const queued = actor.getSnapshot()
    expect(queued.context.selected).toEqual([])
    expect(queuedOutpoints(queued.context.queue)).toEqual({ moving: new Set([op(1)]), waiting: new Set([op(2), op(3)]) })

    held.release()
    await vi.waitFor(() => expect(importMany).toHaveBeenCalledTimes(2))
    held.release()
    const done = await settledReport(actor)
    expect(outpointsOf(importMany)).toEqual([[op(1)], [op(2), op(3)]])
    expect(done.context.items).toEqual([])
    expect(done.context.queue.report).toMatchObject({ tone: 'success', title: '3 items imported' })
  })

  it('keeps importing after the browser closes', async () => {
    const held = heldChunks()
    const zoo = Array.from({ length: IMPORT_CHUNK + 3 }, (_, i) => item(i + 1))
    const { actor, queue, importMany } = start({ zoo }, { importMany: held.importMany })
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    await waitFor(actor, (s) => s.context.selected.length === zoo.length)
    actor.send({ type: 'IMPORT_SELECTED' })
    actor.send({ type: 'CONFIRM' })
    actor.stop()

    const sizes = chunkSizes(zoo.length)
    for (let call = 2; call <= sizes.length; call++) {
      held.release()
      await vi.waitFor(() => expect(importMany).toHaveBeenCalledTimes(call))
    }
    held.release()
    const idle = await waitFor(queue, (s) => s.matches('idle'))
    expect(outpointsOf(importMany).map((o) => o.length)).toEqual(sizes)
    expect(idle.context.reports.s1).toMatchObject({ title: `${zoo.length} items imported` })
  })

  it('selects a whole shelf from disk and imports the selection behind one confirm', async () => {
    const { actor, importMany } = start({ zoo: [item(1), item(2)], alpha: [item(3)] })
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    const gathered = await waitFor(actor, (s) => s.matches({ gather: 'idle' }) && s.context.selected.length === 2)
    actor.send({ type: 'SELECT', items: [{ outpoint: op(3), group: 'alpha' }], checked: true })
    expect(selectedPerShelf(actor.getSnapshot().context.selected)).toEqual(new Map([['zoo', 2], ['alpha', 1]]))
    expect(gathered.context.selected.map((s) => s.outpoint)).toEqual([op(1), op(2)])

    actor.send({ type: 'IMPORT_SELECTED' })
    expect(actor.getSnapshot().matches({ move: 'confirming' })).toBe(true)
    actor.send({ type: 'CONFIRM' })
    expect(actor.getSnapshot().context.selected).toEqual([])
    const done = await settledReport(actor)
    expect(outpointsOf(importMany)).toEqual([[op(1), op(2), op(3)]])
    expect(done.context.queue.report).toMatchObject({ tone: 'success', title: '3 items imported' })

    actor.send({ type: 'SELECT', items: [{ outpoint: op(9), group: 'zoo' }], checked: true })
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: false })
    expect(actor.getSnapshot().context.selected).toEqual([])
    actor.send({ type: 'DISMISS' })
    expect(actor.getSnapshot().context.queue.report).toBeNull()
  })

  it('hands the wallet a large selection in chunks and counts every answer', async () => {
    const zoo = Array.from({ length: IMPORT_CHUNK * 2 + 5 }, (_, i) => item(i + 1))
    const { actor, importMany } = start({ zoo })
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    await waitFor(actor, (s) => s.context.selected.length === zoo.length)
    actor.send({ type: 'IMPORT_SELECTED' })
    actor.send({ type: 'CONFIRM' })
    const done = await settledReport(actor)
    expect(outpointsOf(importMany).map((o) => o.length)).toEqual(chunkSizes(zoo.length))
    expect(chunkSizes(zoo.length)).toEqual([...IMPORT_RAMP, IMPORT_CHUNK, 10])
    expect(done.context.queue.report).toMatchObject({ tone: 'success', title: `${zoo.length} items imported` })
  })

  it('stops when the wallet runs out of BSV and keeps the unfunded listed', async () => {
    const zoo = Array.from({ length: IMPORT_CHUNK + 3 }, (_, i) => item(i + 1))
    const { actor, importMany } = start(
      { zoo },
      {
        importMany: async ({ outpoints }) =>
          answer(outpoints, (outpoint) => (outpoint === op(1) ? MOVED : { kind: 'funds', message: 'Add 120 sats.' })),
      },
    )
    actor.send({ type: 'OPEN', group: 'zoo' })
    await waitFor(actor, (s) => s.matches({ page: 'ready' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    await waitFor(actor, (s) => s.context.selected.length === zoo.length)
    actor.send({ type: 'IMPORT_SELECTED' })
    actor.send({ type: 'CONFIRM' })
    const done = await settledReport(actor)
    expect(importMany).toHaveBeenCalledTimes(1)
    expect(done.context.items[0]!.outpoint).toBe(op(2))
    expect(done.context.queue.report).toMatchObject({ outcome: 'funds', body: `1 of ${zoo.length} imported. Add 120 sats.` })
  })

  it('stops a selection on request after the chunk in flight', async () => {
    const held = heldChunks()
    const zoo = Array.from({ length: IMPORT_CHUNK + 3 }, (_, i) => item(i + 1))
    const { actor, importMany } = start({ zoo }, { importMany: held.importMany })
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    await waitFor(actor, (s) => s.context.selected.length === zoo.length)
    actor.send({ type: 'IMPORT_SELECTED' })
    actor.send({ type: 'CONFIRM' })
    actor.send({ type: 'STOP' })
    expect(actor.getSnapshot().context.queue.run).toMatchObject({ waiting: [], stopping: true })
    held.release()
    const done = await settledReport(actor)
    expect(importMany).toHaveBeenCalledTimes(1)
    expect(done.context.queue.report).toMatchObject({ title: 'Import stopped', body: `${IMPORT_RAMP[0]} of ${zoo.length} imported.` })
  })

  it('keeps the item listed when the move throws, and retries a failed check', async () => {
    const sync = vi
      .fn<ImportItemPorts['sync']>()
      .mockRejectedValueOnce(new Error('index down'))
      .mockResolvedValue({ complete: true, total: 1 })
    const { actor } = start(
      { zoo: [item(1)] },
      {
        ports: { sync },
        importMany: async () => {
          throw new Error('Wallet is busy')
        },
      },
    )
    const failed = await waitFor(actor, (s) => s.matches({ sync: 'failed' }))
    expect(failed.context.syncError).toBe('index down')
    actor.send({ type: 'RETRY' })
    await waitFor(actor, (s) => s.matches({ sync: 'done' }))

    actor.send({ type: 'OPEN', group: 'zoo' })
    await waitFor(actor, (s) => s.matches({ page: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: op(1) })
    const done = await settledReport(actor)
    expect(done.context.items.map((i) => i.outpoint)).toEqual([op(1)])
    expect(done.context.queue.report).toMatchObject({ tone: 'danger', title: 'Item 1 not imported', body: 'Wallet is busy' })
  })

  it('says why a hand-over was refused and keeps the selection', async () => {
    const { actor } = start(
      { zoo: [item(1), item(2)] },
      {
        ports: {
          enqueue: () => {
            throw new Error('Unlock this wallet first')
          },
        },
      },
    )
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT', items: [{ outpoint: op(1), group: 'zoo' }], checked: true })
    actor.send({ type: 'IMPORT_SELECTED' })
    expect(actor.getSnapshot().context.selected).toHaveLength(1)
    expect(actor.getSnapshot().context.notice).toMatchObject({ tone: 'danger', body: 'Unlock this wallet first' })
    actor.send({ type: 'DISMISS' })
    expect(actor.getSnapshot().context.notice).toBeNull()
  })
})

describe('import notices', () => {
  it('drops moved and not-an-item rows and keeps every other outcome', () => {
    expect(noticeFor('A', { kind: 'moved', txid: 't' }).keep).toBe(false)
    expect(noticeFor('A', { kind: 'skipped', reason: 'notOneSat' as never, message: 'm' }).keep).toBe(false)
    expect(noticeFor(null, { kind: 'failed', message: 'm' })).toMatchObject({ keep: true, notice: { title: 'Item not imported' } })
  })

  it('summarises a selection by how many moved', () => {
    expect(batchNotice({ total: 4, moved: 4, failure: null, stopped: false }).title).toBe('4 items imported')
    expect(
      batchNotice({
        total: 4,
        moved: 3,
        failure: { tone: 'danger', outcome: 'failed', title: 'B not imported', body: 'boom' },
        stopped: false,
      }),
    ).toMatchObject({ tone: 'danger', title: '3 of 4 imported', body: 'B not imported: boom' })
  })
})
