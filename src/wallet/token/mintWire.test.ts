import { describe, expect, it } from 'vitest'
import { decodeBsv21Binary, encodeBsv21Binary } from './decode162'
import { bsv21DeployIconRef, planBsv21MintWire } from './mintWire'
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

  const PNG = { mediaType: 'image/png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }

  it('names the icon a JSON genesis points at', () => {
    expect(bsv21DeployIconRef(jsonDeploy(cope))).toEqual({ kind: 'outpoint', outpoint: cope.icon })
  })

  it('re-expresses a legacy JSON genesis as a current BRC-162 lock with the icon embedded', () => {
    const wire = planBsv21MintWire(jsonDeploy(cope), { vout: 0, iconImage: PNG })
    expect(wire.kind).toBe('upgrade')
    if (wire.kind !== 'upgrade') return
    expect(wire.iconDropped).toBeUndefined()

    const decoded = decodeBsv21Binary(wire.lockingScript)
    expect(decoded?.layout).toBe('brc162')
    expect(decoded?.role).toBe('deploy')
    expect(decoded?.amount).toBe(4_444_444n)
    expect(decoded?.payload?.sym).toBe('COPE')
    expect(decoded?.payload?.dec).toBe(0)
    expect(decoded?.payload?.iconImage).toEqual(PNG)
    expect(decoded?.payload?.icon).toBeUndefined()
    // Spend conditions are untouched: same P2PKH, same owner.
    expect(decoded?.restScriptHex).toBe(P2PKH)
  })

  it('still upgrades when the icon bytes are unavailable, and says so', () => {
    const wire = planBsv21MintWire(jsonDeploy(cope), { vout: 0 })
    expect(wire).toMatchObject({ kind: 'upgrade', iconDropped: true })
  })

  it('the upgraded genesis proves under BRC-176 — the JSON one cannot', () => {
    const wire = planBsv21MintWire(jsonDeploy(cope), { vout: 0, iconImage: PNG })
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
    expect(proof.ok && proof.layout).toBe('brc162')
  })

  it('leaves a current-layout genesis at output 0 alone', () => {
    const script = encodeBsv21Binary({
      amount: 1_000n,
      payload: { sym: 'KING' },
      rest: P2PKH,
    })
      .toHex()
      .toLowerCase()
    expect(planBsv21MintWire(script, { vout: 0 })).toEqual({ kind: 'binary' })
  })

  it('refuses a binary genesis at a nonzero output', () => {
    const script = encodeBsv21Binary({ amount: 1_000n, payload: { sym: 'KING' }, rest: P2PKH }).toHex()
    expect(planBsv21MintWire(script, { vout: 1 })).toMatchObject({ kind: 'refuse' })
  })

  it('re-expresses a draft-tagged genesis in the current layout', () => {
    const tagged = encodeBsv21Binary({
      layout: 'draft-tagged',
      amount: 500n,
      payload: { sym: 'OLD', icon: Uint8Array.from([1, 0, 0, 0]) },
      rest: P2PKH,
    }).toHex()
    expect(bsv21DeployIconRef(tagged)).toEqual({ kind: 'sameTx', vout: 1 })

    const wire = planBsv21MintWire(tagged, { vout: 0, iconImage: PNG })
    expect(wire.kind).toBe('upgrade')
    if (wire.kind !== 'upgrade') return
    expect(decodeBsv21Binary(wire.lockingScript)).toMatchObject({
      layout: 'brc162',
      role: 'deploy',
      amount: 500n,
      payload: { sym: 'OLD', iconImage: PNG },
      restScriptHex: P2PKH,
    })
  })

  it('refuses a draft-tagged genesis whose lock is not plain P2PKH', () => {
    const tagged = encodeBsv21Binary({ layout: 'draft-tagged', amount: 500n, rest: '51' }).toHex()
    expect(planBsv21MintWire(tagged, { vout: 0 })).toMatchObject({ kind: 'refuse' })
  })

  it('passes transfers through untouched', () => {
    const transfer = encodeBsv21Binary({ tokenId: `${'ab'.repeat(32)}_0`, amount: 5n, rest: P2PKH }).toHex()
    expect(planBsv21MintWire(transfer, { vout: 3 })).toEqual({ kind: 'binary' })
  })

  it('keeps anything it cannot re-express exactly, with a reason', () => {
    // Authority deploys carry no supply, and BRC-162 has no amount 0 holding.
    expect(
      planBsv21MintWire(jsonDeploy({ p: 'bsv-20', op: 'deploy+auth', sym: 'X' }), { vout: 0 }),
    ).toMatchObject({ kind: 'keep', reason: 'op deploy+auth' })
    expect(
      planBsv21MintWire(jsonDeploy({ ...cope, amt: 'lots' }), { vout: 0 }),
    ).toMatchObject({ kind: 'keep', reason: 'no integer amt' })
    // A non-P2PKH tail means we cannot carry the spend conditions over.
    expect(
      planBsv21MintWire(jsonDeploy(cope).replace(new RegExp(`${P2PKH}$`), '51'), { vout: 0 }),
    ).toMatchObject({ kind: 'keep' })
    // A JSON genesis at a nonzero output is valid BRC-161; a binary one would not be.
    expect(planBsv21MintWire(jsonDeploy(cope), { vout: 2 })).toMatchObject({ kind: 'keep' })
    expect(planBsv21MintWire(P2PKH, { vout: 0 })).toMatchObject({ kind: 'keep' })
  })
})
