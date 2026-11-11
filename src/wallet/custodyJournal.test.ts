import { beforeEach, describe, expect, it, vi } from 'vitest'

import { shouldWipeHandcashKey } from './wipePolicy'

const store = new Map<string, string>()
const writes: Array<{ key: string; bytes: number }> = []
let refuseWrites = false
let refuseKey: ((key: string) => boolean) | null = null

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (refuseWrites || refuseKey?.(key)) return false
    store.set(key, value)
    writes.push({ key, bytes: value.length })
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
}))

const alice = { identityKey: '02' + 'a1'.repeat(32), accountIndex: 0, chain: 'main' as const }
const aliceSub = { ...alice, accountIndex: 1 }
const txA = 'aa'.repeat(32)
const txB = 'bb'.repeat(32)
const pay = (prefix: string, sender?: string) =>
  ({ p: 'wallet payment', prefix, suffix: 's', ...(sender ? { sender } : {}) }) as const

async function load() {
  vi.resetModules()
  return import('./custodyJournal')
}

describe('custody journal', () => {
  beforeEach(() => {
    store.clear()
    writes.length = 0
    refuseWrites = false
    refuseKey = null
  })

  it('appends each distinct entry once and survives a reload', async () => {
    const j = await load()
    const entry = { k: 'out', op: `${txA}_0`, sats: 500, r: pay('p') }
    expect(j.appendCustody(alice, [entry, entry])).toEqual({ added: 1, ok: true })
    expect(j.appendCustody(alice, [{ ...entry, op: `${txA}.0` }]).added).toBe(0)
    const reloaded = await load()
    expect(reloaded.custodyRecipeFor(alice, `${txA}.0`)).toEqual({ sats: 500, r: pay('p') })
  })

  it('names the set by its root: the same entries in any order give the same root', async () => {
    const j = await load()
    const a = { k: 'out', op: `${txA}.0`, sats: 1, r: pay('p') }
    const b = { k: 'out', op: `${txB}.1`, sats: 2, r: { p: 'basket insertion', basket: '1sat', tags: ['z', 'a', 'a'] } }
    j.appendCustody(alice, [a, b])
    const root = j.custodyJournalRoot(alice)
    store.clear()
    j.forgetCustodyJournalCache()
    j.appendCustody(alice, [b])
    j.appendCustody(alice, [a])
    expect(j.custodyJournalRoot(alice)).toBe(root)
    expect(j.custodyRecipeFor(alice, `${txB}.1`)?.r).toEqual({ p: 'basket insertion', basket: '1sat', tags: ['a', 'z'] })
  })

  it('lets a wallet-payment recipe outrank a basket recipe for the same outpoint', async () => {
    const j = await load()
    const op = `${txA}.2`
    j.appendCustody(alice, [{ k: 'out', op, sats: 9, r: pay('p') }])
    j.appendCustody(alice, [{ k: 'out', op, sats: 9, r: { p: 'basket insertion', basket: 'x' } }])
    expect(j.custodyRecipeFor(alice, op)?.r.p).toBe('wallet payment')
  })

  it('drops a self sender and refuses recipes internalizeAction cannot replay', async () => {
    const j = await load()
    j.appendCustody(alice, [
      { k: 'out', op: `${txA}.0`, sats: 1, r: pay('p', alice.identityKey) },
      { k: 'out', op: `${txA}.1`, sats: 1, r: { p: 'basket insertion', basket: 'default' } },
      { k: 'out', op: `${txA}.2`, sats: 1, r: { p: 'wallet payment', prefix: '', suffix: 's' } },
      { k: 'out', op: 'nonsense', sats: 1, r: pay('p') },
    ])
    expect(j.custodyEntries(alice)).toEqual([{ k: 'out', op: `${txA}.0`, sats: 1, r: pay('p') }])
  })

  it('retires an output only on a spend, and a release only for basket recipes', async () => {
    const j = await load()
    j.appendCustody(alice, [
      { k: 'out', op: `${txA}.0`, sats: 100, r: pay('p') },
      { k: 'out', op: `${txA}.1`, sats: 1, r: { p: 'basket insertion', basket: '1sat' } },
      { k: 'out', op: `${txB}.0`, sats: 50, r: pay('q') },
    ])
    j.appendCustody(alice, [
      { k: 'released', op: `${txA}.0` },
      { k: 'released', op: `${txA}.1` },
      { k: 'spent', op: `${txB}.0` },
    ])
    expect(j.unspentCustodyOutputs(alice).map((o) => o.op)).toEqual([`${txA}.0`])
    expect(j.custodyJournalSummary(alice)).toMatchObject({ recipes: 3, spent: 1, unspentSats: 100 })
  })

  it('keeps swap locks apart from BSV recipes, refusing malformed ones and keeping only a whole refund', async () => {
    const j = await load()
    const swapId = 'cd'.repeat(16)
    const lock = { p: 'swap lock', chain: 'LTC', swapId, role: 'taker', side: 'own', terms: '{"v":1}' }
    const refund = { to: '76a9' + '00'.repeat(20) + '88ac', value: '99960', prefix: 'p', suffix: 's', cosig: '30' + 'ab'.repeat(35) }
    j.appendCustody(alice, [
      { k: 'out', op: `${txA}.0`, sats: 100_000, r: lock },
      { k: 'out', op: `${txA}.1`, sats: 500, r: { ...lock, chain: 'bsv', side: 'fee', refund } },
      { k: 'out', op: `${txA}.2`, sats: 500, r: { ...lock, chain: 'bsv', refund: { ...refund, cosig: 'zz' } } },
      { k: 'out', op: `${txA}.3`, sats: 1, r: { ...lock, role: 'judge' } },
      { k: 'out', op: `${txA}.4`, sats: 1, r: { ...lock, swapId: 'short' } },
      { k: 'out', op: `${txA}.5`, sats: 1, r: { ...lock, terms: '' } },
      { k: 'out', op: `${txB}.0`, sats: 50, r: pay('q') },
    ])
    const swaps = j.unspentSwapCustody(alice)
    expect(swaps.map((s) => s.op)).toEqual([`${txA}.0`, `${txA}.1`, `${txA}.2`])
    expect(swaps[0]!.r).toEqual({ ...lock, chain: 'ltc' })
    expect(swaps[1]!.r.refund).toEqual(refund)
    expect(swaps[2]!.r.refund).toBeUndefined()
    const bsv = j.custodyEntries(alice).flatMap((e) => (e.k === 'out' && j.isBsvRecipe(e.r) ? [e.op] : []))
    expect(bsv).toEqual([`${txB}.0`])
    j.appendCustody(alice, [{ k: 'spent', op: `${txA}.0` }])
    expect(j.unspentSwapCustody(alice).map((s) => s.op)).toEqual([`${txA}.1`, `${txA}.2`])
  })

  it("keeps a peer lock's presigned claim, with its self-payment only when whole", async () => {
    const j = await load()
    const swapId = 'cd'.repeat(16)
    const peer = { p: 'swap lock', chain: 'bsv', swapId, role: 'maker', side: 'peer', terms: '{"v":2}' }
    const claim = { hex: 'ab'.repeat(200), at: 120, prefix: 'p', suffix: 's' }
    j.appendCustody(alice, [
      { k: 'out', op: `${txA}.0`, sats: 1000, r: { ...peer, claim } },
      { k: 'out', op: `${txA}.1`, sats: 1000, r: { ...peer, claim: { ...claim, suffix: '' } } },
      { k: 'out', op: `${txA}.2`, sats: 1000, r: { ...peer, claim: { ...claim, at: 190 } } },
      { k: 'out', op: `${txA}.3`, sats: 1000, r: { ...peer, side: 'own', claim } },
    ])
    const swaps = j.unspentSwapCustody(alice)
    expect(swaps.map((s) => s.r.claim)).toEqual([claim, { hex: claim.hex, at: 120 }, undefined, undefined])
  })

  it('keeps each vault account in its own journal', async () => {
    const j = await load()
    j.appendCustody(alice, [{ k: 'out', op: `${txA}.0`, sats: 1, r: pay('p') }])
    expect(j.custodyEntries(aliceSub)).toHaveLength(0)
  })

  it('holds refused writes in memory and persists them with the next append', async () => {
    const j = await load()
    refuseWrites = true
    expect(j.appendCustody(alice, [{ k: 'out', op: `${txA}.0`, sats: 1, r: pay('p') }]).ok).toBe(false)
    refuseWrites = false
    j.appendCustody(alice, [{ k: 'out', op: `${txB}.0`, sats: 1, r: pay('q') }])
    const reloaded = await load()
    expect(reloaded.custodyEntries(alice)).toHaveLength(2)
  })

  it('tells listeners when the journal grew, and only then', async () => {
    const j = await load()
    const heard = vi.fn()
    j.onCustodyJournalGrew(heard)
    const entry = { k: 'out', op: `${txA}.0`, sats: 1, r: pay('p') }
    j.appendCustody(alice, [entry])
    j.appendCustody(alice, [entry])
    expect(heard).toHaveBeenCalledTimes(1)
  })

  const keyOf = (base: string) => `${base}:wallet:main:0:${alice.identityKey}`
  const BASE = keyOf('handcash.custodyJournal.v1')
  const outAt = (i: number) => ({ k: 'out', op: `${txA}.${i}`, sats: i + 1, r: pay(`p${i}`) })

  it('writes each append as its own small segment, never rewriting what is stored', async () => {
    const j = await load()
    for (let i = 0; i < 10; i++) j.appendCustody(alice, [outAt(i)])
    expect(writes).toHaveLength(10)
    expect(new Set(writes.map((w) => w.key)).size).toBe(10)
    const first = writes[0]!.bytes
    for (const w of writes) expect(w.bytes).toBeLessThan(first * 1.2)
    const reloaded = await load()
    expect(reloaded.custodyEntries(alice).map((e) => e.op)).toEqual(Array.from({ length: 10 }, (_, i) => `${txA}.${i}`))
  })

  it('reads a journal stored whole before segments, and adds to it without rewriting it', async () => {
    const j = await load()
    j.appendCustody(alice, [outAt(0), outAt(1)])
    const whole = JSON.stringify({ v: 1, e: j.custodyEntries(alice) })
    store.clear()
    store.set(BASE, whole)
    const old = await load()
    expect(old.custodyEntries(alice)).toHaveLength(2)
    old.appendCustody(alice, [outAt(2)])
    expect(store.get(BASE)).toBe(whole)
    expect((await load()).custodyEntries(alice)).toHaveLength(3)
  })

  it('folds segments into one file with the same root, and keeps them when the fold is refused', async () => {
    const j = await load()
    for (let i = 0; i < 31; i++) j.appendCustody(alice, [outAt(i)])
    const root = j.custodyJournalRoot(alice)
    refuseKey = (key) => key === BASE
    j.appendCustody(alice, [outAt(31)])
    expect(store.size).toBe(32)
    refuseKey = null
    for (let i = 32; i < 40; i++) j.appendCustody(alice, [outAt(i)])
    expect([...store.keys()]).toEqual([BASE])
    const reloaded = await load()
    expect(reloaded.custodyEntries(alice)).toHaveLength(40)
    expect(reloaded.custodyJournalRoot(alice)).toBe(j.custodyJournalRoot(alice))
    expect(reloaded.custodyJournalRoot(alice)).not.toBe(root)
    reloaded.appendCustody(alice, [outAt(40)])
    expect([...store.keys()].sort()).toEqual([BASE, keyOf('handcash.custodyJournal.v1.s1')].sort())
  })

  it('loses nothing when a fold stops after the base is written', async () => {
    const j = await load()
    for (let i = 0; i < 5; i++) j.appendCustody(alice, [outAt(i)])
    const all = j.custodyEntries(alice)
    store.set(BASE, JSON.stringify({ v: 1, e: all }))
    store.delete(keyOf('handcash.custodyJournal.v1.s5'))
    const reloaded = await load()
    expect(reloaded.custodyEntries(alice)).toEqual(all)
    expect(reloaded.custodyJournalRoot(alice)).toBe(j.custodyJournalRoot(alice))
  })

  it('keeps every journal file across a wallet wipe', async () => {
    const j = await load()
    for (let i = 0; i < 3; i++) j.appendCustody(alice, [outAt(i)])
    const sub = { ...alice, identityKey: '02' + 'b2'.repeat(32) }
    j.appendCustody(sub, [outAt(0)])
    expect(store.size).toBe(4)
    for (const key of store.keys()) expect(shouldWipeHandcashKey(key)).toBe(false)
  })
})
