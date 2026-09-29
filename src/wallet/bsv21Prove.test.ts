import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { encodeBsv21Binary } from './token'
import {
  collectBsv21TokenAncestryTxids,
  fillTokenParentBodies,
  prove,
} from './token'

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
      encoding: 'binary',
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

  it('collects only token ancestors for pre-sign validity checks', () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const fundingTxid = 'fa'.repeat(32)
    const split = spend(
      [{ tx: deploy, vout: 0 }],
      [valueScript(id, 60n), valueScript(id, 40n)],
      { txid: fundingTxid },
    )
    const tip = `${split.id('hex')}_0`

    expect(
      collectBsv21TokenAncestryTxids({
        outpoints: [tip],
        tokenId: id,
        beef: beefOf(split),
      }),
    ).toEqual(expect.arrayContaining([split.id('hex'), deploy.id('hex')]))
    expect(
      collectBsv21TokenAncestryTxids({
        outpoints: [tip],
        tokenId: id,
        beef: beefOf(split),
      }),
    ).not.toContain(fundingTxid)
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

  describe('mixed encodings (BRC-176: decode both BRC-161 JSON and BRC-162 binary)', () => {
    const jsonScript = (body: Record<string, unknown>) => {
      const json = new TextEncoder().encode(JSON.stringify(body))
      const mime = new TextEncoder().encode('application/bsv-20')
      const push = (b: Uint8Array) =>
        `${b.length >= 76 ? '4c' : ''}${b.length.toString(16).padStart(2, '0')}${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
      // OP_FALSE OP_IF "ord" OP_1 <mime> OP_0 <body> OP_ENDIF ‖ P2PKH
      return LockingScript.fromHex(
        `0063036f726451${push(mime)}00${push(json)}68${P2PKH_REST}`,
      )
    }

    it('proves a binary transfer whose deploy is a BRC-161 JSON deploy+mint', () => {
      const deploy = new Transaction()
      deploy.addOutput({
        satoshis: 1,
        lockingScript: jsonScript({ p: 'bsv-20', op: 'deploy+mint', amt: '500', sym: 'MIX' }),
      })
      const id = tokenIdOf(deploy)
      const tip = spend([{ tx: deploy, vout: 0 }], [valueScript(id, 500n)])
      expect(prove(`${tip.id('hex')}_0`, beefOf(tip))).toMatchObject({
        ok: true,
        tokenId: id,
        amount: 500n,
        deployOutpoint: id,
        encoding: 'binary',
      })
    })

    it('proves a JSON transfer under a binary deploy and reports its encoding', () => {
      const deploy = deployTx(100n)
      const id = tokenIdOf(deploy)
      const tip = spend(
        [{ tx: deploy, vout: 0 }],
        [jsonScript({ p: 'bsv-20', op: 'transfer', id, amt: '100' })],
      )
      expect(prove(`${tip.id('hex')}_0`, beefOf(tip))).toMatchObject({
        ok: true,
        tokenId: id,
        amount: 100n,
        encoding: 'json',
      })
    })

    it('counts a burn toward outputs and refuses a burn as the subject', () => {
      const deploy = deployTx(100n)
      const id = tokenIdOf(deploy)
      const tx = spend(
        [{ tx: deploy, vout: 0 }],
        [valueScript(id, 60n), jsonScript({ p: 'bsv-20', op: 'burn', id, amt: '50' })],
      )
      const over = prove(`${tx.id('hex')}_0`, beefOf(tx))
      expect(over.ok).toBe(false)
      if (!over.ok) expect(over.reason).toMatch(/over-transfer/)

      const okTx = spend(
        [{ tx: deploy, vout: 0 }],
        [valueScript(id, 60n), jsonScript({ p: 'bsv-20', op: 'burn', id, amt: '40' })],
      )
      expect(prove(`${okTx.id('hex')}_0`, beefOf(okTx))).toMatchObject({ ok: true, amount: 60n })
      const burnSubject = prove(`${okTx.id('hex')}_1`, beefOf(okTx))
      expect(burnSubject.ok).toBe(false)
      if (!burnSubject.ok) expect(burnSubject.reason).toMatch(/burn/)
    })

    it('fails closed on an authority-model lineage (deploy+auth / mint)', () => {
      const auth = new Transaction()
      auth.addOutput({
        satoshis: 1,
        lockingScript: jsonScript({ p: 'bsv-20', op: 'deploy+auth', sym: 'AUTH' }),
      })
      const id = tokenIdOf(auth)
      const mint = spend(
        [{ tx: auth, vout: 0 }],
        [
          jsonScript({ p: 'bsv-20', op: 'auth', id }),
          jsonScript({ p: 'bsv-20', op: 'mint', id, amt: '1000' }),
        ],
      )
      const tip = spend([{ tx: mint, vout: 1 }], [valueScript(id, 1000n)])
      const result = prove(`${tip.id('hex')}_0`, beefOf(tip, mint))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/authority/)
    })
  })

  it('fills a missing deploy body from fetch without needing merkle proofs', async () => {
    const deploy = deployTx(100n)
    const id = tokenIdOf(deploy)
    const split = new Transaction()
    split.addInput({
      sourceTXID: deploy.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
    })
    split.addOutput({ satoshis: 1, lockingScript: valueScript(id, 100n) })

    const tipOnly = new Beef()
    tipOnly.mergeTransaction(split)
    expect(prove(`${split.id('hex')}_0`, tipOnly).ok).toBe(false)

    const filled = await fillTokenParentBodies(
      tipOnly,
      async (txid) => (txid === deploy.id('hex') ? beefOf(deploy) : null),
      [split.id('hex')],
    )
    expect(prove(`${split.id('hex')}_0`, filled)).toMatchObject({
      ok: true,
      tokenId: id,
      amount: 100n,
      deployOutpoint: id,
    })
  })
})
