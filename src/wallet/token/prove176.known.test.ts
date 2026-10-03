import { describe, expect, it } from 'vitest'
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { encodeBsv21Binary } from './decode162'
import { fillTokenParentBodies, prove } from './prove176'

const P2PKH = LockingScript.fromHex('76a9142e30393bc832598960748a4b3479d9f6473bbc5f88ac')

function chain() {
  const deploy = new Transaction()
  deploy.addOutput({ satoshis: 1, lockingScript: encodeBsv21Binary({ amount: 1000n, rest: P2PKH }) })
  const tokenId = `${deploy.id('hex')}_0`

  const hop1 = new Transaction()
  hop1.addInput({ sourceTransaction: deploy, sourceOutputIndex: 0, unlockingScript: new LockingScript() })
  hop1.addOutput({ satoshis: 1, lockingScript: encodeBsv21Binary({ tokenId, amount: 1000n, rest: P2PKH }) })

  const hop2 = new Transaction()
  hop2.addInput({ sourceTransaction: hop1, sourceOutputIndex: 0, unlockingScript: new LockingScript() })
  hop2.addOutput({ satoshis: 1, lockingScript: encodeBsv21Binary({ tokenId, amount: 600n, rest: P2PKH }) })
  hop2.addOutput({ satoshis: 1, lockingScript: encodeBsv21Binary({ tokenId, amount: 400n, rest: P2PKH }) })
  return { deploy, hop1, hop2, tokenId }
}

function bodyOnly(...txs: Transaction[]): Beef {
  const beef = new Beef()
  for (const tx of txs) beef.mergeRawTx(tx.toBinary())
  return beef
}

describe('BRC-176 proven-parent terminals', () => {
  it('stops at a parent this wallet already proved, without its ancestry', () => {
    const { hop1, hop2, tokenId } = chain()
    const beef = bodyOnly(hop1, hop2)
    const tip = `${hop2.id('hex')}_1`

    expect(prove(tip, beef).ok).toBe(false)

    const hop1Tip = `${hop1.id('hex')}_0`
    const proof = prove(tip, beef, (op) => (op === hop1Tip ? tokenId : null))
    expect(proof).toMatchObject({ ok: true, tokenId, deployOutpoint: tokenId, amount: 400n })
  })

  it('still enforces conservation against the known parent amount', () => {
    const { deploy, hop1, tokenId } = chain()
    const over = new Transaction()
    over.addInput({ sourceTransaction: hop1, sourceOutputIndex: 0, unlockingScript: new LockingScript() })
    over.addOutput({ satoshis: 1, lockingScript: encodeBsv21Binary({ tokenId, amount: 1001n, rest: P2PKH }) })
    const proof = prove(`${over.id('hex')}_0`, bodyOnly(deploy, hop1, over), () => tokenId)
    expect(proof.ok).toBe(false)
  })

  it('refuses a known parent bound to a different token', () => {
    const { hop1, hop2 } = chain()
    const other = `${'ab'.repeat(32)}_0`
    const proof = prove(`${hop2.id('hex')}_0`, bodyOnly(hop1, hop2), () => other)
    expect(proof.ok).toBe(false)
  })

  it('fills one hop past the tip, never the proven ancestry', async () => {
    const { deploy, hop1, hop2, tokenId } = chain()
    const bodies = new Map([deploy, hop1, hop2].map((tx) => [tx.id('hex'), tx]))
    const fetched: string[] = []
    const hop1Tip = `${hop1.id('hex')}_0`
    const filled = await fillTokenParentBodies(
      bodyOnly(hop2),
      async (txid) => {
        fetched.push(txid)
        const tx = bodies.get(txid)
        return tx ? bodyOnly(tx) : null
      },
      [hop2.id('hex')],
      (op) => (op === hop1Tip ? tokenId : null),
    )
    expect(fetched).toEqual([hop1.id('hex')])
    expect(prove(`${hop2.id('hex')}_0`, filled, (op) => (op === hop1Tip ? tokenId : null)).ok).toBe(true)
  })
})
