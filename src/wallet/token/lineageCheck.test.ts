import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FungibleToken } from './types'

const store = new Map<string, string>()

vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
    return true
  },
}))

type ListModule = typeof import('./list')
type LineageModule = typeof import('./lineage')
type TypesModule = typeof import('./types')
let list: ListModule
let lineage: LineageModule
let types: TypesModule

beforeAll(async () => {
  list = await import('./list')
  lineage = await import('./lineage')
  types = await import('./types')
}, 60_000)

const DEPLOY = `${'d0'.repeat(32)}_0`
const BOUND = `${'b1'.repeat(32)}_0`
const LOOSE = `${'c2'.repeat(32)}_1`

function card(tips: { outpoint: string; amt: string }[]): FungibleToken {
  return {
    tokenId: DEPLOY,
    sym: 'GOLD',
    amt: tips.reduce((sum, tip) => sum + BigInt(tip.amt), 0n).toString(),
    dec: 0,
    utxoCount: tips.length,
    outpoint: tips[0]!.outpoint,
    spendKind: 'plain',
    heldTips: tips.map((tip) => ({
      ...tip,
      tokenId: DEPLOY,
      op: 'transfer' as const,
      sym: 'GOLD',
      dec: 0,
      satoshis: 1,
    })),
  }
}

describe('withLineageCheck (BRC-251 §Verification)', () => {
  beforeEach(() => {
    store.clear()
    lineage.resetTokenLineageForTests()
  })

  it('holds tips no walk has bound out of the balance', () => {
    lineage.rememberProvenTokenTips([BOUND], DEPLOY)
    const row = list.withLineageCheck(card([
      { outpoint: BOUND, amt: '700' },
      { outpoint: LOOSE, amt: '300' },
    ]))
    expect(row.amt).toBe('1000')
    expect(row.checkingAmt).toBe('300')
    expect(types.spendableFungibleAmt(row)).toBe('700')
  })

  it('counts the deploy output itself as bound', () => {
    const row = list.withLineageCheck(card([{ outpoint: DEPLOY, amt: '1000' }]))
    expect(row.checkingAmt).toBeUndefined()
    expect(types.spendableFungibleAmt(row)).toBe('1000')
  })

  it('releases the units once the heal binds the tip, and returns the same row when nothing moved', () => {
    const checking = list.withLineageCheck(card([{ outpoint: LOOSE, amt: '300' }]))
    expect(types.spendableFungibleAmt(checking)).toBe('0')
    expect(list.withLineageCheck(checking)).toBe(checking)
    lineage.rememberProvenTokenTips([LOOSE], DEPLOY)
    const bound = list.withLineageCheck(checking)
    expect(bound.checkingAmt).toBeUndefined()
    expect(types.spendableFungibleAmt(bound)).toBe('300')
  })

  it('a card carries its tips\' layout so the old format can be labelled', () => {
    const tips = card([{ outpoint: LOOSE, amt: '300' }]).heldTips!
    const [old] = types.aggregateFungibles(tips.map((tip) => ({ ...tip, layout: 'draft-tagged' as const })))
    expect(old!.layout).toBe('draft-tagged')
    const [current] = types.aggregateFungibles(tips.map((tip) => ({ ...tip, layout: 'brc162' as const })))
    expect(current!.layout).toBe('brc162')
  })

  it('a walk that reached another deploy does not bind the tip', () => {
    lineage.rememberProvenTokenTips([LOOSE], `${'ee'.repeat(32)}_0`)
    const row = list.withLineageCheck(card([{ outpoint: LOOSE, amt: '300' }]))
    expect(row.checkingAmt).toBe('300')
  })
})
