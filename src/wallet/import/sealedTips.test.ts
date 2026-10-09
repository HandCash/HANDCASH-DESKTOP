import { describe, expect, it, vi } from 'vitest'
import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { settleSealedTips, type SealerPorts } from './sealedTips'

const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress())
const tip = (n: number) => ({ txid: n.toString(16).padStart(64, '0'), outpoint: `${n.toString(16).padStart(64, '0')}.0` })

/** An item-migrate leg: tips as its first inputs, one dest output each, then change. */
function leg(tips: Array<{ txid: string }>) {
  const tx = new Transaction()
  for (const t of tips) tx.addInput({ sourceTXID: t.txid, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addInput({ sourceTXID: 'f'.repeat(64), sourceOutputIndex: 1, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 900 })
  for (const _ of tips) tx.addOutput({ lockingScript: dest, satoshis: 1 })
  const beef = new Beef()
  beef.mergeRawTx(tx.toBinary())
  return { txid: tx.id('hex'), atomic: beef.toBinaryAtomic(tx.id('hex')) }
}

function ports(over: Partial<SealerPorts> & { seals: Map<string, string> }): SealerPorts {
  return {
    sealedSpenderOf: (outpoint) => over.seals.get(outpoint) ?? null,
    txExistsOnChain: async () => false,
    signedBody: async () => null,
    submit: async () => ({ kind: 'accepted' }),
    ...over,
  }
}

describe('settleSealedTips', () => {
  it('cashes an unlanded leg of this wallet: its tips are moved by it, each at its own output', async () => {
    const tips = [tip(1), tip(2)]
    const sealer = leg(tips)
    const submit = vi.fn(async () => ({ kind: 'accepted' }))
    const seals = new Map(tips.map((t) => [t.outpoint, sealer.txid]))
    const loose = tip(3)
    const result = await settleSealedTips([...tips, loose], dest.toHex(), ports({
      seals,
      signedBody: async (txid) => (txid === sealer.txid ? sealer.atomic : null),
      submit,
    }))

    expect(submit).toHaveBeenCalledWith(sealer.txid, sealer.atomic)
    expect(result.moved).toEqual([
      { item: tips[0], txid: sealer.txid, vout: 1 },
      { item: tips[1], txid: sealer.txid, vout: 2 },
    ])
    expect(result.free).toEqual([loose])
    expect(result.sealers.get(sealer.txid)?.kind).toBe('pushed')
  })

  it('answers tips gone when the sealing transaction is on chain, without posting it', async () => {
    const tips = [tip(4)]
    const submit = vi.fn()
    const result = await settleSealedTips(tips, dest.toHex(), ports({
      seals: new Map([[tips[0]!.outpoint, 'a'.repeat(64)]]),
      txExistsOnChain: async () => true,
      submit,
    }))
    expect(result.gone).toEqual(tips)
    expect(submit).not.toHaveBeenCalled()
  })

  it('rebuilds tips whose sealer miners hard-rejected, once the seal is released', async () => {
    const tips = [tip(5)]
    const sealer = leg(tips)
    const seals = new Map([[tips[0]!.outpoint, sealer.txid]])
    const result = await settleSealedTips(tips, dest.toHex(), ports({
      seals,
      signedBody: async () => sealer.atomic,
      submit: async () => {
        seals.delete(tips[0]!.outpoint)
        throw new Error('ARC 461 malformed')
      },
    }))
    expect(result.released).toEqual(tips)
  })

  it('holds tips it cannot decide: no body, a queued retry, or a reject that kept the seal', async () => {
    const a = tip(6)
    const b = tip(7)
    const c = tip(8)
    const seals = new Map([
      [a.outpoint, '1'.repeat(64)],
      [b.outpoint, '2'.repeat(64)],
      [c.outpoint, '3'.repeat(64)],
    ])
    const result = await settleSealedTips([a, b, c], dest.toHex(), ports({
      seals,
      signedBody: async (txid) => (txid === '1'.repeat(64) ? null : [1, 2, 3]),
      submit: async (txid) => {
        if (txid === '2'.repeat(64)) return { kind: 'queued', reason: 'transport' }
        throw new Error('conflict unproven')
      },
    }))
    expect(result.held).toEqual([a, b, c])
    expect([...result.sealers.values()].map((f) => (f.kind === 'held' ? f.reason : f.kind))).toEqual([
      'no signed body on this device',
      'queued (transport)',
      'conflict unproven',
    ])
  })
})
