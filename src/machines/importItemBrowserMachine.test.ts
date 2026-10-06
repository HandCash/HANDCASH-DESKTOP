import { createActor, waitFor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import type { ImportItem, ImportItemList, ImportItemResult } from '../wallet/import'
import {
  filteredImportItems,
  importItemBrowserMachine,
  type ImportItemPorts,
} from './importItemBrowserMachine'

const item = (n: number, name: string | null = `Item ${n}`): ImportItem => ({
  outpoint: `${n.toString(16).padStart(64, '0')}_0`,
  address: '1addr',
  origin: null,
  media: null,
  name,
  mimeType: null,
  imageUrl: null,
})

function listing(items: ImportItem[]): ImportItemPorts['list'] {
  return async (_sourceId, onItems) => {
    onItems(items)
    return { items, complete: true }
  }
}

function start(ports: Partial<ImportItemPorts>, items = [item(1), item(2)]) {
  const full: ImportItemPorts = {
    list: vi.fn(listing(items)),
    importOne: vi.fn(async (): Promise<ImportItemResult> => ({ kind: 'moved', txid: 'f'.repeat(64) })),
    ...ports,
  }
  const actor = createActor(importItemBrowserMachine, { input: { ports: full, sourceId: 's1' } }).start()
  return { actor, ports: full }
}

describe('importItemBrowserMachine', () => {
  it('lists, then moves exactly the chosen item and drops it from the list', async () => {
    const { actor, ports } = start({})
    await waitFor(actor, (s) => s.matches({ list: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: item(2).outpoint })
    expect(actor.getSnapshot().matches({ move: 'importing' })).toBe(true)
    actor.send({ type: 'IMPORT', outpoint: item(1).outpoint })
    const done = await waitFor(actor, (s) => s.matches({ move: 'idle' }))
    expect(ports.importOne).toHaveBeenCalledTimes(1)
    expect(ports.importOne).toHaveBeenCalledWith('s1', item(2))
    expect(done.context.items).toEqual([item(1)])
    expect(done.context.notice).toMatchObject({ tone: 'success', outcome: 'moved' })
  })

  it('streams batches in and lets an item move before the list finishes', async () => {
    let push: (items: ImportItem[]) => void = () => undefined
    let finish: (list: ImportItemList) => void = () => undefined
    const list = vi.fn<ImportItemPorts['list']>(
      (_id, onItems) =>
        new Promise((resolve) => {
          push = onItems
          finish = resolve
        }),
    )
    const { actor } = start({ list })
    await waitFor(actor, () => list.mock.calls.length > 0)
    push([item(1)])
    expect(actor.getSnapshot().context.items).toEqual([item(1)])
    actor.send({ type: 'IMPORT', outpoint: item(1).outpoint })
    await waitFor(actor, (s) => s.matches({ move: 'idle' }) && s.context.notice !== null)
    push([item(1), item(2)])
    expect(actor.getSnapshot().context.items).toEqual([item(2)])
    finish({ items: [item(2)], complete: false })
    const ready = await waitFor(actor, (s) => s.matches({ list: 'ready' }))
    expect(ready.context.complete).toBe(false)
  })

  it('stops the search when the browser closes', async () => {
    let shouldStop: () => boolean = () => false
    const list = vi.fn<ImportItemPorts['list']>((_id, _onItems, stop) => {
      shouldStop = stop
      return new Promise(() => undefined)
    })
    const { actor } = start({ list })
    await waitFor(actor, () => list.mock.calls.length > 0)
    expect(shouldStop()).toBe(false)
    actor.stop()
    expect(shouldStop()).toBe(true)
  })

  it('ignores an item that is not listed', async () => {
    const { actor, ports } = start({})
    await waitFor(actor, (s) => s.matches({ list: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: item(9).outpoint })
    expect(actor.getSnapshot().matches({ move: 'idle' })).toBe(true)
    expect(ports.importOne).not.toHaveBeenCalled()
  })

  it('keeps the row on a fixable outcome and drops it when it is not an item', async () => {
    const results: ImportItemResult[] = [
      { kind: 'funds', message: 'low' },
      { kind: 'refused', reason: 'pausedBatch', message: 'paused' },
      { kind: 'failed', message: 'rejected' },
      { kind: 'skipped', reason: 'token', message: 'a token' },
    ]
    const importOne = vi.fn(async () => results.shift()!)
    const { actor } = start({ importOne })
    await waitFor(actor, (s) => s.matches({ list: 'ready' }))
    const tones: string[] = []
    for (let i = 0; i < 4; i += 1) {
      actor.send({ type: 'IMPORT', outpoint: item(1).outpoint })
      const snap = await waitFor(actor, (s) => s.matches({ move: 'idle' }) && s.context.importing === null)
      tones.push(`${snap.context.notice?.outcome}:${snap.context.notice?.tone}:${snap.context.items.length}`)
    }
    expect(tones).toEqual(['funds:warning:2', 'refused:warning:2', 'failed:danger:2', 'skipped:warning:1'])
  })

  it('turns a thrown move into a danger notice and keeps the row', async () => {
    const { actor } = start({ importOne: vi.fn(async () => Promise.reject(new Error('offline'))) })
    await waitFor(actor, (s) => s.matches({ list: 'ready' }))
    actor.send({ type: 'IMPORT', outpoint: item(1).outpoint })
    const snap = await waitFor(actor, (s) => s.matches({ move: 'idle' }) && s.context.notice !== null)
    expect(snap.context.notice).toMatchObject({ tone: 'danger', body: 'offline' })
    expect(snap.context.items).toHaveLength(2)
  })

  it('fails closed on a list error and retries', async () => {
    const list = vi
      .fn<ImportItemPorts['list']>()
      .mockRejectedValueOnce(new Error('Scan this wallet first'))
      .mockImplementationOnce(listing([item(1)]))
    const { actor } = start({ list })
    const failed = await waitFor(actor, (s) => s.matches({ list: 'failed' }))
    expect(failed.context.error).toBe('Scan this wallet first')
    actor.send({ type: 'RETRY' })
    const ready = await waitFor(actor, (s) => s.matches({ list: 'ready' }))
    expect(ready.context.items).toEqual([item(1)])
  })

  it('filters by name', async () => {
    const many = Array.from({ length: 60 }, (_, i) => item(i + 1, i === 41 ? 'Golden Fox' : `Item ${i + 1}`))
    const { actor } = start({}, many)
    await waitFor(actor, (s) => s.matches({ list: 'ready' }))
    actor.send({ type: 'FILTER', query: 'fox' })
    expect(filteredImportItems(actor.getSnapshot().context).map((i) => i.name)).toEqual(['Golden Fox'])
  })
})
