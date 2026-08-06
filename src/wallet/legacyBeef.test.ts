import { Beef, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildLegacyInputBeef, resetLegacyBeefCache } from './legacyBeef'

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

type Node = { tx: Transaction; proof?: MerklePath; missing?: boolean }

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
      return { merklePath: byTxid.get(txid)?.proof }
    },
  } as unknown as Services
  return { services, rawTxCalls, proofCalls }
}

describe('buildLegacyInputBeef', () => {
  beforeEach(() => {
    resetLegacyBeefCache()
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
    expect(Beef.fromBinary(built.beef).verifyValid(false).valid).toBe(true)
  })

  it('walks parents only until it finds a proof', async () => {
    const [tip, parent] = buildChain(2)
    const { services, proofCalls } = makeServices([
      { tx: tip },
      { tx: parent, proof: provenAt(parent, 800_002) },
    ])

    const built = await buildLegacyInputBeef(services, [`${tip.id('hex')}.0`])

    expect(built.failures).toEqual([])
    expect(proofCalls).toEqual([tip.id('hex'), parent.id('hex')])
    // An unconfirmed tip anchored to a proven parent is a complete BEEF.
    expect(Beef.fromBinary(built.beef).verifyValid(false).valid).toBe(true)
  })

  it('fetches a shared transaction once', async () => {
    const [tx] = buildChain(1)
    const { services, rawTxCalls } = makeServices([{ tx, proof: provenAt(tx, 800_003) }])

    const built = await buildLegacyInputBeef(services, [`${tx.id('hex')}.0`, `${tx.id('hex')}.1`])

    expect(built.ready).toHaveLength(2)
    expect(rawTxCalls).toEqual([tx.id('hex')])
  })

  it('gives up instead of fanning out down an endless unproven chain', async () => {
    // Every unproven level multiplies the request count, which is what
    // rate-limited the providers we need for the deposits themselves.
    const chain = buildChain(12)
    const { services } = makeServices(chain.map((tx) => ({ tx })))

    const built = await buildLegacyInputBeef(services, [`${chain[0].id('hex')}.0`])

    expect(built.ready).toEqual([])
    expect(built.failures[0].reason).toMatch(/unproven ancestry deeper than/)
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
