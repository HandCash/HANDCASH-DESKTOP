import { Beef, MerklePath, PrivateKey, P2PKH, Script, Transaction } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  foreignConfirmedInputSpends,
  inputsWithPossiblyMinedParent,
  outpointRecentlyCleared,
  parseBulkSpentEntry,
  parseConfirmedForeignSpender,
  probeOutpointSpends,
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

/** WhatsOnChain bulk `/utxos/spent`: `answer` builds each entry past `utxo`. */
function bulkFetch(answer: (utxo: Utxo) => Record<string, unknown>) {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const { utxos } = JSON.parse(init?.body ?? '{"utxos":[]}') as { utxos: Utxo[] }
    return {
      ok: true,
      status: 200,
      json: async () => utxos.map((utxo) => ({ utxo, error: '', ...answer(utxo) })),
    }
  })
}

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
    expect(parseBulkSpentEntry({ utxo, error: '' }, SELF)).toEqual({ kind: 'noConfirmedSpender' })
    expect(
      parseBulkSpentEntry({ utxo, spentIn: { txid: OTHER, status: 'confirmed' }, error: '' }, SELF),
    ).toEqual({ kind: 'confirmedSpender', spender: OTHER })
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

  it('asks twenty coins per request', async () => {
    const fetch = bulkFetch(() => ({}))
    vi.stubGlobal('fetch', fetch)
    const outpoints = Array.from({ length: 45 }, (_, i) => `${'12'.repeat(32)}.${i}`)
    const probes = await probeOutpointSpends(outpoints, '', 'main')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect([...probes.values()].every((p) => p.kind === 'noConfirmedSpender')).toBe(true)
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
})

describe('inputsWithPossiblyMinedParent', () => {
  const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress())

  function txFrom(prevTxids: string[]): Transaction {
    const tx = new Transaction()
    for (const sourceTXID of prevTxids) {
      tx.addInput({ sourceTXID, sourceOutputIndex: 0, unlockingScript: new Script() })
    }
    tx.addOutput({ lockingScript: lock, satoshis: 1_000 })
    return tx
  }

  it('skips inputs whose parent rides the BEEF unmined, probes the rest', () => {
    const mined = txFrom(['11'.repeat(32)])
    mined.merklePath = MerklePath.fromCoinbaseTxidAndHeight(mined.id('hex'), 900_000)
    const unmined = txFrom(['22'.repeat(32)])
    const txidOnly = '33'.repeat(32)
    const absent = '44'.repeat(32)
    const child = txFrom([mined.id('hex'), unmined.id('hex'), txidOnly, absent])

    const beef = new Beef()
    beef.mergeTransaction(mined)
    beef.mergeRawTx(unmined.toBinary())
    beef.mergeTxidOnly(txidOnly)
    beef.mergeRawTx(child.toBinary())
    const atomic = Array.from(beef.toBinaryAtomic(child.id('hex')))

    expect(inputsWithPossiblyMinedParent(atomic, child.id('hex'))).toEqual([
      `${mined.id('hex')}.0`,
      `${txidOnly}.0`,
      `${absent}.0`,
    ])
  })
})

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
    expect(fetch).toHaveBeenCalledOnce()
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
