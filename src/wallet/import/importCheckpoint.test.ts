import { beforeEach, describe, expect, it, vi } from 'vitest'
const disk = new Map<string, string>()
let refuse: ((key: string) => boolean) | null = null
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => disk.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (refuse?.(key)) return false
    disk.set(key, value)
    return true
  },
}))
import { ImportCheckpoint, CHECKPOINT_SLICE } from './importCheckpoint'
const owner = { identityKey: 'synthetic', accountIndex: 0, chain: 'main' as const }
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ outpoint: `${i.toString(16).padStart(64, '0')}_0`, name: null }))
beforeEach(() => { disk.clear(); refuse = null })

describe('durable chosen imports', () => {
  it('replays a crash, deduplicates resume, and records only settled work', () => {
    new ImportCheckpoint(owner).enqueue('source', items(250))
    const restarted = new ImportCheckpoint(owner)
    restarted.enqueue('source', items(250))
    restarted.settled('source', items(100).map((i) => i.outpoint))
    expect(new ImportCheckpoint(owner).entries()).toEqual([{ sourceId: 'source', items: items(250).slice(100) }])
    expect([...disk.values()].filter((v) => v.startsWith('{')).every((v) => JSON.parse(v).items.length <= CHECKPOINT_SLICE)).toBe(true)
  })

  it.each([
    { ...owner, identityKey: 'other' },
    { ...owner, accountIndex: 1 },
    { ...owner, chain: 'test' as const },
  ])('never adopts another account or chain checkpoint: %j', (other) => {
    new ImportCheckpoint(owner).enqueue('same-source', items(2))
    expect(new ImportCheckpoint(other).entries()).toEqual([])
  })

  it('keeps committed work when a crash leaves an uncommitted segment', () => {
    const checkpoint = new ImportCheckpoint(owner)
    checkpoint.enqueue('source', items(100))
    refuse = (key) => !/:\d+$/.test(key)
    expect(() => checkpoint.enqueue('source', items(101))).toThrow('could not be saved')
    refuse = null
    const restarted = new ImportCheckpoint(owner)
    expect(restarted.entries()[0]!.items).toHaveLength(100)
    restarted.enqueue('source', items(101))
    expect(new ImportCheckpoint(owner).entries()[0]!.items).toHaveLength(101)
  })

  it('fails closed for missing committed data and storage refusal', () => {
    const checkpoint = new ImportCheckpoint(owner)
    refuse = () => true
    expect(() => checkpoint.enqueue('source', items(1))).toThrow('could not be saved')
    expect(checkpoint.entries()).toEqual([])
    refuse = null
    checkpoint.enqueue('source', items(1))
    disk.delete([...disk.keys()].find((k) => k.endsWith(':0'))!)
    expect(() => new ImportCheckpoint(owner)).toThrow('segment is missing')
  })

  it('merges a late completion without overwriting a newer queue instance', () => {
    const old = new ImportCheckpoint(owner)
    old.enqueue('source', items(2))
    const resumed = new ImportCheckpoint(owner)
    resumed.enqueue('source', items(3))
    old.settled('source', [items(1)[0]!.outpoint])
    resumed.settled('source', [items(2)[1]!.outpoint])
    expect(new ImportCheckpoint(owner).entries()).toEqual([{ sourceId: 'source', items: items(3).slice(2) }])
  })

  it('durably stops waiting work without touching signed transactions', () => {
    const checkpoint = new ImportCheckpoint(owner)
    checkpoint.enqueue('source', items(2))
    checkpoint.stop('source')
    expect(new ImportCheckpoint(owner).entries()).toEqual([])
  })
})
