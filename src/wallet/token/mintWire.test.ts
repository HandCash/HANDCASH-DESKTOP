import { describe, expect, it } from 'vitest'
import { decodeBsv21Binary, encodeBsv21Binary } from './decode162'
import { planBsv21MintWire } from './mintWire'
import { prove } from './prove176'
import { Beef, Transaction, LockingScript } from '@bsv/sdk'

const P2PKH = `76a9142e30393bc832598960748a4b3479d9f6473bbc5f88ac`

function hex(text: string): string {
  return Array.from(new TextEncoder().encode(text))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function jsonDeploy(body: Record<string, unknown>): string {
  const bodyHex = hex(JSON.stringify(body))
  const len = bodyHex.length / 2
  const push =
    len <= 75
      ? len.toString(16).padStart(2, '0')
      : `4c${len.toString(16).padStart(2, '0')}`
  return (
    '0063036f726451' +
    '12' +
    hex('application/bsv-20') +
    '00' +
    push +
    bodyHex +
    '68' +
    P2PKH
  )
}

describe('planBsv21MintWire', () => {
  /** The COPE mint as Mint Studio issued it. */
  const cope = {
    p: 'bsv-20',
    op: 'deploy+mint',
    sym: 'COPE',
    amt: '4444444',
    dec: 0,
    icon: 'b30338c15080cc0775c64af3572e156f8ba96037550d0f3466bb9320fe6697e2_0',
  }

  it('re-expresses a legacy JSON genesis as a provable BRC-162 lock', () => {
    const wire = planBsv21MintWire(jsonDeploy(cope))
    expect(wire.kind).toBe('upgrade')
    if (wire.kind !== 'upgrade') return

    const decoded = decodeBsv21Binary(wire.lockingScript)
    expect(decoded?.role).toBe('deploy')
    expect(decoded?.amount).toBe(4_444_444n)
    expect(decoded?.payload?.sym).toBe('COPE')
    expect(decoded?.payload?.dec).toBe(0)
    // The icon travels as a 36-byte outpoint reference, not a JSON string.
    expect(decoded?.payload?.icon).toHaveLength(36)
    // Spend conditions are untouched: same P2PKH, same owner.
    expect(decoded?.restScriptHex).toBe(P2PKH)
  })

  it('the upgraded genesis proves under BRC-176 — the JSON one cannot', () => {
    const wire = planBsv21MintWire(jsonDeploy(cope))
    if (wire.kind !== 'upgrade') throw new Error('expected an upgrade')

    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(wire.lockingScript),
    })
    const beef = new Beef()
    beef.mergeTransaction(tx)

    const proof = prove(`${tx.id('hex')}_0`, beef)
    expect(proof.ok).toBe(true)
    expect(proof.ok && proof.role).toBe('deploy')
    expect(proof.ok && proof.amount).toBe(4_444_444n)
  })

  it('leaves a genesis already written as BRC-162 alone', () => {
    const script = encodeBsv21Binary({
      amount: 1_000n,
      payload: { sym: 'KING' },
      rest: P2PKH,
    })
      .toHex()
      .toLowerCase()
    expect(planBsv21MintWire(script)).toEqual({ kind: 'binary' })
  })

  it('keeps anything it cannot re-express exactly, with a reason', () => {
    // Authority deploys carry no supply, and BRC-162 has no amount 0 holding.
    expect(
      planBsv21MintWire(jsonDeploy({ p: 'bsv-20', op: 'deploy+auth', sym: 'X' })),
    ).toMatchObject({ kind: 'keep', reason: 'op deploy+auth' })
    expect(
      planBsv21MintWire(jsonDeploy({ ...cope, amt: 'lots' })),
    ).toMatchObject({ kind: 'keep', reason: 'no integer amt' })
    // A non-P2PKH tail means we cannot carry the spend conditions over.
    expect(
      planBsv21MintWire(jsonDeploy(cope).replace(new RegExp(`${P2PKH}$`), '51')),
    ).toMatchObject({ kind: 'keep' })
    expect(planBsv21MintWire(P2PKH)).toMatchObject({ kind: 'keep' })
  })
})
