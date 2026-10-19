import { describe, expect, it } from 'vitest'
import { locateLtcDeposit } from '../ltc/verify'
import { electrumBchChain, electrumScriptHash, electrumSocket } from './chain'
import { bchOutputScript } from './bitcoincash'
import fixture from './fixtures/chain.json'

type Handler = (method: string, params: unknown[]) => unknown

/** A WebSocket that answers Electrum requests from `handle`; a thrown Error becomes an Electrum error. */
function fakeSocket(handle: Handler, log: string[] = []) {
  return (url: string) => {
    const sock = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((e: { data: string }) => void),
      onerror: null as null | (() => void),
      onclose: null as null | (() => void),
      send(raw: string) {
        const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown[] }
        log.push(method)
        queueMicrotask(() => {
          try {
            sock.onmessage?.({ data: JSON.stringify({ id, result: handle(method, params) }) })
          } catch (err) {
            sock.onmessage?.({ data: JSON.stringify({ id, error: { code: 1, message: (err as Error).message } }) })
          }
        })
      },
      close() {
        sock.onclose?.()
      },
    }
    queueMicrotask(() => sock.onopen?.())
    void url
    return sock as unknown as WebSocket
  }
}

const START = fixture.recent.start
const headerHex = (h: number) => fixture.recent.hex.slice((h - START) * 160, (h - START + 1) * 160)

const fixtureServer: Handler = (method, params) => {
  switch (method) {
    case 'server.version':
      return ['Fulcrum', '1.4']
    case 'blockchain.block.headers': {
      const [start, count] = params as [number, number]
      return { count, hex: Array.from({ length: count }, (_, i) => headerHex(start + i)).join(''), max: 2016 }
    }
    case 'blockchain.transaction.get_height':
      if (params[0] === fixture.tx.txid) return fixture.tx.height
      throw new Error('No transaction matching the requested hash was found')
    case 'blockchain.transaction.get_merkle':
      return { block_height: params[1], merkle: fixture.tx.merkle, pos: fixture.tx.pos }
    case 'blockchain.transaction.get':
      return fixture.tx.raw
    case 'blockchain.relayfee':
      return 0.00001
    case 'blockchain.estimatefee':
      return 0.00001
    case 'blockchain.scripthash.listunspent':
      return [
        { tx_hash: 'aa'.repeat(32), tx_pos: 0, height: 0, value: 1000 },
        { tx_hash: 'bb'.repeat(32), tx_pos: 1, height: 900000, value: 2000 },
        { tx_hash: 'cc'.repeat(32), tx_pos: 2, height: 900000, value: 800, token_data: { category: 'dd'.repeat(32), amount: '1' } },
      ]
    default:
      throw new Error(`unexpected ${method}`)
  }
}

describe('Electrum Bitcoin Cash source', () => {
  it('serves header ranges, with each header checked by the caller', async () => {
    const log: string[] = []
    const chain = electrumBchChain(electrumSocket('wss://test', fakeSocket(fixtureServer, log)))
    const raws = await chain.headerRange(START, START + 4)
    expect(raws).toHaveLength(5)
    const page = await chain.headerPage(START + 20)
    expect(page.map((r) => r.height)).toEqual(Array.from({ length: 10 }, (_, i) => START + 11 + i))
    expect(log.filter((m) => m === 'server.version')).toHaveLength(1)
  })

  it('locates a real coin in its block, and calls an unknown transaction gone', async () => {
    const chain = electrumBchChain(electrumSocket('wss://test', fakeSocket(fixtureServer)))
    const located = await locateLtcDeposit(chain, fixture.tx.txid)
    expect(located).toMatchObject({ kind: 'in-block', proof: { height: fixture.tx.height, pos: fixture.tx.pos, header: headerHex(fixture.tx.height) } })
    expect(await locateLtcDeposit(chain, '11'.repeat(32))).toEqual({ kind: 'gone' })
  })

  it('lists plain coins by script hash, never CashTokens outputs, and pays one sat per byte', async () => {
    const asked: unknown[] = []
    const chain = electrumBchChain(
      electrumSocket(
        'wss://test',
        fakeSocket((m, p) => {
          if (m === 'blockchain.scripthash.listunspent') asked.push(p[0])
          return fixtureServer(m, p)
        }),
      ),
    )
    const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
    expect(await chain.addressUtxos(address)).toEqual([
      { txid: 'aa'.repeat(32), vout: 0, value: 1000, confirmed: false },
      { txid: 'bb'.repeat(32), vout: 1, value: 2000, confirmed: true },
    ])
    expect(asked).toEqual([electrumScriptHash(bchOutputScript(address))])
    expect(await chain.feeRate()).toBe(1)
  })

  it('does not believe a server asking for a high fee', async () => {
    const chain = electrumBchChain(electrumSocket('wss://test', fakeSocket((m, p) => (m === 'blockchain.estimatefee' ? 0.01 : fixtureServer(m, p)))))
    expect(await chain.feeRate()).toBe(5)
  })

  it('refuses a short header answer', async () => {
    const chain = electrumBchChain(
      electrumSocket('wss://test', fakeSocket((m, p) => (m === 'blockchain.block.headers' ? { count: 1, hex: headerHex(START) } : fixtureServer(m, p)))),
    )
    await expect(chain.headerRange(START, START + 1)).rejects.toThrow(/1 of 2 headers/)
  })
})
