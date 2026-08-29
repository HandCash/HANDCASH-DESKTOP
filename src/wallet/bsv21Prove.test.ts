import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { encodeBsv21Binary } from './bsv21Binary'
import { prove } from './bsv21Prove'

const P2PKH_REST = `76a914${'11'.repeat(20)}88ac`

function deployTx(amount: bigint, sym = 'GOLD'): Transaction {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({
      amount,
      payload: { sym, dec: 0 },
      rest: P2PKH_REST,
    }),
  })
  return tx
}

function tokenIdOf(tx: Transaction, vout = 0): string {
  return `${tx.id('hex')}_${vout}`
}

function valueScript(tokenId: string, amount: bigint) {
  return encodeBsv21Binary({
    tokenId,
    amount,
    rest: P2PKH_REST,
  })
}

function spend(
  parents: { tx: Transaction; vout: number }[],
  outputs: ReturnType<typeof valueScript>[],
  funding?: { txid: string; vout?: number },
): Transaction {
  const tx = new Transaction()
  if (funding) {
    tx.addInput({
      sourceTXID: funding.txid,
      sourceOutputIndex: funding.vout ?? 0,
      unlockingScript: new UnlockingScript(),
    })
  }
  for (const p of parents) {
    tx.addInput({
      sourceTransaction: p.tx,
      sourceOutputIndex: p.vout,
      unlockingScript: new UnlockingScript(),
    })
  }
  for (const lockingScript of outputs) {
    tx.addOutput({ satoshis: 1, lockingScript })
  }
  return tx
}

function beefOf(...txs: Transaction[]): Beef {
  const beef = new Beef()
  for (const tx of txs) beef.mergeTransaction(tx)
  return beef
}

describe('bsv21Prove', () => {
  it('proves a fixed-supply deploy as genesis', () => {
    const deploy = deployTx(1000n)
    const outpoint = tokenIdOf(deploy)
    expect(prove(outpoint, beefOf(deploy))).toEqual({
      ok: true,
      tokenId: outpoint,
      amount: 1000n,
      deployOutpoint: outpoint,
      role: 'deploy',
    })
  })

  it('proves a split that conserves supply', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const split = spend(
      [{ tx: deploy, vout: 0 }],
      [valueScript(id, 60n), valueScript(id, 40n)],
    )
    const beef = beefOf(split)
    expect(prove(`${split.id('hex')}_0`, beef)).toMatchObject({
      ok: true,
      tokenId: id,
      amount: 60n,
      deployOutpoint: id,
      role: 'value',
    })
    expect(prove(`${split.id('hex')}_1`, beef)).toMatchObject({
      ok: true,
      tokenId: id,
      amount: 40n,
      deployOutpoint: id,
    })
  })

  it('proves a merge when every same-id parent is present', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const split = spend(
      [{ tx: deploy, vout: 0 }],
      [valueScript(id, 60n), valueScript(id, 40n)],
    )
    const merged = spend(
      [
        { tx: split, vout: 0 },
        { tx: split, vout: 1 },
      ],
      [valueScript(id, 100n)],
    )
    expect(prove(`${merged.id('hex')}_0`, beefOf(merged))).toMatchObject({
      ok: true,
      tokenId: id,
      amount: 100n,
      deployOutpoint: id,
    })
  })

  it('fails over-transfer (outputs exceed inputs)', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const over = spend(
      [{ tx: deploy, vout: 0 }],
      [valueScript(id, 60n), valueScript(id, 50n)],
    )
    const result = prove(`${over.id('hex')}_0`, beefOf(over))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/over-transfer/)
  })

  it('fails when a token-parent body is missing', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const split = new Transaction()
    split.addInput({
      sourceTXID: deploy.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    split.addOutput({ satoshis: 1, lockingScript: valueScript(id, 100n) })

    const beef = new Beef()
    beef.mergeTransaction(split)
    const result = prove(`${split.id('hex')}_0`, beef)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/missing token-parent/)
  })

  it('fails a merge that omits a same-id parent body', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const left = spend([{ tx: deploy, vout: 0 }], [valueScript(id, 60n)])
    const right = new Transaction()
    right.addOutput({ satoshis: 1, lockingScript: valueScript(id, 40n) })

    const merged = new Transaction()
    merged.addInput({
      sourceTransaction: left,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    merged.addInput({
      sourceTXID: right.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    merged.addOutput({ satoshis: 1, lockingScript: valueScript(id, 100n) })

    const result = prove(`${merged.id('hex')}_0`, beefOf(merged))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/over-transfer|missing token-parent/)
    }
  })

  it('allows funding inputs to be absent from the BEEF', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const tip = spend(
      [{ tx: deploy, vout: 0 }],
      [valueScript(id, 100n)],
      { txid: 'cd'.repeat(32) },
    )
    expect(prove(`${tip.id('hex')}_0`, beefOf(tip))).toMatchObject({
      ok: true,
      tokenId: id,
      amount: 100n,
    })
  })

  it('rejects a non-BSV21 subject', () => {
    const other = new Transaction()
    other.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(P2PKH_REST),
    })
    const result = prove(`${other.id('hex')}_0`, beefOf(other))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/not BSV-21/)
  })
})
