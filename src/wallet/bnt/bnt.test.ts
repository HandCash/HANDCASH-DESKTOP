import { LockingScript, OP, PrivateKey, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { inputScriptValid, signInput } from '../txInputs'
import { bntHolderPrivateKey, bntHolderPublicKey, bntIssuerKeyOf, bntIssuerPrivateKey } from './keys'
import { decodeBntPayload, encodeBntPayload, BNT_MIN_SILENCE_SECONDS, bntSupplyPolicy, type BntDeployFields } from './payload'
import { buildBntPackage, bntAncestry, readBntPackage } from './proof'
import {
  BNT_HOLDER_SCOPE,
  BNT_ISSUER_SCOPE,
  bntAssetId,
  bntAuthorityLock,
  bntDeployLock,
  bntHeldLock,
  bntIssuerUnlock,
  bntOpenUnlock,
  bntReleaseUnlock,
  bntUnlockBranch,
  hash160Hex,
  p2pkLock,
  readBnt,
  revealedSecret,
  type BntClause,
} from './script'
import { checkBntTx, readBntDeploy, walkBnt, type BntDeploy } from './validity'
import { bntBackingScript, readBackingOutputs, type BntBackingProof } from './backing'
import ltcDeposit from '../ltc/fixtures/deposit.json'
import { setLtcAnchorForTest, type LtcBurialAnchor } from '../ltc/headers'
import { fromHex, parseLtcTx, toHex } from '../ltc/litecoin'

const pub = (key: PrivateKey) => key.toPublicKey().toString()
const identity = PrivateKey.fromRandom()
const issuerKey = bntIssuerPrivateKey(identity)
const alice = PrivateKey.fromRandom()
const bob = PrivateKey.fromRandom()

const funding = (() => {
  const tx = new Transaction()
  for (let i = 0; i < 8; i++) tx.addOutput({ lockingScript: new Script().writeOpCode(OP.OP_TRUE) as LockingScript, satoshis: 1000 })
  return tx
})()
let fundingIndex = 0
const nextFunding = () => fundingIndex++ % 8

/** A P2PK coin locked to `key`, spendable by the deploy. */
function coinFor(key: PrivateKey): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: funding, sourceOutputIndex: nextFunding(), unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: p2pkLock(pub(key)), satoshis: 500 })
  return tx
}

const openClause = (holder: PrivateKey): BntClause => ({ mode: 'open', holder: pub(holder) })
const tokenFields: BntDeployFields = { mode: 'open', kind: 'token', iss: [pub(identity)], m: 1, sym: 'BNT', dec: 0 }

function deployTx(args: {
  supply: bigint
  fields?: BntDeployFields
  signer?: PrivateKey
  holder?: PrivateKey
  clause?: BntClause
  scope?: number
  extra?: LockingScript[]
}) {
  const signer = args.signer ?? issuerKey
  const coin = coinFor(signer)
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({
    lockingScript: bntDeployLock({
      supply: args.supply,
      payload: encodeBntPayload(args.fields ?? tokenFields),
      clause: args.clause ?? openClause(args.holder ?? alice),
    }),
    satoshis: 1,
  })
  for (const script of args.extra ?? []) tx.addOutput({ lockingScript: script, satoshis: 0 })
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, signer, args.scope ?? BNT_ISSUER_SCOPE))
  return tx
}

function deployOf(tx: Transaction): BntDeploy {
  const read = readBntDeploy(tx, 0)
  if (!read.ok) throw new Error(read.detail)
  return read.deploy
}

/** Spend `inputs` (each signed by its holder, open mode) into held outputs. */
function transfer(inputs: Array<{ tx: Transaction; vout: number; holder: PrivateKey }>, outputs: Array<{ script: LockingScript; satoshis?: number }>) {
  const tx = new Transaction()
  for (const input of inputs) {
    tx.addInput({ sourceTransaction: input.tx, sourceOutputIndex: input.vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  }
  for (const out of outputs) tx.addOutput({ lockingScript: out.script, satoshis: out.satoshis ?? 1 })
  inputs.forEach((input, vin) => {
    tx.inputs[vin]!.unlockingScript = bntOpenUnlock(signInput(tx, vin, input.holder, BNT_HOLDER_SCOPE))
  })
  return tx
}

const held = (assetId: string, amount: bigint, holder: PrivateKey) => bntHeldLock({ assetId, amount, clause: openClause(holder) })

function storeOf(...txs: Transaction[]) {
  const map = new Map(txs.map((tx) => [String(tx.id('hex')), tx]))
  return async (txid: string) => map.get(txid) ?? null
}

describe('bnt scripts', () => {
  const assetId = 'ab'.repeat(20)

  it('reads every form back exactly', () => {
    const deploy = bntDeployLock({ supply: 21_000_000n, payload: encodeBntPayload(tokenFields), clause: openClause(alice) })
    expect(deploy.toHex().startsWith('03626e74')).toBe(true)
    expect(readBnt(deploy)).toMatchObject({ form: 'deploy', supply: 21_000_000n })
    expect(readBnt(held(assetId, 7n, alice))).toMatchObject({ form: 'held', assetId, amount: 7n })
    expect(readBnt(held(assetId, 7n, alice))!.form).toBe('held')
    expect(readBnt(bntAuthorityLock({ assetId, clause: openClause(alice) }))).toMatchObject({ form: 'authority', assetId })
  })

  it('refuses non-canonical encodings', () => {
    const canonical = held(assetId, 7n, alice).toHex()
    // amount 7 pushed as data instead of OP_7
    const padded = new LockingScript()
      .writeBin(Utils.toArray(`626e74${assetId}`, 'hex'))
      .writeBin([7])
      .writeOpCode(OP.OP_2DROP)
      .writeBin(Utils.toArray(pub(alice), 'hex'))
      .writeOpCode(OP.OP_CHECKSIG)
    expect(padded.toHex()).not.toBe(canonical)
    expect(readBnt(padded)).toBeNull()
    expect(readBnt(`${canonical}51`)).toBeNull()
    const negative = new LockingScript()
      .writeBin(Utils.toArray(`626e74${assetId}`, 'hex'))
      .writeOpCode(OP.OP_1NEGATE)
      .writeOpCode(OP.OP_2DROP)
      .writeBin(Utils.toArray(pub(alice), 'hex'))
      .writeOpCode(OP.OP_CHECKSIG)
    expect(readBnt(negative)).toBeNull()
    expect(readBnt('76a914' + '00'.repeat(20) + '88ac')).toBeNull()
  })

  it('derives the asset id from the outpoint', () => {
    const txid = '11'.repeat(32)
    expect(bntAssetId(txid, 0)).toMatch(/^[0-9a-f]{40}$/)
    expect(bntAssetId(txid, 0)).not.toBe(bntAssetId(txid, 1))
  })

  it('open outputs spend on the holder signature alone', () => {
    const deploy = deployTx({ supply: 10n })
    const good = transfer([{ tx: deploy, vout: 0, holder: alice }], [{ script: held(deployOf(deploy).assetId, 10n, bob) }])
    expect(inputScriptValid(good, 0)).toBe(true)
    const stolen = transfer([{ tx: deploy, vout: 0, holder: bob }], [{ script: held(deployOf(deploy).assetId, 10n, bob) }])
    expect(inputScriptValid(stolen, 0)).toBe(false)
  })

  it('countersigned outputs need the issuer, or the release secret', () => {
    const secret = Array.from({ length: 32 }, (_, i) => i + 1)
    const clause: BntClause = {
      mode: 'countersign',
      holder: pub(alice),
      issuer: { m: 1, keys: [pub(issuerKey)] },
      release: { kind: 'hash', rel: hash160Hex(secret) },
    }
    const coin = new Transaction()
    coin.addInput({ sourceTransaction: funding, sourceOutputIndex: nextFunding(), unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    coin.addOutput({ lockingScript: bntHeldLock({ assetId, amount: 5n, clause }), satoshis: 1 })
    const spend = (unlock: (tx: Transaction) => UnlockingScript) => {
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      tx.addOutput({ lockingScript: bntHeldLock({ assetId, amount: 5n, clause: { ...clause, holder: pub(bob) } }), satoshis: 1 })
      tx.inputs[0]!.unlockingScript = unlock(tx)
      return tx
    }
    const accepted = spend((tx) =>
      bntIssuerUnlock({
        issuerSignatures: [signInput(tx, 0, issuerKey, BNT_ISSUER_SCOPE)],
        shared: false,
        holderSignature: signInput(tx, 0, alice, BNT_HOLDER_SCOPE),
      }),
    )
    expect(inputScriptValid(accepted, 0)).toBe(true)
    expect(bntUnlockBranch(accepted.inputs[0]!.unlockingScript)).toBe('issuer')
    const holderAlone = spend((tx) => bntOpenUnlock(signInput(tx, 0, alice, BNT_HOLDER_SCOPE)))
    expect(inputScriptValid(holderAlone, 0)).toBe(false)
    const forgedIssuer = spend((tx) =>
      bntIssuerUnlock({
        issuerSignatures: [signInput(tx, 0, bob, BNT_ISSUER_SCOPE)],
        shared: false,
        holderSignature: signInput(tx, 0, alice, BNT_HOLDER_SCOPE),
      }),
    )
    expect(inputScriptValid(forgedIssuer, 0)).toBe(false)
    const released = spend((tx) => bntReleaseUnlock(secret, signInput(tx, 0, alice, BNT_HOLDER_SCOPE)))
    expect(inputScriptValid(released, 0)).toBe(true)
    expect(bntUnlockBranch(released.inputs[0]!.unlockingScript)).toBe('release')
    expect(revealedSecret(released.inputs[0]!.unlockingScript)).toEqual(secret)
    const wrongSecret = spend((tx) => bntReleaseUnlock(secret.map((b) => b ^ 1), signInput(tx, 0, alice, BNT_HOLDER_SCOPE)))
    expect(inputScriptValid(wrongSecret, 0)).toBe(false)
  })
})

describe('bnt payload', () => {
  it('round-trips and refuses fields that cannot go together', () => {
    const item: BntDeployFields = { mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name: 'Robot', ctype: 'image/png', c: new Uint8Array([1, 2, 3]) }
    expect(decodeBntPayload(Uint8Array.from(encodeBntPayload(item)))).toMatchObject({ kind: 'item', name: 'Robot', ctype: 'image/png' })
    expect(decodeBntPayload(Uint8Array.from(encodeBntPayload(tokenFields)))).toMatchObject({ kind: 'token', sym: 'BNT', dec: 0 })
    expect(() => encodeBntPayload({ ...tokenFields, sil: BNT_MIN_SILENCE_SECONDS })).toThrow()
    expect(() => encodeBntPayload({ ...item, dec: 2 } as BntDeployFields)).toThrow()
    expect(() => encodeBntPayload({ ...tokenFields, ctype: 'image/png' })).toThrow()
    expect(() => encodeBntPayload({ ...tokenFields, name: 'see https://evil.example' })).toThrow()
    expect(() => encodeBntPayload({ ...tokenFields, mode: 'countersign' })).toThrow()
    expect(decodeBntPayload(new Uint8Array([0xa0]))).toBeNull()
  })
})

describe('bnt keys', () => {
  it('anyone derives the issuer key from the identity', () => {
    expect(bntIssuerKeyOf(pub(identity))).toBe(pub(issuerKey))
  })

  it('holder keys match on both sides and never repeat', () => {
    const a = bntHolderPublicKey(alice, pub(bob), 'p1', 's1')
    expect(pub(bntHolderPrivateKey(bob, { derivationPrefix: 'p1', derivationSuffix: 's1', senderIdentityKey: pub(alice) }))).toBe(a)
    expect(bntHolderPublicKey(alice, pub(bob), 'p1', 's2')).not.toBe(a)
    const self = bntHolderPublicKey(alice, pub(alice), 'p1', 's1')
    expect(pub(bntHolderPrivateKey(alice, { derivationPrefix: 'p1', derivationSuffix: 's1', senderIdentityKey: pub(alice) }))).toBe(self)
  })
})

describe('bnt deploy', () => {
  it('reads a deploy signed by the issuer', () => {
    const tx = deployTx({ supply: 1000n })
    const deploy = deployOf(tx)
    expect(deploy.assetId).toBe(bntAssetId(String(tx.id('hex')), 0))
    expect(deploy.issuerKeys).toEqual([pub(issuerKey)])
  })

  it('refuses a deploy nobody with the issuer key signed', () => {
    const forged = deployTx({ supply: 1000n, signer: bob })
    expect(readBntDeploy(forged, 0)).toMatchObject({ ok: false, reason: 'unsigned' })
  })

  it('refuses an issuer signature that does not commit to every output', () => {
    const single = 0x43
    const loose = deployTx({ supply: 1000n, scope: single })
    expect(readBntDeploy(loose, 0)).toMatchObject({ ok: false, reason: 'unsigned' })
  })

  it('refuses a clause that does not match the payload mode', () => {
    const clause: BntClause = {
      mode: 'countersign',
      holder: pub(alice),
      issuer: { m: 1, keys: [pub(bob)] },
      release: { kind: 'hash', rel: '00'.repeat(20) },
    }
    expect(readBntDeploy(deployTx({ supply: 10n, clause }), 0)).toMatchObject({ ok: false, reason: 'clause' })
  })

  it('refuses an item with a supply above one', () => {
    const fields: BntDeployFields = { mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name: 'Robot' }
    expect(readBntDeploy(deployTx({ supply: 2n, fields }), 0)).toMatchObject({ ok: false, reason: 'item-supply' })
  })
})

describe('bnt validity', () => {
  it('conserves, splits and walks back to the deploy', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 60n, bob) }, { script: held(deploy.assetId, 40n, alice) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }, { tx: t1, vout: 1, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    expect(checkBntTx(t1, deploy)).toMatchObject({ ok: true })
    const result = await walkBnt(String(t2.id('hex')), deploy, storeOf(dTx, t1, t2), () => false)
    expect(result).toEqual({ ok: true, validated: [String(t2.id('hex')), String(t1.id('hex'))], backed: [] })
  })

  it('refuses inflation', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 101n, bob) }])
    expect(checkBntTx(t1, deploy)).toMatchObject({ ok: false, reason: 'conservation' })
    expect(await walkBnt(String(t1.id('hex')), deploy, storeOf(dTx, t1), () => false)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('refuses outputs conjured without spending the asset', () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    tx.addOutput({ lockingScript: held(deploy.assetId, 50n, bob), satoshis: 1 })
    expect(checkBntTx(tx, deploy)).toMatchObject({ ok: false, reason: 'conjured' })
  })

  it('refuses a held output under a foreign clause', () => {
    const dTx = deployTx({ supply: 10n })
    const deploy = deployOf(dTx)
    const foreign = bntHeldLock({
      assetId: deploy.assetId,
      amount: 10n,
      clause: { mode: 'countersign', holder: pub(bob), issuer: { m: 1, keys: [pub(bob)] }, release: { kind: 'hash', rel: '00'.repeat(20) } },
    })
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: foreign }])
    expect(checkBntTx(t1, deploy)).toMatchObject({ ok: false, reason: 'output' })
  })

  it('refuses minting without an authority', () => {
    const dTx = deployTx({ supply: 10n })
    const deploy = deployOf(dTx)
    const t1 = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 10n, bob) }, { script: bntAuthorityLock({ assetId: deploy.assetId, clause: openClause(alice) }) }],
    )
    expect(checkBntTx(t1, deploy)).toMatchObject({ ok: false, reason: 'mint' })
  })

  it('mints through the authority when the deploy grants one', () => {
    const dTx = deployTx({ supply: 10n, fields: { ...tokenFields, auth: true } })
    const deploy = deployOf(dTx)
    const t1 = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 25n, bob) }, { script: bntAuthorityLock({ assetId: deploy.assetId, clause: openClause(alice) }) }],
    )
    expect(checkBntTx(t1, deploy)).toMatchObject({ ok: true })
  })

  it('refuses an unmined child that claims more than its parent wrote', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    // A fake parent with the same id cannot exist, so the forger links a doctored copy of t1 into the child.
    const doctored = Transaction.fromHex(t1.toHex())
    doctored.outputs[0]!.lockingScript = held(deploy.assetId, 1_000_000n, bob)
    const child = new Transaction()
    child.addInput({ sourceTXID: String(t1.id('hex')), sourceTransaction: doctored, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    child.addOutput({ lockingScript: held(deploy.assetId, 1_000_000n, bob), satoshis: 1 })
    child.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(child, 0, bob, BNT_HOLDER_SCOPE))
    expect(checkBntTx(child, deploy)).toMatchObject({ ok: true })
    const result = await walkBnt(String(child.id('hex')), deploy, storeOf(dTx, t1, child), () => false)
    expect(result).toMatchObject({ ok: false, reason: 'invalid', txid: String(child.id('hex')) })
  })

  it('says missing, not invalid, when history is absent', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }], [{ script: held(deploy.assetId, 100n, alice) }])
    expect(await walkBnt(String(t2.id('hex')), deploy, storeOf(dTx, t2), () => false)).toMatchObject({
      ok: false,
      reason: 'missing',
      txid: String(t1.id('hex')),
    })
  })

  it('stops at transactions it already validated', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }], [{ script: held(deploy.assetId, 100n, alice) }])
    const known = String(t1.id('hex'))
    expect(await walkBnt(String(t2.id('hex')), deploy, storeOf(t1, t2), (txid) => txid === known)).toEqual({
      ok: true,
      validated: [String(t2.id('hex'))],
      backed: [],
    })
  })
})

describe('bnt proof package', () => {
  it('carries the subject and the hops a recipient lacks, and reads back strictly', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }], [{ script: held(deploy.assetId, 100n, alice) }])
    const ancestry = await bntAncestry(t2, deploy, storeOf(dTx, t1), () => false)
    expect(ancestry.ok && ancestry.txs.map((tx) => String(tx.id('hex')))).toEqual([String(t1.id('hex'))])
    const { pkg, complete } = buildBntPackage(t2, ancestry.ok ? ancestry.txs : [], [dTx])
    expect(complete).toBe(true)
    const read = readBntPackage(JSON.parse(JSON.stringify(pkg)))!
    expect(String(read.subject.id('hex'))).toBe(String(t2.id('hex')))
    const all = new Map([...read.txs, ...read.deploys])
    expect(await walkBnt(String(t2.id('hex')), deploy, async (id) => all.get(id) ?? null, () => false)).toMatchObject({ ok: true })
    expect(readBntPackage({ ...pkg, subject: '00'.repeat(32) })).toBeNull()
    expect(readBntPackage({ ...pkg, txs: ['zz'] })).toBeNull()
  })

  it('skips hops the recipient already holds and cuts to the budget', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }], [{ script: held(deploy.assetId, 100n, alice) }])
    const known = String(t1.id('hex'))
    const ancestry = await bntAncestry(t2, deploy, storeOf(dTx, t1), (txid) => txid === known)
    expect(ancestry).toEqual({ ok: true, txs: [] })
    const { complete } = buildBntPackage(t2, [t1], [dTx], t2.toHexEF().length + 100)
    expect(complete).toBe(false)
  })
})

describe('bnt supply policy', () => {
  const capped = (max?: bigint, size?: bigint): BntDeployFields => ({
    ...tokenFields,
    auth: true,
    ...(max != null ? { max } : {}),
    ...(size != null ? { size } : {}),
  })
  const authority = (assetId: string, holder: PrivateKey, issued?: { units: bigint; members: bigint }) =>
    bntAuthorityLock({ assetId, clause: openClause(holder), ...(issued ? { issued } : {}) })

  it('names fixed, open and capped supply from the deploy', () => {
    expect(bntSupplyPolicy(tokenFields)).toEqual({ kind: 'fixed' })
    expect(bntSupplyPolicy({ ...tokenFields, auth: true })).toEqual({ kind: 'open' })
    expect(bntSupplyPolicy(capped(100n, 5n))).toEqual({ kind: 'capped', max: 100n, size: 5n })
  })

  it('round-trips caps past 2^53 and refuses a cap without an authority', () => {
    const max = (1n << 64n) - 1n
    expect(decodeBntPayload(Uint8Array.from(encodeBntPayload(capped(max))))).toMatchObject({ auth: true, max })
    expect(decodeBntPayload(Uint8Array.from(encodeBntPayload(capped(undefined, 3n))))).toMatchObject({ size: 3n })
    expect(() => encodeBntPayload({ ...tokenFields, max: 10n })).toThrow(/auth/)
    expect(() => encodeBntPayload(capped(0n))).toThrow()
    expect(() => encodeBntPayload({ ...capped(10n), kind: 'item', name: 'x', sym: undefined, dec: undefined, auth: undefined })).toThrow()
  })

  it('reads a capped authority back exactly and keeps the open form unchanged', () => {
    const assetId = 'cd'.repeat(20)
    const lock = authority(assetId, alice, { units: 300n, members: 0n })
    expect(readBnt(lock)).toMatchObject({ form: 'authority', assetId, issued: { units: 300n, members: 0n } })
    expect(readBnt(authority(assetId, alice))).toEqual({ form: 'authority', assetId, clause: openClause(alice) })
    expect(readBnt(`${lock.toHex()}51`)).toBeNull()
  })

  it('refuses a deploy whose supply is over its own cap', () => {
    expect(readBntDeploy(deployTx({ supply: 101n, fields: capped(100n) }), 0)).toMatchObject({ ok: false, reason: 'over-cap' })
    expect(readBntDeploy(deployTx({ supply: 100n, fields: capped(100n) }), 0)).toMatchObject({ ok: true })
  })

  it('mints up to the cap and states the running total', () => {
    const dTx = deployTx({ supply: 60n, fields: capped(100n) })
    const deploy = deployOf(dTx)
    const ok = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 100n, alice) }, { script: authority(deploy.assetId, alice, { units: 100n, members: 0n }) }],
    )
    expect(checkBntTx(ok, deploy)).toMatchObject({ ok: true, issued: { units: 100n, members: 0n } })
    const over = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 101n, alice) }, { script: authority(deploy.assetId, alice, { units: 101n, members: 0n }) }],
    )
    expect(checkBntTx(over, deploy)).toMatchObject({ ok: false, reason: 'over-cap' })
  })

  it('refuses an authority that understates, omits or invents its issued count', () => {
    const dTx = deployTx({ supply: 60n, fields: capped(100n) })
    const deploy = deployOf(dTx)
    const lie = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 90n, alice) }, { script: authority(deploy.assetId, alice, { units: 60n, members: 0n }) }],
    )
    expect(checkBntTx(lie, deploy)).toMatchObject({ ok: false, reason: 'mint' })
    const omitted = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 60n, alice) }, { script: authority(deploy.assetId, alice) }],
    )
    expect(checkBntTx(omitted, deploy)).toMatchObject({ ok: false, reason: 'output' })
    const oTx = deployTx({ supply: 10n, fields: { ...tokenFields, auth: true } })
    const open = deployOf(oTx)
    const invented = transfer(
      [{ tx: oTx, vout: 0, holder: alice }],
      [{ script: held(open.assetId, 10n, alice) }, { script: authority(open.assetId, alice, { units: 10n, members: 0n }) }],
    )
    expect(checkBntTx(invented, open)).toMatchObject({ ok: false, reason: 'output' })
  })

  it('still enforces the cap when the authority is dropped', () => {
    const dTx = deployTx({ supply: 60n, fields: capped(100n) })
    const deploy = deployOf(dTx)
    const closing = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    expect(checkBntTx(closing, deploy)).toMatchObject({ ok: true })
    const over = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 101n, bob) }])
    expect(checkBntTx(over, deploy)).toMatchObject({ ok: false, reason: 'over-cap' })
  })

  it('walks a capped chain of mints back to the deploy', async () => {
    const dTx = deployTx({ supply: 10n, fields: capped(30n) })
    const deploy = deployOf(dTx)
    const m1 = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 20n, bob) }, { script: authority(deploy.assetId, alice, { units: 20n, members: 0n }) }],
    )
    const m2 = transfer(
      [{ tx: m1, vout: 1, holder: alice }],
      [{ script: held(deploy.assetId, 10n, bob) }, { script: authority(deploy.assetId, alice, { units: 30n, members: 0n }) }],
    )
    expect(await walkBnt(String(m2.id('hex')), deploy, storeOf(dTx, m1, m2), () => false)).toMatchObject({ ok: true })
    const m3 = transfer(
      [{ tx: m2, vout: 1, holder: alice }],
      [{ script: held(deploy.assetId, 1n, bob) }, { script: authority(deploy.assetId, alice, { units: 31n, members: 0n }) }],
    )
    expect(await walkBnt(String(m3.id('hex')), deploy, storeOf(dTx, m1, m2, m3), () => false)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('counts collection members against its size', () => {
    const cTx = deployTx({ supply: 1n, fields: capped(undefined, 1n) })
    const collection = deployOf(cTx)
    const member = (count: number, issued: { units: bigint; members: bigint }) => {
      const coin = coinFor(issuerKey)
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      tx.addInput({ sourceTransaction: cTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      const item: BntDeployFields = { mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name: 'Member', col: collection.assetId }
      for (let i = 0; i < count; i++) {
        tx.addOutput({ lockingScript: bntDeployLock({ supply: 1n, payload: encodeBntPayload({ ...item, name: `Member ${i}` }), clause: openClause(alice) }), satoshis: 1 })
      }
      tx.addOutput({ lockingScript: held(collection.assetId, 1n, alice), satoshis: 1 })
      tx.addOutput({ lockingScript: authority(collection.assetId, alice, issued), satoshis: 1 })
      tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, issuerKey, BNT_ISSUER_SCOPE))
      tx.inputs[1]!.unlockingScript = bntOpenUnlock(signInput(tx, 1, alice, BNT_HOLDER_SCOPE))
      return tx
    }
    const one = member(1, { units: 1n, members: 1n })
    expect(readBntDeploy(one, 0)).toMatchObject({ ok: true, deploy: { member: true } })
    expect(checkBntTx(one, collection)).toMatchObject({ ok: true, issued: { units: 1n, members: 1n } })
    expect(checkBntTx(member(2, { units: 1n, members: 2n }), collection)).toMatchObject({ ok: false, reason: 'over-cap' })
    expect(checkBntTx(member(1, { units: 1n, members: 0n }), collection)).toMatchObject({ ok: false, reason: 'mint' })
  })
})

describe('bnt backed tokens', () => {
  const reserve = toHex(parseLtcTx(fromHex(ltcDeposit.hex)).outputs[ltcDeposit.vout]!.script)
  const deposit = { txid: ltcDeposit.txid, vout: ltcDeposit.vout }
  const bk = { chain: 'ltc' as const, reserve }
  const backedFields: BntDeployFields = { ...tokenFields, sym: 'wLTC', dec: 8, auth: true, bk }
  const proof: BntBackingProof = { tx: ltcDeposit.hex, path: ltcDeposit.proof.merkle, pos: ltcDeposit.proof.pos, height: ltcDeposit.height, header: ltcDeposit.headers[0]! }
  const anchorSays = (answer: LtcBurialAnchor) => setLtcAnchorForTest({ check: async () => answer })
  anchorSays({ kind: 'buried' })
  afterEach(() => anchorSays({ kind: 'buried' }))
  const backingLock = (assetId: string | null) => LockingScript.fromHex(bntBackingScript(deposit, assetId))
  const authority = (assetId: string, holder: PrivateKey) => bntAuthorityLock({ assetId, clause: openClause(holder) })
  const sources = (proofs: Record<string, BntBackingProof>) => ({ proven: () => false, proofOf: async (txid: string) => proofs[txid] ?? null })

  function chain() {
    const dTx = deployTx({ supply: 1_000n, fields: backedFields, extra: [backingLock(null)] })
    const deploy = deployOf(dTx)
    const m1 = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 1_000n, alice) }, { script: held(deploy.assetId, 500n, alice) }, { script: authority(deploy.assetId, alice) }, { script: backingLock(deploy.assetId), satoshis: 0 }],
    )
    return { dTx, deploy, m1, d: String(dTx.id('hex')), m: String(m1.id('hex')) }
  }

  it('names its chain and reserve as a critical field, and refuses one without an authority', () => {
    const bytes = Uint8Array.from(encodeBntPayload(backedFields))
    expect(decodeBntPayload(bytes)).toEqual(backedFields)
    expect(() => encodeBntPayload({ ...backedFields, auth: undefined })).toThrow(/authority/)
    expect(() => encodeBntPayload({ ...backedFields, bk: { chain: 'doge' as 'ltc', reserve } })).toThrow(/chain/)
  })

  it('writes the deposit outpoint in a backing output and reads it back', () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: backingLock('cd'.repeat(20)), satoshis: 0 })
    tx.addOutput({ lockingScript: backingLock(null), satoshis: 0 })
    expect(readBackingOutputs(tx)).toEqual([
      { vout: 0, deposit, assetId: 'cd'.repeat(20) },
      { vout: 1, deposit, assetId: null },
    ])
  })

  it('needs exactly one deposit on the deploy and on every mint, and none on a transfer', () => {
    expect(readBntDeploy(deployTx({ supply: 1_000n, fields: backedFields }), 0)).toMatchObject({ ok: false, reason: 'backing' })
    const { dTx, deploy, m1 } = chain()
    expect(checkBntTx(m1, deploy)).toMatchObject({ ok: true, minted: 500n })
    const bare = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 1_500n, alice) }, { script: authority(deploy.assetId, alice) }],
    )
    expect(checkBntTx(bare, deploy)).toMatchObject({ ok: false, reason: 'backing' })
    const t1 = transfer([{ tx: m1, vout: 1, holder: alice }], [{ script: held(deploy.assetId, 500n, bob) }, { script: backingLock(deploy.assetId), satoshis: 0 }])
    expect(checkBntTx(t1, deploy)).toMatchObject({ ok: false, reason: 'backing' })
  })

  it('moves minted units only with the burial proof of their deposit', async () => {
    const { dTx, deploy, d } = chain()
    const t0 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 1_000n, bob) }])
    const store = storeOf(dTx, t0)
    const subject = String(t0.id('hex'))
    expect(await walkBnt(subject, deploy, store, () => false, sources({}))).toMatchObject({ ok: false, reason: 'missing', txid: d })
    const walked = await walkBnt(subject, deploy, store, () => false, sources({ [d]: proof }))
    expect(walked).toMatchObject({ ok: true })
    expect(walked.ok && walked.backed).toEqual([{ txid: d, proof, deposit: `ltc:${reserve}:${deposit.txid}:${deposit.vout}` }])
    anchorSays({ kind: 'shallow', confirmations: 5 })
    expect(await walkBnt(subject, deploy, store, () => false, sources({ [d]: proof }))).toMatchObject({ ok: false, reason: 'missing' })
    anchorSays({ kind: 'off-chain' })
    expect(await walkBnt(subject, deploy, store, () => false, sources({ [d]: proof }))).toMatchObject({ ok: false, reason: 'invalid' })
    anchorSays({ kind: 'buried' })
    const otherReserve = { ...deploy, fields: { ...deploy.fields, bk: { chain: 'ltc' as const, reserve: `0014${'11'.repeat(20)}` } } }
    expect(await walkBnt(subject, otherReserve, store, () => false, sources({ [d]: proof }))).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('refuses a mint whose deposit already backs another issuance, in one walk or across walks', async () => {
    const { dTx, deploy, m1, d, m } = chain()
    const t1 = transfer([{ tx: m1, vout: 1, holder: alice }], [{ script: held(deploy.assetId, 500n, bob) }])
    const store = storeOf(dTx, m1, t1)
    const subject = String(t1.id('hex'))
    expect(await walkBnt(subject, deploy, store, () => false, sources({}))).toMatchObject({ ok: false, reason: 'missing', txid: m })
    expect(await walkBnt(subject, deploy, store, () => false, sources({ [m]: proof, [d]: proof }))).toMatchObject({
      ok: false,
      reason: 'invalid',
      txid: d,
      detail: expect.stringContaining(`already backs ${m}`),
    })
    const t0 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 1_000n, bob) }])
    const known = { ...sources({ [d]: proof }), issuanceOf: async () => m }
    expect(await walkBnt(String(t0.id('hex')), deploy, storeOf(dTx, t0), () => false, known)).toMatchObject({ ok: false, reason: 'invalid', txid: d })
  })

  it('lets the authority mint again before an earlier mint is proven', async () => {
    const { dTx, deploy, m1, d } = chain()
    const m2 = transfer(
      [{ tx: m1, vout: 2, holder: alice }],
      [{ script: held(deploy.assetId, 10n, alice) }, { script: authority(deploy.assetId, alice) }, { script: backingLock(deploy.assetId), satoshis: 0 }],
    )
    expect(await walkBnt(String(m2.id('hex')), deploy, storeOf(dTx, m1, m2), () => false, sources({ [d]: proof }))).toMatchObject({ ok: true })
  })

  it('carries burial proofs in the package and reads them back strictly', () => {
    const { dTx, m1, m } = chain()
    const { pkg } = buildBntPackage(m1, [], [dTx], undefined, new Map([[m, proof]]))
    const read = readBntPackage(JSON.parse(JSON.stringify(pkg)))
    expect(read?.backing.get(m)).toEqual(proof)
    expect(readBntPackage({ ...pkg, bk: { [m]: { ...proof, header: 'zz' } } })).toBeNull()
    const { height: _height, header: _header, ...rest } = proof
    expect(readBntPackage({ ...pkg, bk: { [m]: { ...rest, headers: [ltcDeposit.headers[0], ltcDeposit.headers[1]] } } })).toBeNull()
  })
})
