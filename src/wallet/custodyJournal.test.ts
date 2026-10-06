import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
let refuseWrites = false

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (refuseWrites) return false
    store.set(key, value)
    return true
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
    refuseWrites = false
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
})
