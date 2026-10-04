import { beforeEach, describe, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { encodeBsv21Binary } from './token/decode162'

const ours = PrivateKey.fromRandom().toAddress()
const theirs = PrivateKey.fromRandom().toAddress()

const h = vi.hoisted(() => ({
  hex: null as string | null,
  spent: new Set<string>(),
  classify: vi.fn(),
  importTokens: vi.fn(),
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
vi.mock('./token/list', () => ({
  importBsv21Tokens: (...args: unknown[]) => h.importTokens(...args),
  listFungibles: async () => [],
}))

import { parseRecoverTxid, recoverFromTx } from './recoverFromTx'

function buildTx(): Transaction {
  const tx = new Transaction()
  const tokenId = `${'ab'.repeat(32)}_0`
  tx.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({ tokenId, amount: 420n, rest: new P2PKH().lock(ours) }),
  })
  tx.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({ tokenId, amount: 580n, rest: new P2PKH().lock(theirs) }),
  })
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
      bsv21: utxos
        .filter((u) => u.vout === 0)
        .map((u) => ({ ...u, tokenId: `${'ab'.repeat(32)}_0`, amt: '420', op: 'transfer' })),
      oneSats: [],
      heldOneSats: utxos.filter((u) => u.vout !== 0),
      funding: [],
      heldUneconomical: [],
      pendingTips: [],
    }))
    h.importTokens.mockReset().mockResolvedValue({ imported: 1, failed: 0, errors: [], outpoints: [] })
    h.importItems.mockReset().mockResolvedValue({ imported: 0, failed: 0, errors: [], outpoints: [] })
  })

  it('claims only unspent one-sat outputs locked to this wallet', async () => {
    const result = await recoverFromTx(txid.toUpperCase())
    const classified = h.classify.mock.calls[0][0] as { vout: number }[]
    expect(classified.map((u) => u.vout)).toEqual([0, 2])
    expect(h.importTokens).toHaveBeenCalledTimes(1)
    expect(h.importTokens.mock.calls[0][2]).toEqual({ requireLineage: true })
    expect(result).toEqual({ ours: 2, spent: 0, tokens: 1, items: 0, unrecognized: 1, skipped: 0 })
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
    expect((h.classify.mock.calls[0][0] as { vout: number }[]).map((u) => u.vout)).toEqual([2])
    expect(result.spent).toBe(1)
    expect(result.tokens).toBe(0)
  })

  it('claims an output the caller just proved unspent when the explorers here stay silent', async () => {
    h.spent.add(`${txid}.0`)
    const only = new Set([`${txid}.0`])
    const result = await recoverFromTx(txid, { only, provenUnspent: only })
    expect((h.classify.mock.calls[0][0] as { vout: number }[]).map((u) => u.vout)).toEqual([0])
    expect(result).toMatchObject({ ours: 1, spent: 0, tokens: 1 })
  })

  it('reports nothing for a transaction that does not pay this wallet', async () => {
    h.address = PrivateKey.fromRandom().toAddress()
    const result = await recoverFromTx(txid)
    expect(result).toEqual({ ours: 0, spent: 0, tokens: 0, items: 0, unrecognized: 0, skipped: 0 })
    expect(h.importTokens).not.toHaveBeenCalled()
  })

  it('fails closed on a failed import and an unknown transaction', async () => {
    h.importTokens.mockResolvedValue({ imported: 0, failed: 1, errors: ['lineage-unproven:depth'], outpoints: [] })
    await expect(recoverFromTx(txid)).rejects.toThrow('lineage-unproven:depth')
    h.hex = null
    await expect(recoverFromTx(txid)).rejects.toThrow(/not found/)
  })

  it('refuses anything but a txid', () => {
    expect(() => parseRecoverTxid('abc')).toThrow(/64-character/)
    expect(parseRecoverTxid(` ${'A'.repeat(64)} `)).toBe('a'.repeat(64))
  })
})
