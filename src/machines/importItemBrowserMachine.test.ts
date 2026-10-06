import { createActor, waitFor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportItem, ImportItemChange, ImportItemResult, ImportItemShelf, ImportItemSync } from '../wallet/import'
import {
  batchNotice,
  importItemBrowserMachine,
  noticeFor,
  selectedPerShelf,
  type ImportItemPorts,
} from './importItemBrowserMachine'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`

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

function start(
  groups: Record<string, ImportItem[]>,
  ports: Partial<ImportItemPorts> = {},
) {
  const list = savedList(groups)
  const syncs: Sync[] = []
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
    importOne: vi.fn(async (_id: string, outpoint: string): Promise<ImportItemResult> => {
      list.drop(outpoint)
      return { kind: 'moved', txid: 'f'.repeat(64) }
    }),
    ...ports,
  }
  const actor = createActor(importItemBrowserMachine, { input: { ports: full, sourceId: 's1' } }).start()
  return { actor, ports: full, list, syncs }
}

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

  it('moves exactly the chosen item, one at a time, and drops it from the list', async () => {
    const { actor, ports } = start({ zoo: [item(1), item(2)] })
    actor.send({ type: 'OPEN', group: 'zoo' })
    await waitFor(actor, (s) => s.matches({ page: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: op(2) })
    expect(actor.getSnapshot().matches({ move: 'importing' })).toBe(true)
    actor.send({ type: 'IMPORT', outpoint: op(1) })
    const done = await waitFor(actor, (s) => s.matches({ move: 'idle' }))
    expect(ports.importOne).toHaveBeenCalledTimes(1)
    expect(ports.importOne).toHaveBeenCalledWith('s1', op(2))
    expect(done.context.items.map((i) => i.outpoint)).toEqual([op(1)])
    expect(done.context.notice).toMatchObject({ tone: 'success', outcome: 'moved', title: 'Item 2 imported' })
  })

  it('selects a whole shelf from disk and imports the selection behind one confirm', async () => {
    const { actor, ports } = start({ zoo: [item(1), item(2)], alpha: [item(3)] })
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    const gathered = await waitFor(actor, (s) => s.matches({ gather: 'idle' }) && s.context.selected.length === 2)
    actor.send({ type: 'SELECT', items: [{ outpoint: op(3), group: 'alpha' }], checked: true })
    expect(selectedPerShelf(actor.getSnapshot().context.selected)).toEqual(new Map([['zoo', 2], ['alpha', 1]]))
    expect(gathered.context.selected.map((s) => s.outpoint)).toEqual([op(1), op(2)])

    actor.send({ type: 'IMPORT_SELECTED' })
    expect(actor.getSnapshot().matches({ move: 'confirming' })).toBe(true)
    actor.send({ type: 'CONFIRM' })
    const done = await waitFor(actor, (s) => s.matches({ move: 'idle' }) && s.context.notice != null)
    expect(vi.mocked(ports.importOne).mock.calls.map(([, outpoint]) => outpoint)).toEqual([op(1), op(2), op(3)])
    expect(done.context.selected).toEqual([])
    expect(done.context.notice).toMatchObject({ tone: 'success', title: '3 items imported' })

    actor.send({ type: 'SELECT', items: [{ outpoint: op(9), group: 'zoo' }], checked: true })
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: false })
    expect(actor.getSnapshot().context.selected).toEqual([])
  })

  it('stops a selection at the first missing-funds answer and keeps the rest selected', async () => {
    const importOne = vi.fn(async (_id: string, outpoint: string): Promise<ImportItemResult> =>
      outpoint === op(2) ? { kind: 'funds', message: 'Add 120 sats.' } : { kind: 'moved', txid: 'f'.repeat(64) },
    )
    const { actor } = start({ zoo: [item(1), item(2), item(3)] }, { importOne })
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    await waitFor(actor, (s) => s.context.selected.length === 3)
    actor.send({ type: 'IMPORT_SELECTED' })
    actor.send({ type: 'CONFIRM' })
    const done = await waitFor(actor, (s) => s.matches({ move: 'idle' }) && s.context.notice != null)
    expect(importOne).toHaveBeenCalledTimes(2)
    expect(done.context.selected.map((s) => s.outpoint)).toEqual([op(3)])
    expect(done.context.notice).toMatchObject({ outcome: 'funds', body: '1 of 3 imported. Add 120 sats.' })
  })

  it('stops a selection on request after the item in flight', async () => {
    let release: () => void = () => undefined
    const importOne = vi.fn(
      () =>
        new Promise<ImportItemResult>((resolve) => {
          release = () => resolve({ kind: 'moved', txid: 'f'.repeat(64) })
        }),
    )
    const { actor } = start({ zoo: [item(1), item(2), item(3)] }, { importOne })
    await waitFor(actor, (s) => s.matches({ shelves: 'idle' }))
    actor.send({ type: 'SELECT_SHELF', group: 'zoo', checked: true })
    await waitFor(actor, (s) => s.context.selected.length === 3)
    actor.send({ type: 'IMPORT_SELECTED' })
    actor.send({ type: 'CONFIRM' })
    actor.send({ type: 'STOP' })
    release()
    const done = await waitFor(actor, (s) => s.matches({ move: 'idle' }) && s.context.notice != null)
    expect(importOne).toHaveBeenCalledTimes(1)
    expect(done.context.notice).toMatchObject({ title: 'Import stopped', body: '1 of 3 imported.' })
  })

  it('keeps the item listed when the move throws, and retries a failed check', async () => {
    const sync = vi
      .fn<ImportItemPorts['sync']>()
      .mockRejectedValueOnce(new Error('index down'))
      .mockResolvedValue({ complete: true, total: 1 })
    const importOne = vi.fn(async (): Promise<ImportItemResult> => {
      throw new Error('Wallet is busy')
    })
    const { actor } = start({ zoo: [item(1)] }, { sync, importOne })
    const failed = await waitFor(actor, (s) => s.matches({ sync: 'failed' }))
    expect(failed.context.syncError).toBe('index down')
    actor.send({ type: 'RETRY' })
    await waitFor(actor, (s) => s.matches({ sync: 'done' }))

    actor.send({ type: 'OPEN', group: 'zoo' })
    await waitFor(actor, (s) => s.matches({ page: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: op(1) })
    const done = await waitFor(actor, (s) => s.matches({ move: 'idle' }) && s.context.notice != null)
    expect(done.context.items.map((i) => i.outpoint)).toEqual([op(1)])
    expect(done.context.notice).toMatchObject({ tone: 'danger', title: 'Item 1 not imported', body: 'Wallet is busy' })
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
