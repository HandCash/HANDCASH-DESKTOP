import { createActor, waitFor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import type { ImportItem, ImportItemResult } from '../wallet/import'
import {
  IMPORT_ITEM_PAGE,
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

function start(ports: Partial<ImportItemPorts>, items = [item(1), item(2)]) {
  const full: ImportItemPorts = {
    list: vi.fn(async () => ({ items, complete: true })),
    importOne: vi.fn(async (): Promise<ImportItemResult> => ({ kind: 'moved', txid: 'f'.repeat(64) })),
    ...ports,
  }
  const actor = createActor(importItemBrowserMachine, { input: { ports: full, sourceId: 's1' } }).start()
  return { actor, ports: full }
}

describe('importItemBrowserMachine', () => {
  it('lists, then moves exactly the chosen item and drops it from the list', async () => {
    const { actor, ports } = start({})
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'IMPORT', outpoint: item(2).outpoint })
    expect(actor.getSnapshot().matches('importing')).toBe(true)
    actor.send({ type: 'IMPORT', outpoint: item(1).outpoint })
    const done = await waitFor(actor, (s) => s.matches('ready'))
    expect(ports.importOne).toHaveBeenCalledTimes(1)
    expect(ports.importOne).toHaveBeenCalledWith('s1', item(2))
    expect(done.context.items).toEqual([item(1)])
    expect(done.context.notice).toMatchObject({ tone: 'success', outcome: 'moved' })
  })

  it('ignores an item that is not listed', async () => {
    const { actor, ports } = start({})
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'IMPORT', outpoint: item(9).outpoint })
    expect(actor.getSnapshot().matches('ready')).toBe(true)
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
    await waitFor(actor, (s) => s.matches('ready'))
    const tones: string[] = []
    for (let i = 0; i < 4; i += 1) {
      actor.send({ type: 'IMPORT', outpoint: item(1).outpoint })
      const snap = await waitFor(actor, (s) => s.matches('ready'))
      tones.push(`${snap.context.notice?.outcome}:${snap.context.notice?.tone}:${snap.context.items.length}`)
    }
    expect(tones).toEqual(['funds:warning:2', 'refused:warning:2', 'failed:danger:2', 'skipped:warning:1'])
  })

  it('turns a thrown move into a danger notice and keeps the row', async () => {
    const { actor } = start({ importOne: vi.fn(async () => Promise.reject(new Error('offline'))) })
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'IMPORT', outpoint: item(1).outpoint })
    const snap = await waitFor(actor, (s) => s.matches('ready'))
    expect(snap.context.notice).toMatchObject({ tone: 'danger', body: 'offline' })
    expect(snap.context.items).toHaveLength(2)
  })

  it('fails closed on a list error and retries', async () => {
    const list = vi
      .fn<ImportItemPorts['list']>()
      .mockRejectedValueOnce(new Error('Scan this wallet first'))
      .mockResolvedValueOnce({ items: [item(1)], complete: false })
    const { actor } = start({ list })
    const failed = await waitFor(actor, (s) => s.matches('failed'))
    expect(failed.context.error).toBe('Scan this wallet first')
    actor.send({ type: 'RETRY' })
    const ready = await waitFor(actor, (s) => s.matches('ready'))
    expect(ready.context).toMatchObject({ complete: false, items: [item(1)] })
  })

  it('pages and filters by name', async () => {
    const many = Array.from({ length: 60 }, (_, i) => item(i + 1, i === 41 ? 'Golden Fox' : `Item ${i + 1}`))
    const { actor } = start({}, many)
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'MORE' })
    expect(actor.getSnapshot().context.shown).toBe(IMPORT_ITEM_PAGE * 2)
    actor.send({ type: 'FILTER', query: 'fox' })
    const snap = actor.getSnapshot()
    expect(snap.context.shown).toBe(IMPORT_ITEM_PAGE)
    expect(filteredImportItems(snap.context).map((i) => i.name)).toEqual(['Golden Fox'])
  })
})
