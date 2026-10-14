import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { encodeBsv21Binary } from './decode162'
import { prove, proveWithScripts, verifyTokenSpendScripts } from './prove176'

const alice = PrivateKey.fromHex('11'.repeat(32))
const bob = PrivateKey.fromHex('22'.repeat(32))
const mallory = PrivateKey.fromHex('33'.repeat(32))

function deploy(owner: PrivateKey, amount = 1000n): Transaction {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({
      amount,
      payload: { sym: 'GOLD', dec: 0 },
      rest: new P2PKH().lock(owner.toAddress()),
    }),
  })
  return tx
}

/** Spend `parent:vout` with `signer` (null = empty unlocking script) to `to`. */
async function transfer(args: {
  parent: Transaction
  vout?: number
  tokenId: string
  amount: bigint
  to: PrivateKey
  signer: PrivateKey | null
  fundingTxid?: string
}): Promise<Transaction> {
  const tx = new Transaction()
  if (args.fundingTxid) {
    tx.addInput({ sourceTXID: args.fundingTxid, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  }
  tx.addInput({
    sourceTransaction: args.parent,
    sourceOutputIndex: args.vout ?? 0,
    ...(args.signer
      ? { unlockingScriptTemplate: new P2PKH().unlock(args.signer) }
      : { unlockingScript: new UnlockingScript() }),
  })
  tx.addOutput({
    satoshis: 1,
    lockingScript: encodeBsv21Binary({
      tokenId: args.tokenId,
      amount: args.amount,
      rest: new P2PKH().lock(args.to.toAddress()),
    }),
  })
  await tx.sign()
  return tx
}

function beefOf(...txs: Transaction[]): Beef {
  const beef = new Beef()
  for (const tx of txs) beef.mergeRawTx(tx.toBinary())
  return beef
}

describe('verifyTokenSpendScripts', () => {
  it('accepts a lineage whose every token spend is signed by the output owner', async () => {
    const d = deploy(alice)
    const tokenId = `${d.id('hex')}_0`
    const a = await transfer({ parent: d, tokenId, amount: 1000n, to: bob, signer: alice })
    const b = await transfer({ parent: a, tokenId, amount: 1000n, to: alice, signer: bob })
    const beef = beefOf(d, a, b)
    expect(verifyTokenSpendScripts(`${b.id('hex')}_0`, beef)).toEqual({
      ok: true,
      transactions: 3,
      spends: 2,
    })
    expect(proveWithScripts(`${b.id('hex')}_0`, beef)).toMatchObject({ ok: true, tokenId })
  })

  it('refuses an ancestor that spends a real token output without its key', async () => {
    const d = deploy(alice)
    const tokenId = `${d.id('hex')}_0`
    // Token rules hold, so prove() alone binds the forgery to the real deploy.
    const forged = await transfer({ parent: d, tokenId, amount: 1000n, to: mallory, signer: mallory })
    const tip = await transfer({ parent: forged, tokenId, amount: 1000n, to: bob, signer: mallory })
    const beef = beefOf(d, forged, tip)
    const point = `${tip.id('hex')}_0`
    expect(prove(point, beef)).toMatchObject({ ok: true, tokenId })
    const checked = verifyTokenSpendScripts(point, beef)
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.reason).toBe(
      `token input 0 of ${forged.id('hex')} fails its locking script`,
    )
    expect(proveWithScripts(point, beef)).toEqual(checked)
  })

  it('refuses an empty unlocking script on a token input', async () => {
    const d = deploy(alice)
    const tokenId = `${d.id('hex')}_0`
    const tip = await transfer({ parent: d, tokenId, amount: 1000n, to: bob, signer: null })
    const checked = verifyTokenSpendScripts(`${tip.id('hex')}_0`, beefOf(d, tip))
    expect(!checked.ok && checked.reason).toMatch(/^token input 0 of .* fails its locking script$/)
  })

  it('checks token inputs only — a funding input without a body is not judged', async () => {
    const d = deploy(alice)
    const tokenId = `${d.id('hex')}_0`
    const tip = await transfer({
      parent: d,
      tokenId,
      amount: 1000n,
      to: bob,
      signer: alice,
      fundingTxid: 'ab'.repeat(32),
    })
    expect(verifyTokenSpendScripts(`${tip.id('hex')}_0`, beefOf(d, tip))).toEqual({
      ok: true,
      transactions: 2,
      spends: 1,
    })
  })

  it('stops at a parent a previous walk proved, after checking the spend of it', async () => {
    const d = deploy(alice)
    const tokenId = `${d.id('hex')}_0`
    const forged = await transfer({ parent: d, tokenId, amount: 1000n, to: bob, signer: mallory })
    const tip = await transfer({ parent: forged, tokenId, amount: 1000n, to: alice, signer: bob })
    const beef = beefOf(d, forged, tip)
    const known = (outpoint: string) => (outpoint === `${forged.id('hex')}_0` ? tokenId : null)
    expect(verifyTokenSpendScripts(`${tip.id('hex')}_0`, beef, known)).toEqual({
      ok: true,
      transactions: 1,
      spends: 1,
    })

    const unsigned = await transfer({ parent: forged, tokenId, amount: 1000n, to: alice, signer: null })
    const refused = verifyTokenSpendScripts(`${unsigned.id('hex')}_0`, beefOf(d, forged, unsigned), known)
    expect(refused.ok).toBe(false)
  })

  it('a deploy tip has no token spend to check', () => {
    const d = deploy(alice)
    expect(verifyTokenSpendScripts(`${d.id('hex')}_0`, beefOf(d))).toEqual({
      ok: true,
      transactions: 1,
      spends: 0,
    })
  })
})
