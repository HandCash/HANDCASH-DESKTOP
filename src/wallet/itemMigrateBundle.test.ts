import { describe, expect, it } from 'vitest'
import { Beef, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { IMPORT_CHUNK } from '../machines/importQueueMachine'
import {
  MAX_ITEMS_PER_MIGRATE_TX,
  chooseItemMigrateUnit,
  itemsWithinSourceBudget,
  migratePackage,
  migrateSourceCosts,
  splitItemMigrateBundle,
} from './itemMigrateBundle'

describe('chooseItemMigrateUnit', () => {
  it('refuses an empty page by name', () => {
    expect(chooseItemMigrateUnit([])).toEqual({ kind: 'refuse', reason: 'empty' })
  })

  it('sends a lone tip as a single', () => {
    expect(chooseItemMigrateUnit(['a'])).toEqual({ kind: 'single', item: 'a' })
  })

  it('bundles in page order up to the requested size', () => {
    const unit = chooseItemMigrateUnit(['a', 'b', 'c', 'd'], 3)
    expect(unit).toEqual({ kind: 'bundle', items: ['a', 'b', 'c'] })
  })

  it('never exceeds the per-transaction ceiling', () => {
    const items = Array.from({ length: 200 }, (_, i) => i)
    const unit = chooseItemMigrateUnit(items, 999)
    expect(unit.kind).toBe('bundle')
    if (unit.kind !== 'bundle') return
    expect(unit.items).toHaveLength(MAX_ITEMS_PER_MIGRATE_TX)
  })

  it('degrades to singles when asked for one per transaction', () => {
    expect(chooseItemMigrateUnit(['a', 'b'], 1)).toEqual({ kind: 'single', item: 'a' })
  })
})

describe('splitItemMigrateBundle', () => {
  it('halves a rejected bundle, larger half first', () => {
    expect(splitItemMigrateBundle(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']])
  })

  it('bottoms out at a single tip', () => {
    expect(splitItemMigrateBundle(['a'])).toEqual([['a'], []])
  })

  it('reaches every tip after repeated splits', () => {
    let pending = [['a', 'b', 'c', 'd', 'e']]
    const singles: string[] = []
    let guard = 0
    while (pending.length > 0 && guard < 50) {
      guard += 1
      const next: string[][] = []
      for (const group of pending) {
        if (group.length === 1) {
          singles.push(group[0]!)
          continue
        }
        const [left, right] = splitItemMigrateBundle(group)
        next.push(left, right)
      }
      pending = next.filter((g) => g.length > 0)
    }
    expect(singles.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('bundle ceiling', () => {
  it('moves a whole import chunk in one transaction', () => {
    expect(MAX_ITEMS_PER_MIGRATE_TX).toBe(IMPORT_CHUNK)
  })
})

describe('itemsWithinSourceBudget', () => {
  const cost = (bytes: Record<string, number>) => (item: string) =>
    item.split('+').map((txid) => ({ txid, bytes: bytes[txid] ?? 0 }))

  it('takes the whole chunk when sources are small', () => {
    const items = Array.from({ length: 100 }, (_, i) => `t${i}`)
    expect(itemsWithinSourceBudget(items, 100, () => [{ txid: 'x', bytes: 1 }], 10)).toBe(100)
  })

  it('stops before the tip that would overflow the package', () => {
    expect(itemsWithinSourceBudget(['a', 'b', 'c'], 100, cost({ a: 40, b: 40, c: 40 }), 100)).toBe(2)
  })

  it('counts a shared source once', () => {
    expect(itemsWithinSourceBudget(['a+s', 'b+s', 'c+s'], 100, cost({ a: 10, b: 10, c: 10, s: 60 }), 100)).toBe(3)
  })

  it('still moves one oversized tip alone', () => {
    expect(itemsWithinSourceBudget(['big', 'b'], 100, cost({ big: 1_000, b: 1 }), 100)).toBe(1)
  })

  it('honours a halved bundle size', () => {
    expect(itemsWithinSourceBudget(['a', 'b', 'c', 'd'], 2, cost({}), 100)).toBe(2)
  })
})

const KEY = PrivateKey.fromHex('22'.repeat(32))

function deposit(nonce: number, parent?: Transaction): Transaction {
  const tx = new Transaction()
  if (parent) tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(KEY.toAddress()) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(KEY.toAddress()) })
  tx.addOutput({ satoshis: nonce, lockingScript: new P2PKH().lock(KEY.toAddress()) })
  return tx
}

function mined(tx: Transaction, height: number): Transaction {
  tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: tx.id('hex'), txid: true }]])
  return tx
}

describe('itemsWithinSourceBudget over one large shared source', () => {
  it('bundles every tip of a source larger than the budget, since it is counted once', () => {
    const tips = Array.from({ length: 31 }, (_, vout) => ({ txid: 'aa'.repeat(32), vout }))
    expect(itemsWithinSourceBudget(tips, 100, (t) => [{ txid: t.txid, bytes: 550_000 }])).toBe(31)
  })

  it('still stops before a second large source', () => {
    const tips = [{ txid: 'aa'.repeat(32) }, { txid: 'aa'.repeat(32) }, { txid: 'bb'.repeat(32) }]
    expect(itemsWithinSourceBudget(tips, 100, (t) => [{ txid: t.txid, bytes: 550_000 }])).toBe(2)
  })
})

describe('migrateSourceCosts', () => {
  it('charges a mined source its body and proof, and an unmined one its parents too', () => {
    const parent = mined(deposit(1), 800_000)
    const minedTip = mined(deposit(2), 800_001)
    const mempoolTip = deposit(3, parent)
    const beef = new Beef()
    beef.mergeTransaction(minedTip)
    beef.mergeTransaction(mempoolTip)
    const costOf = migrateSourceCosts(beef.toBinary())

    const own = costOf(minedTip.id('hex'))
    expect(own).toEqual([{ txid: minedTip.id('hex'), bytes: minedTip.toBinary().length + minedTip.merklePath!.toBinary().length }])
    expect(costOf(mempoolTip.id('hex')).map((c) => c.txid)).toEqual([mempoolTip.id('hex'), parent.id('hex')])
    expect(costOf(mempoolTip.id('hex'))[1]!.bytes).toBeGreaterThan(parent.toBinary().length)
  })

  it('charges nothing it cannot read, so an unreadable package never blocks a bundle', () => {
    expect(migrateSourceCosts([1, 2, 3])('ab'.repeat(32))).toEqual([{ txid: 'ab'.repeat(32), bytes: 0 }])
  })
})

describe('migratePackage', () => {
  it('ships the signed transaction with only the sources it spends', () => {
    const spent = mined(deposit(10), 800_010)
    const other = mined(deposit(11), 800_011)
    const sweep = deposit(12, spent)
    const packed = new Beef()
    packed.mergeTransaction(spent)
    packed.mergeTransaction(other)
    packed.mergeTransaction(sweep)

    const sent = Beef.fromBinary(migratePackage(packed, sweep.id('hex')))
    expect(sent.atomicTxid).toBe(sweep.id('hex'))
    expect(sent.txs.map((t) => t.txid).sort()).toEqual([spent.id('hex'), sweep.id('hex')].sort())
    expect(sent.isValid()).toBe(true)
  })
})
