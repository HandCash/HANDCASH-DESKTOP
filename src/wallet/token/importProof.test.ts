import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { encodeBsv21Binary } from './decode162'
import { judgeTokenImport } from './importProof'
import { resetTokenLineageForTests } from './lineage'

const owner = PrivateKey.fromRandom().toAddress()

function chain(transferAmount = 1000n) {
  const deploy = new Transaction()
  deploy.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({ tokenId: '', amount: 1000n, rest: new P2PKH().lock(owner) }),
  })
  const tokenId = `${deploy.id('hex')}_0`
  const transfer = new Transaction()
  transfer.addInput({ sourceTransaction: deploy, sourceOutputIndex: 0, unlockingScript: new Script() })
  transfer.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({ tokenId, amount: transferAmount, rest: new P2PKH().lock(owner) }),
  })
  const full = new Beef()
  full.mergeRawTx(deploy.toBinary())
  full.mergeRawTx(transfer.toBinary())
  const tipOnly = new Beef()
  tipOnly.mergeRawTx(transfer.toBinary())
  const deployOnly = new Beef()
  deployOnly.mergeRawTx(deploy.toBinary())
  return { tokenId, txid: transfer.id('hex'), full, tipOnly, deployOnly }
}

const base = { vout: 0, op: 'transfer' as const, amt: '1000' }

describe('judgeTokenImport', () => {
  beforeEach(() => resetTokenLineageForTests())

  it('proves a tip whose walk reaches its deploy', async () => {
    const c = chain()
    const verdict = await judgeTokenImport({
      ...base,
      beef: c.full,
      txid: c.txid,
      tokenId: c.tokenId,
      requireLineage: true,
      fetchBody: async () => null,
    })
    expect(verdict).toEqual({ kind: 'proven', deployOutpoint: c.tokenId })
  })

  it('refuses a claim the tip bytes contradict', async () => {
    const c = chain()
    const common = { beef: c.full, txid: c.txid, requireLineage: false, fetchBody: async () => null }
    expect(await judgeTokenImport({ ...common, ...base, tokenId: c.tokenId, amt: '999' })).toEqual({
      kind: 'refused',
      reason: 'amount-mismatch',
    })
    const other = await judgeTokenImport({ ...common, ...base, tokenId: `${'cd'.repeat(32)}_0` })
    expect(other.kind).toBe('refused')
    expect(other.kind === 'refused' && other.reason).toMatch(/^token-id-mismatch/)
  })

  it('files a tip it cannot walk yet as unproven for chain ingest, and never fetches', async () => {
    const c = chain()
    const fetchBody = vi.fn(async () => null)
    const verdict = await judgeTokenImport({
      ...base,
      beef: c.tipOnly,
      txid: c.txid,
      tokenId: c.tokenId,
      requireLineage: false,
      fetchBody,
    })
    expect(verdict.kind).toBe('unproven')
    expect(fetchBody).not.toHaveBeenCalled()
  })

  it('fetches the parents a claim by txid needs, and refuses when they never come', async () => {
    const c = chain()
    const common = { ...base, beef: c.tipOnly, txid: c.txid, tokenId: c.tokenId, requireLineage: true }

    const refused = await judgeTokenImport({ ...common, fetchBody: async () => null })
    expect(refused.kind).toBe('refused')
    expect(refused.kind === 'refused' && refused.reason).toMatch(/^lineage-unproven:/)

    const proven = await judgeTokenImport({ ...common, fetchBody: async () => c.deployOnly })
    expect(proven).toEqual({ kind: 'proven', deployOutpoint: c.tokenId })
  })

  it('refuses an over-transfer a claim by txid cannot walk', async () => {
    const c = chain(2000n)
    const verdict = await judgeTokenImport({
      ...base,
      amt: '2000',
      beef: c.full,
      txid: c.txid,
      tokenId: c.tokenId,
      requireLineage: true,
      fetchBody: async () => null,
    })
    expect(verdict.kind === 'refused' && verdict.reason).toMatch(/^lineage-unproven:over-transfer/)
  })
})
