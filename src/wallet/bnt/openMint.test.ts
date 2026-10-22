import { LockingScript, OP, PrivateKey, Script, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { signInput } from '../txInputs'
import { bntIssuerPrivateKey } from './keys'
import { bntMintUnlock } from './mintCovenant'
import { assertBntFields, bntOpenMintCap, decodeBntPayload, encodeBntPayload, type BntDeployFields } from './payload'
import { BNT_HOLDER_SCOPE, BNT_ISSUER_SCOPE, bntAuthorityLock, bntDeployLock, bntHeldLock, bntMintLock, bntOpenUnlock, p2pkLock } from './script'
import { checkBntTx, readBntDeploy, walkBnt, type BntDeploy } from './validity'

const pub = (key: PrivateKey) => key.toPublicKey().toString()
const identity = PrivateKey.fromRandom()
const issuerKey = bntIssuerPrivateKey(identity)
const alice = PrivateKey.fromRandom()
const bob = PrivateKey.fromRandom()
const carol = PrivateKey.fromRandom()
const lim = 100n
const fields: BntDeployFields = { mode: 'open', kind: 'token', iss: [pub(identity)], m: 1, sym: 'RUNE', auth: true, om: { count: 3, lim } }

const anyone = new Script().writeOpCode(OP.OP_TRUE) as LockingScript

function deployTx(): Transaction {
  const funding = new Transaction()
  funding.addOutput({ lockingScript: anyone, satoshis: 1000 })
  const coin = new Transaction()
  coin.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  coin.addOutput({ lockingScript: p2pkLock(pub(issuerKey)), satoshis: 500 })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: bntDeployLock({ supply: 10n, payload: encodeBntPayload(fields), clause: { mode: 'open', holder: pub(alice) } }), satoshis: 1 })
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, issuerKey, BNT_ISSUER_SCOPE))
  return tx
}

const deployTxn = deployTx()
const deploy: BntDeploy = (() => {
  const read = readBntDeploy(deployTxn, 0)
  if (!read.ok) throw new Error(read.detail)
  return read.deploy
})()
const assetId = deploy.assetId
const held = (amount: bigint, holder: PrivateKey) => bntHeldLock({ assetId, amount, clause: { mode: 'open', holder: pub(holder) } })
const mintOut = (remaining: number) => bntMintLock({ assetId, remaining, lim })

/** Alice spends the deploy into `outputs`. */
function openTx(outputs: LockingScript[]): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: deployTxn, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  for (const script of outputs) tx.addOutput({ lockingScript: script, satoshis: 1 })
  tx.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(tx, 0, alice, BNT_HOLDER_SCOPE))
  return tx
}

/** Anyone spends the mint at `source:0` to `holder`, with `extra` outputs after the ones the covenant fixes. */
function mintTx(source: Transaction, remaining: number, holder: PrivateKey, extra: LockingScript[] = []): Transaction {
  for (let lockTime = 0; lockTime < 64; lockTime++) {
    const tx = new Transaction(1, [], [], lockTime)
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    if (remaining > 1) tx.addOutput({ lockingScript: mintOut(remaining - 1), satoshis: 1 })
    tx.addOutput({ lockingScript: held(lim, holder), satoshis: 1 })
    for (const script of extra) tx.addOutput({ lockingScript: script, satoshis: 1 })
    const unlock = bntMintUnlock(tx, 0, pub(holder), remaining)
    if (!unlock) continue
    tx.inputs[0]!.unlockingScript = unlock
    return tx
  }
  throw new Error('no lock time signs')
}

function transfer(source: Transaction, vout: number, holder: PrivateKey, to: LockingScript): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: to, satoshis: 1 })
  tx.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(tx, 0, holder, BNT_HOLDER_SCOPE))
  return tx
}

function storeOf(...txs: Transaction[]) {
  const map = new Map(txs.map((tx) => [String(tx.id('hex')), tx]))
  return async (txid: string) => map.get(txid) ?? null
}

const walk = (subject: Transaction, ...history: Transaction[]) =>
  walkBnt(String(subject.id('hex')), deploy, storeOf(subject, ...history, deployTxn), () => false)

const opening = openTx([mintOut(3), held(10n, alice)])

describe('open-mint payload', () => {
  it('round-trips om as a critical key and fixes the cap', () => {
    expect(decodeBntPayload(Uint8Array.from(encodeBntPayload(fields)))?.om).toEqual({ count: 3, lim })
    expect(bntOpenMintCap(10n, fields.om!)).toBe(310n)
  })

  it('refuses om on an item, without auth, beside a cap, or past the mint limit', () => {
    expect(() => assertBntFields({ ...fields, auth: undefined })).toThrow(/mint authority/)
    expect(() => assertBntFields({ ...fields, max: 500n })).toThrow(/own cap/)
    expect(() => assertBntFields({ ...fields, om: { count: 10_001, lim } })).toThrow(/mints/)
    expect(() => assertBntFields({ ...fields, om: { count: 1, lim: 0n } })).toThrow(/units/)
  })
})

describe('open minting', () => {
  it('opens by turning the deploy into the mint, issuing nothing', () => {
    expect(checkBntTx(opening, deploy)).toMatchObject({ ok: true, minted: 0n })
  })

  it('refuses an opening that mints, counts wrong, or keeps an authority', () => {
    expect(checkBntTx(openTx([mintOut(3), held(11n, alice)]), deploy)).toMatchObject({ ok: false, reason: 'mint' })
    expect(checkBntTx(openTx([mintOut(4), held(10n, alice)]), deploy)).toMatchObject({ ok: false, reason: 'mint' })
    const authority = bntAuthorityLock({ assetId, clause: { mode: 'open', holder: pub(alice) } })
    expect(checkBntTx(openTx([authority, held(10n, alice)]), deploy)).toMatchObject({ ok: false, reason: 'mint' })
  })

  it('lets anyone mint lim units each time until the count runs out, and every mint walks back to the deploy', async () => {
    const first = mintTx(opening, 3, bob)
    const second = mintTx(first, 2, carol)
    const last = mintTx(second, 1, bob)
    for (const tx of [first, second, last]) expect(checkBntTx(tx, deploy)).toMatchObject({ ok: true, minted: lim })
    expect(last.outputs).toHaveLength(1)
    expect(await walk(last, second, first, opening)).toMatchObject({ ok: true })
    const sent = transfer(second, 1, carol, held(lim, alice))
    expect(await walk(sent, second, first, opening)).toMatchObject({ ok: true })
  })

  it('refuses a mint written by anyone but the mint', () => {
    const forged = new Transaction()
    forged.addInput({ sourceTransaction: opening, sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    forged.addOutput({ lockingScript: mintOut(3), satoshis: 1 })
    forged.addOutput({ lockingScript: held(10n, alice), satoshis: 1 })
    forged.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(forged, 0, alice, BNT_HOLDER_SCOPE))
    expect(checkBntTx(forged, deploy)).toMatchObject({ ok: false, reason: 'mint' })
  })

  it('keeps the mint alive when a spender adds outputs that break the rules, and credits nothing else of that spend', async () => {
    const griefed = mintTx(opening, 3, bob, [held(999n, bob)])
    expect(checkBntTx(griefed, deploy)).toMatchObject({ ok: false })
    const next = mintTx(griefed, 2, carol)
    expect(await walk(next, griefed, opening)).toMatchObject({ ok: true })
    expect(await walk(transfer(next, 1, carol, held(lim, alice)), next, griefed, opening)).toMatchObject({ ok: true })
    expect(await walk(transfer(griefed, 1, bob, held(lim, alice)), griefed, opening)).toMatchObject({ ok: false, reason: 'invalid' })
    const both = new Transaction()
    both.addInput({ sourceTransaction: next, sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    both.addInput({ sourceTransaction: griefed, sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    both.addOutput({ lockingScript: held(2n * lim, alice), satoshis: 1 })
    both.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(both, 0, carol, BNT_HOLDER_SCOPE))
    both.inputs[1]!.unlockingScript = bntOpenUnlock(signInput(both, 1, bob, BNT_HOLDER_SCOPE))
    expect(await walk(both, next, griefed, opening)).toMatchObject({ ok: false, reason: 'invalid' })
  })
})
