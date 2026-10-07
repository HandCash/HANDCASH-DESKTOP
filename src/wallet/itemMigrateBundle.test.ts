import { describe, expect, it } from 'vitest'
import { Beef, LockingScript, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { IMPORT_CHUNK } from '../machines/importQueueMachine'
import {
  MAX_ITEMS_PER_MIGRATE_TX,
  chooseItemMigrateUnit,
  itemsWithinPostBudget,
  migrateInputBeef,
  migratePackage,
  migrateRetryBody,
  migrateTipPostBytes,
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

describe('itemsWithinPostBudget', () => {
  const bytes = (sizes: Record<string, number>) => (item: string) => sizes[item] ?? 0

  it('takes the whole chunk when tips are plain P2PKH', () => {
    const items = Array.from({ length: MAX_ITEMS_PER_MIGRATE_TX }, (_, i) => `t${i}`)
    expect(itemsWithinPostBudget(items, MAX_ITEMS_PER_MIGRATE_TX, () => migrateTipPostBytes(25))).toBe(MAX_ITEMS_PER_MIGRATE_TX)
  })

  it('stops before the tip that would overflow the post', () => {
    expect(itemsWithinPostBudget(['a', 'b', 'c'], 100, bytes({ a: 40, b: 40, c: 40 }), 100)).toBe(2)
  })

  it('still moves one oversized tip alone', () => {
    expect(itemsWithinPostBudget(['big', 'b'], 100, bytes({ big: 1_000, b: 1 }), 100)).toBe(1)
  })

  it('honours a halved bundle size', () => {
    expect(itemsWithinPostBudget(['a', 'b', 'c', 'd'], 2, bytes({}), 100)).toBe(2)
  })
})

describe('migrateTipPostBytes', () => {
  const inscribed = (artBytes: number) =>
    LockingScript.fromBinary([...new P2PKH().lock(KEY.toAddress()).toBinary(), 0x00, 0x63, 0x4e, ...le32(artBytes), ...new Array(artBytes).fill(7), 0x68])

  function le32(n: number): number[] {
    return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
  }

  it('bounds what Arcade receives: the spent scripts, never the parents that minted them', async () => {
    const art = [40_000, 300, 70_000]
    const mint = new Transaction()
    for (const size of art) mint.addOutput({ satoshis: 1, lockingScript: inscribed(size) })
    mint.addOutput({ satoshis: 5_000, lockingScript: inscribed(500_000) })
    const migrate = new Transaction()
    art.forEach((_, vout) =>
      migrate.addInput({ sourceTransaction: mint, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(KEY) }),
    )
    art.forEach(() => migrate.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(KEY.toAddress()) }))
    await migrate.sign()

    const framing = 4 + 6 + 1 + 1 + 4
    const ef = migrate.toEF().length - framing
    const estimate = art.reduce((sum, _, vout) => sum + migrateTipPostBytes(mint.outputs[vout]!.lockingScript.toBinary().length), 0)
    expect(estimate).toBeGreaterThanOrEqual(ef)
    expect(estimate - ef).toBeLessThanOrEqual(art.length * 2)
    expect(estimate).toBeLessThan(mint.toBinary().length)
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

describe('migrateInputBeef', () => {
  function chunkOf(...txs: Transaction[]): Beef {
    const chunk = new Beef()
    for (const tx of txs) chunk.mergeTransaction(tx)
    return Beef.fromBinary(chunk.toBinary())
  }

  it('hands a bundle only the sources it spends, with their proofs', () => {
    const spent = mined(deposit(30), 800_030)
    const other = mined(deposit(31), 800_031)
    const chunk = chunkOf(spent, other)
    const whole = chunk.toBinary()

    const scoped = Beef.fromBinary(migrateInputBeef(chunk, [spent.id('hex')], whole))
    expect(scoped.txs.map((t) => t.txid)).toEqual([spent.id('hex')])
    expect(scoped.findBump(spent.id('hex'))?.blockHeight).toBe(800_030)
    expect(scoped.isValid(false)).toBe(true)
  })

  it('brings an unmined source the ancestry that proves it, parents first', () => {
    const parent = mined(deposit(32), 800_032)
    const pending = deposit(33, parent)
    const other = mined(deposit(34), 800_034)
    const chunk = chunkOf(pending, other)

    const scoped = Beef.fromBinary(migrateInputBeef(chunk, [pending.id('hex')], chunk.toBinary()))
    expect(scoped.txs.map((t) => t.txid)).toEqual([parent.id('hex'), pending.id('hex')])
    expect(scoped.isValid(false)).toBe(true)
    expect(scoped.findAtomicTransaction(pending.id('hex'))?.inputs[0]?.sourceTransaction?.id('hex')).toBe(parent.id('hex'))
  })

  it('sends the whole chunk rather than a package missing a source', () => {
    const chunk = chunkOf(mined(deposit(35), 800_035))
    const whole = chunk.toBinary()
    expect(migrateInputBeef(chunk, ['ab'.repeat(32)], whole)).toBe(whole)
  })
})

describe('migrateRetryBody', () => {
  it('keeps the signed transaction and unmined ancestry whole, and names mined sources by txid', () => {
    const art = mined(deposit(20), 800_020)
    art.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(KEY.toAddress()) })
    const minedSource = mined(deposit(21), 800_021)
    const pending = deposit(22, minedSource)
    const sweep = deposit(23, pending)
    sweep.addInput({ sourceTransaction: art, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(KEY.toAddress()) })
    const packed = new Beef()
    for (const tx of [art, minedSource, pending, sweep]) packed.mergeTransaction(tx)
    const sent = migratePackage(packed, sweep.id('hex'))

    const body = migrateRetryBody(sent, sweep.id('hex'))
    expect(body.length).toBeLessThan(sent.length)
    const kept = Beef.fromBinary(body)
    expect(kept.atomicTxid).toBe(sweep.id('hex'))
    expect(kept.findTxid(sweep.id('hex'))?.tx?.id('hex')).toBe(sweep.id('hex'))
    expect(kept.findTxid(pending.id('hex'))?.tx?.id('hex')).toBe(pending.id('hex'))
    expect(kept.findTxid(art.id('hex'))?.isTxidOnly).toBe(true)
    expect(kept.findTxid(minedSource.id('hex'))?.isTxidOnly).toBe(true)
    expect(kept.bumps).toHaveLength(0)
  })

  it('returns the package itself when it cannot be read', () => {
    expect(migrateRetryBody([1, 2, 3], 'ab'.repeat(32))).toEqual([1, 2, 3])
  })
})
