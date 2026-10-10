import { Beef, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildLegacyInputBeef, resetLegacyBeefCache, withVisibleOnChainBeef } from './legacyBeef'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

const key = PrivateKey.fromRandom()
const address = key.toAddress()

function provenAt(tx: Transaction, height: number): MerklePath {
  return new MerklePath(height, [
    [
      { offset: 0, hash: tx.id('hex'), txid: true },
      { offset: 1, duplicate: true },
    ],
  ])
}

/**
 * A spend chain, tip first: `buildChain(1)` is a single funding transaction.
 *
 * `sats` distinguishes otherwise identical chains — two transactions with the
 * same outputs and no inputs serialize identically and share one txid.
 */
function buildChain(length: number, sats = 10_000): Transaction[] {
  let tx = new Transaction()
  tx.addOutput({ satoshis: sats, lockingScript: new P2PKH().lock(address) })
  const txs = [tx]
  for (let i = 1; i < length; i++) {
    const next = new Transaction()
    next.addInput({
      sourceTransaction: tx,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    next.addOutput({ satoshis: sats - i * 100, lockingScript: new P2PKH().lock(address) })
    txs.push(next)
    tx = next
  }
  return txs.reverse()
}

/** `refusals`: proof lookups every provider refuses (a 429) before one answers. */
type Node = { tx: Transaction; proof?: MerklePath; missing?: boolean; refusals?: number }

/** What the toolbox returns when WhatsOnChain itself has no proof. */
const WOC_NOT_FOUND = { notes: [{ name: 'WoCTsc', what: 'getMerklePathNotFound' }] }

function makeServices(nodes: Node[]): {
  services: Services
  rawTxCalls: string[]
  proofCalls: string[]
} {
  const byTxid = new Map(nodes.map((n) => [n.tx.id('hex'), n]))
  const rawTxCalls: string[] = []
  const proofCalls: string[] = []
  const services = {
    getRawTx: async (txid: string) => {
      rawTxCalls.push(txid)
      const node = byTxid.get(txid)
      if (node == null || node.missing === true) return { txid }
      return { txid, rawTx: node.tx.toBinary() }
    },
    getMerklePath: async (txid: string) => {
      proofCalls.push(txid)
      const node = byTxid.get(txid)
      if (node?.refusals) {
        node.refusals -= 1
        return { notes: [{ name: 'WoCTsc', what: 'getMerklePathRetry' }] }
      }
      return node?.proof ? { merklePath: node.proof } : WOC_NOT_FOUND
    },
  } as unknown as Services
  return { services, rawTxCalls, proofCalls }
}

describe('buildLegacyInputBeef', () => {
  beforeEach(() => {
    resetLegacyBeefCache({ retryDelaysMs: [0, 0] })
  })

  it('keeps a broken deposit from discarding the healthy ones', async () => {
    // This is the bug the user hit: the toolbox builder throws on the first
    // ancestor it cannot fetch, outside any per-outpoint catch, so a single
    // unlucky deposit means nothing in the scan arrives.
    const [good] = buildChain(1, 10_000)
    const [bad] = buildChain(1, 20_000)
    const { services } = makeServices([
      { tx: good, proof: provenAt(good, 800_001) },
      { tx: bad, missing: true },
    ])

    const built = await buildLegacyInputBeef(services, [`${good.id('hex')}.0`, `${bad.id('hex')}.0`])

    expect(built.ready).toEqual([`${good.id('hex')}.0`])
    expect(built.failures).toHaveLength(1)
    expect(built.failures[0].outpoint).toBe(`${bad.id('hex')}.0`)
  })

  const acceptingTracker = {
    isValidRootForHeight: async () => true,
    currentHeight: async () => 900_000,
  }

  it('ships a mined deposit with its own merkle path so SPV passes', async () => {
    const [tx] = buildChain(1, 979_431)
    const { services, rawTxCalls } = makeServices([{ tx, proof: provenAt(tx, 969_032) }])

    const built = await buildLegacyInputBeef(services, [`${tx.id('hex')}.0`])

    expect(built.ready).toEqual([`${tx.id('hex')}.0`])
    expect(rawTxCalls).toEqual([tx.id('hex')])
    const beef = Beef.fromBinary(built.beef)
    expect(beef.bumps).toHaveLength(1)
    expect(await beef.verify(acceptingTracker, false)).toBe(true)
  })

  it('proves a mempool deposit through its merkle-proven parent', async () => {
    const [tip, parent] = buildChain(2)
    const { services, proofCalls, rawTxCalls } = makeServices([
      { tx: tip },
      { tx: parent, proof: provenAt(parent, 800_002) },
    ])

    const built = await buildLegacyInputBeef(services, [`${tip.id('hex')}.0`])

    expect(built.failures).toEqual([])
    expect(built.ready).toEqual([`${tip.id('hex')}.0`])
    expect(rawTxCalls).toEqual([tip.id('hex'), parent.id('hex')])
    expect(proofCalls).toEqual([tip.id('hex'), parent.id('hex')])
    expect(await Beef.fromBinary(built.beef).verify(acceptingTracker, false)).toBe(true)
  })

  it('fetches a shared transaction once', async () => {
    const [tx] = buildChain(1)
    const { services, rawTxCalls } = makeServices([{ tx, proof: provenAt(tx, 800_003) }])

    const built = await buildLegacyInputBeef(services, [`${tx.id('hex')}.0`, `${tx.id('hex')}.1`])

    expect(built.ready).toHaveLength(2)
    expect(rawTxCalls).toEqual([tx.id('hex')])
  })

  it('leaves a deposit with unmined parents retryable instead of walking deeper', async () => {
    const chain = buildChain(12)
    const { services, rawTxCalls } = makeServices(chain.map((tx) => ({ tx })))

    const built = await buildLegacyInputBeef(services, [`${chain[0].id('hex')}.0`])

    expect(built.ready).toEqual([])
    expect(built.failures[0].reason).toMatch(/waiting for a block/)
    expect(rawTxCalls).toEqual([chain[0].id('hex'), chain[1].id('hex')])
  })

  it('asks again when every provider refused, so a mined deposit is never called unmined', async () => {
    const [tx] = buildChain(1, 30_000)
    const { services, proofCalls } = makeServices([{ tx, proof: provenAt(tx, 852_201), refusals: 2 }])

    const built = await buildLegacyInputBeef(services, [`${tx.id('hex')}.0`])

    expect(built.failures).toEqual([])
    expect(built.ready).toEqual([`${tx.id('hex')}.0`])
    expect(proofCalls).toHaveLength(3)
  })

  it('says the providers did not answer, not that a block is coming, when every retry is refused', async () => {
    const [tip, parent] = buildChain(2, 40_000)
    const { services } = makeServices([
      { tx: tip, refusals: 3 },
      { tx: parent, proof: provenAt(parent, 852_202) },
    ])

    const built = await buildLegacyInputBeef(services, [`${tip.id('hex')}.0`])

    expect(built.ready).toEqual([])
    expect(built.failures[0]!.reason).toMatch(/no provider answered/)
    expect(built.failures[0]!.reason).not.toMatch(/waiting for a block/)
  })

  it('reads for a transaction being signed before reads warming a later chunk', async () => {
    const ahead = Array.from({ length: 6 }, (_, i) => buildChain(1, 50_000 + i)[0]!)
    const now = buildChain(1, 60_000)[0]!
    const { services } = makeServices([...ahead, now].map((tx, i) => ({ tx, proof: provenAt(tx, 800_200 + i) })))
    const started: string[] = []
    const getRawTx = services.getRawTx.bind(services)
    services.getRawTx = (async (txid: string) => {
      started.push(txid)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return getRawTx(txid)
    }) as Services['getRawTx']

    const warming = buildLegacyInputBeef(services, ahead.map((tx) => `${tx.id('hex')}.0`), {
      concurrency: 6,
      priority: 'ahead',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const signing = buildLegacyInputBeef(services, [`${now.id('hex')}.0`])
    await Promise.all([warming, signing])

    expect(started.indexOf(now.id('hex'))).toBeLessThan(started.indexOf(ahead[5]!.id('hex')))
  })

  it('does not bypass BEEF verification for a visible transaction body', async () => {
    const [tip] = buildChain(3)
    const beef = new Beef()
    beef.mergeRawTx(tip.toBinary())
    const tracker = {
      isValidRootForHeight: async () => false,
      currentHeight: async () => 1,
    }
    expect(await beef.verify(tracker, true)).toBe(false)
    const ok = await withVisibleOnChainBeef(() => beef.verify(tracker, true))
    expect(ok).toBe(false)
    expect(await beef.verify(tracker, true)).toBe(false)
  })

  it('overlaps source reads without ever running more than four at once', async () => {
    const txs = Array.from({ length: 8 }, (_, i) => buildChain(1, 10_000 + i)[0]!)
    const { services } = makeServices(txs.map((tx, i) => ({ tx, proof: provenAt(tx, 800_100 + i) })))
    let live = 0
    let peak = 0
    const getRawTx = services.getRawTx.bind(services)
    services.getRawTx = (async (txid: string) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 150))
      live -= 1
      return getRawTx(txid)
    }) as Services['getRawTx']

    const built = await buildLegacyInputBeef(
      services,
      txs.map((tx) => `${tx.id('hex')}.0`),
      { concurrency: 8 },
    )

    expect(built.ready).toHaveLength(8)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('reports a malformed outpoint without asking the network', async () => {
    const { services, rawTxCalls } = makeServices([])

    const built = await buildLegacyInputBeef(services, ['not-an-outpoint.0'])

    expect(built.ready).toEqual([])
    expect(built.failures[0].reason).toBe('malformed outpoint')
    expect(rawTxCalls).toEqual([])
    expect(built.beef).toEqual([])
  })
})
