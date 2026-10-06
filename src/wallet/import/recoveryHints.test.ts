import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined, uiBudgetExpired: () => false }))

import { discoverAddresses, resetDiscoveryPacingForTests } from './discovery'
import type { AddressHoldings } from './holdings'
import type { KeyDeriver } from './importSource'
import {
  clearRecoveryHintsForTests,
  createHistoryReader,
  hintedLookups,
  judgeHintedScan,
  MAX_HINT_TXIDS,
  parseRecoveryHints,
  readHintedAddresses,
  readItemOwners,
  recoveryHintsFor,
  recoveryHintsGeneration,
  recoveryHintsOffer,
  rememberRecoveryHints,
  subscribeRecoveryHints,
  type HandCashRecoveryHints,
} from './recoveryHints'

const txid = (n: number) => n.toString(16).padStart(64, '0')

function hints(over: Partial<HandCashRecoveryHints> = {}): HandCashRecoveryHints {
  return {
    handle: 'alice',
    txids: [txid(1)],
    origins: [],
    historyComplete: true,
    satoshis: 10_000,
    itemCount: 1,
    receivedAt: 0,
    ...over,
  }
}

function holding(over: Partial<AddressHoldings> = {}): AddressHoldings {
  return {
    address: '1x',
    path: 'm/0/0',
    label: 'HandCash',
    wallets: 'HandCash',
    uncompressed: false,
    cashSats: 0,
    cashCount: 0,
    dustCount: 0,
    dustSats: 0,
    itemCount: 0,
    itemCountCapped: false,
    tokens: [],
    error: null,
    ...over,
  }
}

function rawTx(scripts: Script[], spends: { txid: string; vout: number } = { txid: txid(0), vout: 0 }): { txid: string; hex: string } {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: spends.txid, sourceOutputIndex: spends.vout, unlockingScript: new Script(), sequence: 0xffffffff })
  for (const lockingScript of scripts) tx.addOutput({ lockingScript, satoshis: 1 })
  return { txid: tx.id('hex'), hex: tx.toHex() }
}

/** An ordinal inscription envelope followed by the holder's P2PKH. */
function inscriptionTo(address: string): Script {
  return Script.fromHex(`0063036f7264510a746578742f706c61696e000268696800${new P2PKH().lock(address).toHex()}`)
}

describe('parseRecoveryHints', () => {
  it('keeps valid txids and item origins apart, deduped', () => {
    const parsed = parseRecoveryHints(
      {
        handle: '$Alice',
        txids: [txid(1), txid(1).toUpperCase(), 'nope', 42],
        itemOrigins: [`${txid(2)}_0`, `${txid(3)}.1`, `${txid(2)}_0`, 'bad'],
        historyComplete: true,
        satoshis: 5_000,
      },
      7,
    )
    expect(parsed).toEqual({
      handle: 'alice',
      txids: [txid(1)],
      origins: [`${txid(2)}_0`, `${txid(3)}_1`],
      historyComplete: true,
      satoshis: 5_000,
      itemCount: 2,
      receivedAt: 7,
    })
  })

  it('takes an inventory without history as hints', () => {
    expect(parseRecoveryHints({ itemOrigins: [`${txid(4)}_2`] })).toMatchObject({ txids: [], origins: [`${txid(4)}_2`], itemCount: 1 })
  })

  it('treats a payload without a usable txid or origin as no hints', () => {
    expect(parseRecoveryHints(undefined)).toBeNull()
    expect(parseRecoveryHints({ itemOrigins: ['x_1'] })).toBeNull()
    expect(parseRecoveryHints({ txids: ['x'], satoshis: 1 })).toBeNull()
    expect(parseRecoveryHints([txid(1)])).toBeNull()
  })

  it('never trusts a malformed balance or a history it had to cap', () => {
    const many = Array.from({ length: MAX_HINT_TXIDS + 5 }, (_, i) => txid(i + 1))
    const parsed = parseRecoveryHints({ txids: many, historyComplete: true, satoshis: -1, itemCount: 1.5 })
    expect(parsed?.txids).toHaveLength(MAX_HINT_TXIDS)
    expect(parsed?.historyComplete).toBe(false)
    expect(parsed?.satoshis).toBe(0)
    expect(parsed?.itemCount).toBe(0)
  })
})

describe('recoveryHintsFor', () => {
  beforeEach(() => clearRecoveryHintsForTests())

  it('applies only to HandCash sources whose probed handle agrees', () => {
    rememberRecoveryHints(hints({ receivedAt: 1_000 }))
    expect(recoveryHintsFor({ kind: 'handcash', handle: null }, 2_000)).not.toBeNull()
    expect(recoveryHintsFor({ kind: 'handcash', handle: { handle: '$alice' } }, 2_000)).not.toBeNull()
    expect(recoveryHintsFor({ kind: 'handcash', handle: { handle: 'bob' } }, 2_000)).toBeNull()
    expect(recoveryHintsFor({ kind: 'mnemonic', handle: null }, 2_000)).toBeNull()
  })

  it('expires', () => {
    rememberRecoveryHints(hints({ receivedAt: 0 }))
    expect(recoveryHintsFor({ kind: 'handcash', handle: null }, 7 * 60 * 60 * 1000)).toBeNull()
  })
})

describe('recoveryHintsOffer', () => {
  beforeEach(() => clearRecoveryHintsForTests())
  const handcash = (over: { handle?: string; scanAt?: number } = {}) => ({
    kind: 'handcash',
    handle: over.handle ? { handle: over.handle } : null,
    scan: over.scanAt != null ? { at: over.scanAt } : null,
  })

  it('offers nothing to a source that is not a HandCash export', () => {
    rememberRecoveryHints(hints({ receivedAt: 1_000 }))
    expect(recoveryHintsOffer({ kind: 'mnemonic', handle: null, scan: null }, 2_000)).toEqual({ kind: 'none' })
  })

  it('asks for history until some arrives, and again once it expires', () => {
    expect(recoveryHintsOffer(handcash(), 2_000)).toEqual({ kind: 'ask' })
    rememberRecoveryHints(hints({ receivedAt: 0 }))
    expect(recoveryHintsOffer(handcash(), 7 * 60 * 60 * 1000)).toEqual({ kind: 'ask' })
  })

  it('is ready when history arrived after the last scan, and used once a scan ran with it', () => {
    rememberRecoveryHints(hints({ receivedAt: 1_000, txids: [txid(1), txid(2)], origins: [`${txid(3)}_0`] }))
    expect(recoveryHintsOffer(handcash({ scanAt: 500 }), 2_000)).toEqual({ kind: 'ready', txids: 2, items: 1 })
    expect(recoveryHintsOffer(handcash(), 2_000)).toMatchObject({ kind: 'ready' })
    expect(recoveryHintsOffer(handcash({ scanAt: 1_500 }), 2_000)).toEqual({ kind: 'used' })
  })

  it('offers nothing once the export was read from its UTXO set', () => {
    rememberRecoveryHints(hints({ receivedAt: 1_000 }))
    expect(
      recoveryHintsOffer({ kind: 'handcash', handle: null, scan: { at: 500, via: 'handcash-utxo-set' } }, 2_000),
    ).toEqual({ kind: 'none' })
  })

  it('names both handles when the signed-in account is not the one these keys prove', () => {
    rememberRecoveryHints(hints({ receivedAt: 1_000, handle: 'bob' }))
    expect(recoveryHintsOffer(handcash({ handle: '$Alice' }), 2_000)).toEqual({
      kind: 'mismatch',
      hinted: 'bob',
      saved: 'alice',
    })
  })

  it('tells subscribers when history arrives', () => {
    const seen: number[] = []
    const off = subscribeRecoveryHints(() => seen.push(recoveryHintsGeneration()))
    rememberRecoveryHints(hints())
    off()
    rememberRecoveryHints(hints())
    expect(seen).toEqual([1])
  })
})

describe('readHintedAddresses', () => {
  beforeEach(() => resetDiscoveryPacingForTests())

  it('collects plain and inscription-wrapped P2PKH outputs, never OP_RETURN', async () => {
    const plain = PrivateKey.fromRandom().toAddress()
    const item = PrivateKey.fromRandom().toAddress()
    const tx = rawTx([new P2PKH().lock(plain), inscriptionTo(item), Script.fromHex('006a0568656c6c6f')])
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ txid: tx.txid, hex: tx.hex }])))
    const read = await readHintedAddresses({ chain: 'main', txids: [tx.txid], fetchImpl })
    expect([...read.addresses].sort()).toEqual([plain, item].sort())
    expect(read).toMatchObject({ read: 1, failed: 0, stopped: false })
  })

  it('sets aside txids the chain does not know, but not ones it failed to answer', async () => {
    const tx = rawTx([new P2PKH().lock(PrivateKey.fromRandom().toAddress())])
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { txid: tx.txid, hex: tx.hex },
            { txid: txid(9), error: 'unknown' },
            { txid: txid(10), error: 'internal' },
            { txid: txid(11), hex: 'zz' },
          ]),
        ),
    )
    const read = await readHintedAddresses({ chain: 'main', txids: [tx.txid, txid(9), txid(10), txid(11), txid(12)], fetchImpl })
    expect(read).toMatchObject({ read: 1, unknown: 1, failed: 3 })
  })

  it('counts a refused chunk as unread without retrying a client error', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }))
    const read = await readHintedAddresses({ chain: 'main', txids: [txid(1), txid(2)], fetchImpl })
    expect(read).toMatchObject({ read: 0, failed: 2 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('createHistoryReader', () => {
  beforeEach(() => resetDiscoveryPacingForTests())

  it('leaves out of mayHold an address whose outputs a later read transaction spent', async () => {
    const emptied = PrivateKey.fromRandom().toAddress()
    const holder = PrivateKey.fromRandom().toAddress()
    const older = rawTx([new P2PKH().lock(emptied)])
    const newer = rawTx([new P2PKH().lock(holder)], { txid: older.txid, vout: 0 })
    const byId = new Map([older, newer].map((t) => [t.txid, t.hex]))
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const { txids } = JSON.parse(String(init?.body)) as { txids: string[] }
      return new Response(JSON.stringify(txids.map((id) => ({ txid: id, hex: byId.get(id) }))))
    })
    const reader = createHistoryReader({ chain: 'main', txids: [newer.txid, older.txid], fetchImpl })

    await reader.readUntil(1)
    expect(reader.position).toBe(1)
    expect([...reader.snapshot().mayHold]).toEqual([holder])

    await reader.readUntil(2)
    const read = reader.snapshot()
    expect([...read.addresses].sort()).toEqual([emptied, holder].sort())
    expect([...read.mayHold]).toEqual([holder])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps an output nothing read spends as possibly held', async () => {
    const address = PrivateKey.fromRandom().toAddress()
    const tx = rawTx([new P2PKH().lock(address)])
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ txid: tx.txid, hex: tx.hex }])))
    const reader = createHistoryReader({ chain: 'main', txids: [tx.txid], fetchImpl })
    await reader.readUntil(10)
    expect([...reader.snapshot().mayHold]).toEqual([address])
    expect(reader.position).toBe(1)
  })
})

describe('readItemOwners', () => {
  const origins = Array.from({ length: 150 }, (_, i) => `${txid(i + 1)}_0`)

  it('asks the 1Sat index a hundred origins at a time and keeps owners of unspent items', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://ordinals.gorillapool.io/api/inscriptions/latest')
      const asked = JSON.parse(String(init?.body)) as string[]
      return new Response(
        JSON.stringify(asked.map((origin, i) => ({ origin, owner: i % 2 ? '1Spent' : `1Owner${i % 4}`, spend: i % 2 ? txid(999) : '' }))),
      )
    })
    const read = await readItemOwners({ chain: 'main', origins, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(read).toMatchObject({ located: 150, unspent: 75, missing: 0, failed: 0, stopped: false })
    expect([...read.owners].sort()).toEqual(['1Owner0', '1Owner2'])
  })

  it('retries a chunk once, then counts it as failed and moves on', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1
      if (calls <= 2) return new Response('busy', { status: 503 })
      const asked = JSON.parse(String(init?.body)) as string[]
      return new Response(JSON.stringify(asked.map(() => ({ owner: '1Held', spend: '' }))))
    })
    const read = await readItemOwners({ chain: 'main', origins, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(read).toMatchObject({ failed: 100, located: 50, unspent: 50 })
    expect([...read.owners]).toEqual(['1Held'])
  })

  it('drops an origin the index has no output for and asks again for the rest', async () => {
    const burned = new Set([origins[3], origins[7]])
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const asked = JSON.parse(String(init?.body)) as string[]
      const dead = asked.find((origin) => burned.has(origin))
      if (dead) return new Response(JSON.stringify({ message: `No latest outpoint for origin ${dead}` }), { status: 404 })
      return new Response(JSON.stringify(asked.map(() => ({ owner: '1Held', spend: '' }))))
    })
    const read = await readItemOwners({ chain: 'main', origins, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(read).toMatchObject({ located: 148, unspent: 148, missing: 2, failed: 0 })
  })

  it('stops between chunks when asked', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]'))
    const read = await readItemOwners({ chain: 'main', origins, fetchImpl, shouldStop: () => true })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(read.stopped).toBe(true)
  })
})

describe('hinted discovery', () => {
  it('walks the key set against the hinted outputs alone', async () => {
    const keys = new Map<string, PrivateKey>()
    const deriver: KeyDeriver = {
      templates: [{ id: 'hc', label: 'HandCash', wallets: 'HandCash', pattern: 'm/{i}', gap: 5 }],
      fixed: [],
      identity: null,
      privateKeyAt: (path) => {
        let key = keys.get(path)
        if (!key) keys.set(path, (key = PrivateKey.fromRandom()))
        return key
      },
    }
    const at = (path: string) => deriver.privateKeyAt(path).toPublicKey().toAddress()
    const seen = new Set([at('m/2'), at('m/6'), PrivateKey.fromRandom().toAddress()])
    const result = await discoverAddresses({ deriver, ...hintedLookups(seen) })
    expect(result.addresses.map((a) => a.path)).toEqual(['m/2', 'm/6'])
    expect(result.complete).toBe(true)
  })
})

describe('judgeHintedScan', () => {
  const clean = { stopped: false }

  it('settles when the chain covers HandCash balance and items', () => {
    const verdict = judgeHintedScan(hints(), clean, [
      holding({ cashSats: 9_000, dustSats: 1_000 }),
      holding({ itemCount: 1 }),
    ])
    expect(verdict).toEqual({ kind: 'settled', foundSats: 10_000, foundItems: 1 })
  })

  it.each([
    ['stopped', hints(), { stopped: true }, [holding({ cashSats: 10_000, itemCount: 1 })]],
    ['empty-claim', hints({ satoshis: 0, itemCount: 0 }), clean, []],
    ['balance-short', hints(), clean, [holding({ cashSats: 9_999, itemCount: 1 })]],
    ['balance-short', hints(), clean, [holding({ uncompressed: true, cashSats: 10_000, itemCount: 1 })]],
    ['items-short', hints({ itemCount: 2 }), clean, [holding({ cashSats: 10_000, itemCount: 1 })]],
  ] as const)('falls back on %s', (reason, h, read, holdings) => {
    expect(judgeHintedScan(h, read, holdings)).toEqual({ kind: 'fallback', reason })
  })

  it('settles on a capped history when the chain already covers the claim', () => {
    const verdict = judgeHintedScan(hints({ historyComplete: false }), clean, [holding({ cashSats: 10_000, itemCount: 1 })])
    expect(verdict.kind).toBe('settled')
  })

  it('accepts a capped item count as a floor that may cover the claim', () => {
    const verdict = judgeHintedScan(hints({ itemCount: 9_000 }), clean, [
      holding({ cashSats: 10_000, itemCount: 5_000, itemCountCapped: true }),
    ])
    expect(verdict.kind).toBe('settled')
  })
})
