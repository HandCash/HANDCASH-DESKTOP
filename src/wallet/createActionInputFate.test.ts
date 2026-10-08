import { Beef, MerklePath, PrivateKey, P2PKH, Script, Transaction } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  combineSpendProbes,
  foreignConfirmedInputSpends,
  outpointRecentlyCleared,
  parseBulkSpentEntry,
  parseConfirmedForeignSpender,
  parseTeranodeUtxoEntry,
  probeOutpointSpends,
  teranodeUtxoRequestBody,
  resetClearedOutpointsForTests,
  retireCreateActionSpentElsewhere,
} from './createActionInputFate'

const retireCalls: string[] = []
const sweeps: string[] = []

vi.mock('./staleOutputRelease', () => ({
  failUnsentLocalTx: async (txid: string, opts?: { noDescendants?: boolean }) => {
    retireCalls.push(`fail ${txid}${opts?.noDescendants ? ' fresh' : ''}`)
    return true
  },
  hideSpentOutpoints: async (outpoints: string[], spender: string) => {
    retireCalls.push(`hide ${outpoints.join(',')} by ${spender}`)
    return outpoints.length
  },
}))

vi.mock('./deadCoinSweep', () => ({
  scheduleDeadCoinSweep: (chain: string) => {
    sweeps.push(chain)
  },
}))

const SELF = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)

type Utxo = { txid: string; vout: number }

const WOC = 'api.whatsonchain.com'

function teranodeRecords(body: Uint8Array): Utxo[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const records: Utxo[] = []
  for (let at = 0; at < body.length; at += 36) {
    const txid = Array.from(body.slice(at, at + 32))
      .reverse()
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    records.push({ txid, vout: view.getUint32(at + 32, true) })
  }
  return records
}

/**
 * WhatsOnChain bulk `/utxos/spent`: `answer` builds each entry past `utxo`.
 * Teranode `/utxos/json` answers through `node`, or refuses when omitted.
 */
function bulkFetch(
  answer: (utxo: Utxo) => Record<string, unknown>,
  node?: (utxo: Utxo) => Record<string, unknown>,
) {
  return vi.fn(async (url: string, init?: { body?: unknown }) => {
    if (!url.includes(WOC)) {
      if (!node) return { ok: false, status: 503, json: async () => ({}) }
      const records = teranodeRecords(init?.body as Uint8Array)
      return { ok: true, status: 200, json: async () => records.map(node) }
    }
    const { utxos } = JSON.parse(String(init?.body ?? '{"utxos":[]}')) as { utxos: Utxo[] }
    return {
      ok: true,
      status: 200,
      json: async () => utxos.map((utxo) => ({ utxo, error: '', ...answer(utxo) })),
    }
  })
}

const wocCalls = (fetch: ReturnType<typeof bulkFetch>) =>
  fetch.mock.calls.filter(([url]) => String(url).includes(WOC)).length

const spentBy = (txid: string, status = 'confirmed') => () => ({
  spentIn: { txid, vin: 0, status },
})

describe('parseConfirmedForeignSpender', () => {
  it('names a confirmed spender that is not this transaction', () => {
    expect(
      parseConfirmedForeignSpender(
        { txid: OTHER, status: 'confirmed' },
        SELF,
      ),
    ).toBe(OTHER)
  })

  it('ignores a spend by this transaction and anything not confirmed', () => {
    expect(
      parseConfirmedForeignSpender({ txid: SELF, status: 'confirmed' }, SELF),
    ).toBeNull()
    expect(
      parseConfirmedForeignSpender(
        { txid: OTHER, status: 'unconfirmed' },
        SELF,
      ),
    ).toBeNull()
    expect(parseConfirmedForeignSpender({ status: 'confirmed' }, SELF)).toBeNull()
    expect(parseConfirmedForeignSpender(null, SELF)).toBeNull()
  })
})

describe('parseBulkSpentEntry', () => {
  const utxo = { txid: '11'.repeat(32), vout: 0 }

  it('clears an unspent coin and names a confirmed foreign spender', () => {
    expect(parseBulkSpentEntry({ utxo, error: '' }, SELF)).toEqual({ kind: 'unspent' })
    expect(
      parseBulkSpentEntry({ utxo, spentIn: { txid: OTHER, status: 'confirmed' }, error: '' }, SELF),
    ).toEqual({ kind: 'spent', spender: OTHER })
  })

  it('keeps an unknown output, an error, or a spend by this tx unknown', () => {
    expect(
      parseBulkSpentEntry(
        { utxo, spentIn: { txid: utxo.txid, status: 'Unknown UTXO' }, error: '' },
        SELF,
      ),
    ).toEqual({ kind: 'unknown' })
    expect(parseBulkSpentEntry({ utxo, error: 'bad txid' }, SELF)).toEqual({ kind: 'unknown' })
    expect(
      parseBulkSpentEntry({ utxo, spentIn: { txid: SELF, status: 'confirmed' }, error: '' }, SELF),
    ).toEqual({ kind: 'unknown' })
  })
})

describe('probeOutpointSpends', () => {
  afterEach(() => {
    resetClearedOutpointsForTests()
    vi.unstubAllGlobals()
  })

  it('asks the explorer twenty coins per request', async () => {
    const fetch = bulkFetch(() => ({}))
    vi.stubGlobal('fetch', fetch)
    const outpoints = Array.from({ length: 45 }, (_, i) => `${'12'.repeat(32)}.${i}`)
    const probes = await probeOutpointSpends(outpoints, '', 'main')
    expect(wocCalls(fetch)).toBe(3)
    expect([...probes.values()].every((p) => p.kind === 'unspent')).toBe(true)
  })

  it('leaves a coin the reply omits unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
    )
    const outpoint = `${'13'.repeat(32)}.0`
    const probes = await probeOutpointSpends([outpoint], '', 'main')
    expect(probes.get(outpoint)).toEqual({ kind: 'unknown' })
    expect(outpointRecentlyCleared(outpoint)).toBe(false)
  })

  it('names a mempool spender only a node sees, over an explorer that sees none', async () => {
    const outpoint = `${'14'.repeat(32)}.3`
    vi.stubGlobal(
      'fetch',
      bulkFetch(
        () => ({}),
        () => ({ status: 1, spendingData: { txId: OTHER, vin: 0 } }),
      ),
    )
    const probes = await probeOutpointSpends([outpoint], SELF, 'main')
    expect(probes.get(outpoint)).toEqual({ kind: 'spent', spender: OTHER })
    expect(outpointRecentlyCleared(outpoint)).toBe(false)
  })

  it('clears a coin the node holds unspent while the explorer is silent', async () => {
    const outpoint = `${'15'.repeat(32)}.1`
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: unknown }) => {
        if (String(url).includes(WOC)) return { ok: false, status: 429, json: async () => ({}) }
        const records = teranodeRecords(init?.body as Uint8Array)
        expect(records).toEqual([{ txid: '15'.repeat(32), vout: 1 }])
        return { ok: true, status: 200, json: async () => [{ status: 0 }] }
      }),
    )
    const probes = await probeOutpointSpends([outpoint], SELF, 'main')
    expect(probes.get(outpoint)).toEqual({ kind: 'unspent' })
  })

  it('lets an explorer spender outrank a node that has pruned or never saw the coin', async () => {
    const outpoint = `${'16'.repeat(32)}.0`
    vi.stubGlobal('fetch', bulkFetch(spentBy(OTHER), () => ({ status: 3 })))
    const probes = await probeOutpointSpends([outpoint], SELF, 'main')
    expect(probes.get(outpoint)).toEqual({ kind: 'spent', spender: OTHER })
  })

  it('falls through to the second node when the first refuses', async () => {
    const outpoint = `${'17'.repeat(32)}.0`
    const hosts: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes(WOC)) return { ok: false, status: 429, json: async () => ({}) }
        hosts.push(new URL(url).host)
        return hosts.length === 1
          ? { ok: false, status: 503, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => [{ status: 0 }] }
      }),
    )
    const probes = await probeOutpointSpends([outpoint], SELF, 'main')
    expect(hosts).toEqual(['mainnet.gorillanode.io', 'mainnet2.gorillanode.io'])
    expect(probes.get(outpoint)).toEqual({ kind: 'unspent' })
  })
})

describe('parseTeranodeUtxoEntry', () => {
  it('reads unspent and a foreign spender; everything else is unknown', () => {
    expect(parseTeranodeUtxoEntry({ status: 0 }, SELF)).toEqual({ kind: 'unspent' })
    expect(
      parseTeranodeUtxoEntry({ status: 1, spendingData: { txId: OTHER.toUpperCase(), vin: 2 } }, SELF),
    ).toEqual({ kind: 'spent', spender: OTHER })
    expect(parseTeranodeUtxoEntry({ status: 1, spendingData: { txId: SELF } }, SELF)).toEqual({
      kind: 'unknown',
    })
    for (const status of [2, 3, 5, 6, 7]) {
      expect(parseTeranodeUtxoEntry({ status }, SELF)).toEqual({ kind: 'unknown' })
    }
  })

  it('encodes each outpoint as internal-order txid and little-endian vout', () => {
    const txid = `${'00'.repeat(31)}ff`
    const body = teranodeUtxoRequestBody([{ txid, vout: 0x01020304 }])
    expect(body.length).toBe(36)
    expect(body[0]).toBe(0xff)
    expect(Array.from(body.slice(32))).toEqual([4, 3, 2, 1])
  })
})

describe('combineSpendProbes', () => {
  it('prefers a named spender, then an unspent answer', () => {
    const spent = { kind: 'spent' as const, spender: OTHER }
    expect(combineSpendProbes({ kind: 'unspent' }, spent)).toEqual(spent)
    expect(combineSpendProbes(undefined, { kind: 'unspent' })).toEqual({ kind: 'unspent' })
    expect(combineSpendProbes({ kind: 'unknown' }, undefined)).toEqual({ kind: 'unknown' })
  })
})

function signedOverProoflessParent(): { txid: string; tx: number[]; input: string } {
  const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
  const parent = new Transaction()
  parent.addInput({ sourceTXID: '66'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() })
  parent.addOutput({ lockingScript: lock, satoshis: 1_000 })
  const signed = new Transaction()
  signed.addInput({ sourceTXID: parent.id('hex'), sourceOutputIndex: 0, unlockingScript: new Script() })
  signed.addOutput({ lockingScript: lock, satoshis: 900 })
  const beef = new Beef()
  beef.mergeRawTx(parent.toBinary())
  beef.mergeRawTx(signed.toBinary())
  const txid = signed.id('hex')
  return { txid, tx: Array.from(beef.toBinaryAtomic(txid)), input: `${parent.id('hex')}.0` }
}

function signedOverMinedParent(): { txid: string; tx: number[]; input: string } {
  const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
  const parent = new Transaction()
  parent.addInput({ sourceTXID: '55'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() })
  parent.addOutput({ lockingScript: lock, satoshis: 1_000 })
  parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 900_000)
  const signed = new Transaction()
  signed.addInput({ sourceTXID: parent.id('hex'), sourceOutputIndex: 0, unlockingScript: new Script() })
  signed.addOutput({ lockingScript: lock, satoshis: 900 })
  const beef = new Beef()
  beef.mergeTransaction(parent)
  beef.mergeRawTx(signed.toBinary())
  const txid = signed.id('hex')
  return { txid, tx: Array.from(beef.toBinaryAtomic(txid)), input: `${parent.id('hex')}.0` }
}

describe('retireCreateActionSpentElsewhere', () => {
  afterEach(() => {
    retireCalls.length = 0
    sweeps.length = 0
    resetClearedOutpointsForTests()
    vi.unstubAllGlobals()
  })

  it('fails the signed tx before hiding its dead inputs, so the fail cannot restore them', async () => {
    const { txid, tx, input } = signedOverMinedParent()
    vi.stubGlobal('fetch', bulkFetch(spentBy(OTHER)))

    await expect(retireCreateActionSpentElsewhere({ txid, tx }, 'main')).resolves.toBe(true)
    expect(retireCalls).toEqual([`fail ${txid}`, `hide ${input} by ${OTHER}`])
  })

  it('retires a coin a confirmed tx spent even when its parent rides without a proof', async () => {
    const { txid, tx, input } = signedOverProoflessParent()
    vi.stubGlobal('fetch', bulkFetch(spentBy(OTHER)))

    await expect(retireCreateActionSpentElsewhere({ txid, tx }, 'main')).resolves.toBe(true)
    expect(retireCalls).toEqual([`fail ${txid}`, `hide ${input} by ${OTHER}`])
  })

  it('skips the descendant walk for a tx signed in this spend region and sweeps the pool', async () => {
    const { txid, tx, input } = signedOverMinedParent()
    vi.stubGlobal('fetch', bulkFetch(spentBy(OTHER)))

    await expect(
      retireCreateActionSpentElsewhere({ txid, tx }, 'main', { freshlySigned: true }),
    ).resolves.toBe(true)
    expect(retireCalls).toEqual([`fail ${txid} fresh`, `hide ${input} by ${OTHER}`])
    await vi.waitFor(() => expect(sweeps).toEqual(['main']))
  })
})

describe('foreignConfirmedInputSpends', () => {
  afterEach(() => {
    resetClearedOutpointsForTests()
    vi.unstubAllGlobals()
  })

  it('clears an unspent coin and does not ask about it again on the next sign', async () => {
    const { txid, tx, input } = signedOverMinedParent()
    const fetch = bulkFetch(() => ({}))
    vi.stubGlobal('fetch', fetch)

    await expect(foreignConfirmedInputSpends({ txid, tx }, 'main')).resolves.toEqual([])
    expect(outpointRecentlyCleared(input)).toBe(true)
    await expect(foreignConfirmedInputSpends({ txid, tx }, 'main')).resolves.toEqual([])
    expect(wocCalls(fetch)).toBe(1)
  })

  it('never clears a coin on a rate limit or an unconfirmed spender', async () => {
    const { txid, tx, input } = signedOverMinedParent()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })),
    )
    await foreignConfirmedInputSpends({ txid, tx }, 'main')
    expect(outpointRecentlyCleared(input)).toBe(false)

    vi.stubGlobal('fetch', bulkFetch(spentBy(OTHER, 'unconfirmed')))
    await foreignConfirmedInputSpends({ txid, tx }, 'main')
    expect(outpointRecentlyCleared(input)).toBe(false)
  })
})
