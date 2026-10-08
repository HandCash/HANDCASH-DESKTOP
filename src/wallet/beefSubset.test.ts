import { describe, expect, it } from 'vitest'
import { Beef, LockingScript, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { BeefShelf, beefSubset, prefixWithinBeefBudget } from './beefSubset'

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

function tx(parents: Transaction[], payload = 0): Transaction {
  const t = new Transaction()
  for (const parent of parents) {
    t.addInput({ sourceTXID: parent.id('hex'), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  }
  if (parents.length === 0) {
    t.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  }
  t.addOutput({ lockingScript: lock, satoshis: 1 })
  if (payload > 0) {
    t.addOutput({
      lockingScript: new LockingScript([{ op: 0x6a }, { op: 0x4d, data: new Array<number>(payload).fill(0xab) }]),
      satoshis: 0,
    })
  }
  return t
}

function proven(t: Transaction, height: number): MerklePath {
  return new MerklePath(height, [[{ offset: 0, hash: t.id('hex'), txid: true }]])
}

/** Two proven funding parents, a mint on each, and a second mint sharing the first parent. */
function fixture() {
  const g1 = tx([], 10)
  const g2 = tx([], 11)
  const mintA = tx([g1], 50_000)
  const mintB = tx([g2], 50_001)
  const mintC = tx([g1], 50_002)
  const beef = new Beef()
  beef.mergeRawTx(g1.toBinary(), beef.mergeBump(proven(g1, 100)))
  beef.mergeRawTx(g2.toBinary(), beef.mergeBump(proven(g2, 101)))
  for (const mint of [mintA, mintB, mintC]) beef.mergeRawTx(mint.toBinary())
  return { beef, g1, g2, mintA, mintB, mintC }
}

describe('beefSubset', () => {
  it('keeps only the subject, its unproven ancestry and the bumps that end it', () => {
    const { beef, g1, g2, mintA, mintB } = fixture()
    const leg = Beef.fromBinary(beefSubset(beef, [mintA.id('hex')]).toBinary())
    expect(leg.findTxid(mintA.id('hex'))).toBeDefined()
    expect(leg.findTxid(g1.id('hex'))?.bumpIndex).toBe(0)
    expect(leg.findTxid(mintB.id('hex'))).toBeUndefined()
    expect(leg.findTxid(g2.id('hex'))).toBeUndefined()
    expect(leg.bumps).toHaveLength(1)
    expect(leg.isValid(false)).toBe(true)
  })

  it('assembles the same leg from per-item packages on a shelf', () => {
    const { beef, g1, g2, mintA, mintB, mintC } = fixture()
    const perItem = [
      [g1, mintA],
      [g2, mintB],
      [g1, mintC],
    ].map(([parent, mint]) => {
      const one = new Beef()
      one.mergeRawTx(parent!.toBinary(), one.mergeBump(proven(parent!, parent === g1 ? 100 : 101)))
      one.mergeRawTx(mint!.toBinary())
      return one
    })
    const shelf = new BeefShelf()
    for (const one of perItem) shelf.add(one)
    const ids = [mintA.id('hex'), mintC.id('hex')]

    const fromShelf = beefSubset(shelf, ids)
    expect(fromShelf.toBinary()).toEqual(beefSubset(beef, ids).toBinary())
    expect(fromShelf.isValid(false)).toBe(true)
    expect(prefixWithinBeefBudget(shelf, ids, 10_000_000)).toBe(2)
    expect(shelf.findTxid(mintB.id('hex'))).toBeDefined()
  })

  it('carries far fewer bytes than the whole import package', () => {
    const { beef, mintA } = fixture()
    expect(beefSubset(beef, [mintA.id('hex')]).toBinary().length).toBeLessThan(beef.toBinary().length / 2)
  })
})

describe('prefixWithinBeefBudget', () => {
  it('cuts a leg before its parents pass the budget, but never below one tip', () => {
    const { beef, mintA, mintB, mintC } = fixture()
    const ids = [mintA, mintB, mintC].map((t) => t.id('hex'))
    expect(prefixWithinBeefBudget(beef, ids, 10_000_000)).toBe(3)
    expect(prefixWithinBeefBudget(beef, ids, 60_000)).toBe(1)
    expect(prefixWithinBeefBudget(beef, ids, 10)).toBe(1)
  })

  it('counts a shared parent once', () => {
    const { beef, mintA, mintC } = fixture()
    const one = mintA.toBinary().length
    // Room for both mints but not for the shared parent twice.
    expect(prefixWithinBeefBudget(beef, [mintA.id('hex'), mintC.id('hex')], one * 2 + 200)).toBe(2)
  })
})
