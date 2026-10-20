import { beforeEach, describe, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'

const ours = PrivateKey.fromRandom().toAddress()
const theirs = PrivateKey.fromRandom().toAddress()

/** `OP_FALSE OP_IF "ord" OP_1 <text/plain> OP_0 <hi> OP_ENDIF` */
const ORD_ENVELOPE = '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'
/** `<push 36-byte id> OP_7 OP_2DROP` */
const BRC162_PREFIX = '24' + 'ab'.repeat(36) + '57' + '6d'

const h = vi.hoisted(() => ({
  hex: null as string | null,
  spent: new Set<string>(),
  classify: vi.fn(),
  importItems: vi.fn(),
  address: '',
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({ address: h.address, chain: 'main' }),
}))
vi.mock('./oneSatImport', () => ({
  fetchRawTxHex: async () => h.hex,
  classifyLegacyUtxos: (...args: unknown[]) => h.classify(...args),
  importOneSatOrdinals: (...args: unknown[]) => h.importItems(...args),
}))
vi.mock('./staleOutputRelease', () => ({
  outpointProvenUnspent: async (_active: unknown, outpoint: string) => !h.spent.has(outpoint),
}))

import { parseRecoverTxid, recoverFromTx } from './recoverFromTx'

function buildTx(): Transaction {
  const tx = new Transaction()
  const lock = (address: string) => new P2PKH().lock(address).toHex()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(lock(ours) + ORD_ENVELOPE) })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(lock(theirs) + ORD_ENVELOPE) })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex(BRC162_PREFIX + lock(ours)) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(ours) })
  tx.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(ours) })
  return tx
}

describe('recoverFromTx', () => {
  let txid: string

  beforeEach(() => {
    const tx = buildTx()
    h.hex = tx.toHex()
    txid = tx.id('hex')
    h.address = ours
    h.spent = new Set()
    h.classify.mockReset().mockImplementation(async (utxos: { outpoint: string; txid: string; vout: number }[]) => ({
      oneSats: utxos.filter((u) => u.vout === 0),
      heldOneSats: utxos.filter((u) => u.vout !== 0),
      funding: [],
      heldUneconomical: [],
      pendingTips: [],
    }))
    h.importItems.mockReset().mockResolvedValue({ imported: 1, failed: 0, errors: [], outpoints: [] })
  })

  it('claims only unspent one-sat outputs locked to this wallet, never a BRC-162 token', async () => {
    const result = await recoverFromTx(txid.toUpperCase())
    const classified = h.classify.mock.calls[0][0] as { vout: number }[]
    expect(classified.map((u) => u.vout)).toEqual([0, 3])
    expect(h.importItems).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ours: 2, spent: 0, items: 1, unrecognized: 1, skipped: 0 })
  })

  it('does not count our lock carried as data in someone else\'s output', async () => {
    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1,
      lockingScript: Script.fromHex(`006a19${new P2PKH().lock(ours).toHex()}`),
    })
    tx.addOutput({
      satoshis: 1,
      lockingScript: Script.fromHex(`${new P2PKH().lock(theirs).toHex()}6a19${new P2PKH().lock(ours).toHex()}`),
    })
    h.hex = tx.toHex()
    const result = await recoverFromTx(tx.id('hex'))
    expect(result.ours).toBe(0)
    expect(h.classify.mock.calls[0][0]).toEqual([])
  })

  it('skips outputs already spent on chain', async () => {
    h.spent.add(`${txid}.0`)
    const result = await recoverFromTx(txid)
    expect((h.classify.mock.calls[0][0] as { vout: number }[]).map((u) => u.vout)).toEqual([3])
    expect(result.spent).toBe(1)
    expect(result.items).toBe(0)
  })

  it('claims an output the caller just proved unspent when the explorers here stay silent', async () => {
    h.spent.add(`${txid}.0`)
    const only = new Set([`${txid}.0`])
    const result = await recoverFromTx(txid, { only, provenUnspent: only })
    expect((h.classify.mock.calls[0][0] as { vout: number }[]).map((u) => u.vout)).toEqual([0])
    expect(result).toMatchObject({ ours: 1, spent: 0, items: 1 })
  })

  it('reports nothing for a transaction that does not pay this wallet', async () => {
    h.address = PrivateKey.fromRandom().toAddress()
    const result = await recoverFromTx(txid)
    expect(result).toEqual({ ours: 0, spent: 0, items: 0, unrecognized: 0, skipped: 0 })
    expect(h.importItems).not.toHaveBeenCalled()
  })

  it('fails closed on a failed import and an unknown transaction', async () => {
    h.importItems.mockResolvedValue({ imported: 0, failed: 1, errors: ['origin-unproven'], outpoints: [] })
    await expect(recoverFromTx(txid)).rejects.toThrow('origin-unproven')
    h.hex = null
    await expect(recoverFromTx(txid)).rejects.toThrow(/not found/)
  })

  it('refuses anything but a txid', () => {
    expect(() => parseRecoverTxid('abc')).toThrow(/64-character/)
    expect(parseRecoverTxid(` ${'A'.repeat(64)} `)).toBe('a'.repeat(64))
  })
})
