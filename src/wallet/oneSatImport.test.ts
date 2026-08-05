import { describe, expect, it, vi } from 'vitest'
import { classifyLegacyUtxos } from './oneSatImport'
import type { LegacyUtxo } from './legacyScan'

function utxo(outpoint: string, satoshis: number): LegacyUtxo {
  const [txid, vout] = outpoint.split('.')
  return { outpoint, txid: txid!, vout: Number(vout), satoshis }
}

const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)

describe('classifyLegacyUtxos', () => {
  it('sweeps a cloud-named outpoint that actually holds funds', async () => {
    // Basket `1sat` is excluded from spendable balance, so a mis-reported item
    // would silently remove real money from the wallet.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await classifyLegacyUtxos(
      [utxo(`${TXID_A}.0`, 50_000)],
      'main',
      [{ outpoint: `${TXID_A}.0`, origin: `${TXID_A}_0` }],
    )
    warn.mockRestore()

    expect(result.oneSats).toEqual([])
    expect(result.funding.map((u) => u.outpoint)).toEqual([`${TXID_A}.0`])
  })

  it('keeps a cloud-named outpoint that really is one satoshi', async () => {
    const result = await classifyLegacyUtxos(
      [utxo(`${TXID_A}.0`, 1)],
      'main',
      [{ outpoint: `${TXID_A}.0`, origin: `${TXID_A}_0` }],
    )

    expect(result.oneSats.map((i) => i.outpoint)).toEqual([`${TXID_A}.0`])
    expect(result.funding).toEqual([])
  })

  it('matches cloud items against the scan regardless of outpoint casing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await classifyLegacyUtxos(
      [utxo(`${TXID_A.toUpperCase()}.0`, 50_000)],
      'main',
      [{ outpoint: `${TXID_A}.0` }],
    )
    warn.mockRestore()

    expect(result.oneSats).toEqual([])
    expect(result.funding).toHaveLength(1)
  })

  it('still trusts cloud items that are not in the legacy scan', async () => {
    // These live on the migrate destination tx, not the legacy address.
    const result = await classifyLegacyUtxos([], 'main', [
      { outpoint: `${TXID_B}.1`, origin: `${TXID_B}_1` },
    ])

    expect(result.oneSats.map((i) => i.outpoint)).toEqual([`${TXID_B}.1`])
  })

  it('never sweeps unresolvable one-sat outputs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    const result = await classifyLegacyUtxos([utxo(`${TXID_B}.0`, 1)], 'main', [])
    vi.unstubAllGlobals()

    expect(result.funding).toEqual([])
    expect(result.heldOneSats.map((u) => u.outpoint)).toEqual([`${TXID_B}.0`])
  })
})
