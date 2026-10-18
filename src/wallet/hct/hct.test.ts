import { LockingScript, OP, PrivateKey, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { inputScriptValid, signInput } from '../countersign/script'
import { hctHolderPrivateKey, hctHolderPublicKey, hctIssuerKeyOf, hctIssuerPrivateKey } from './keys'
import { decodeHctPayload, encodeHctPayload, HCT_MIN_SILENCE_SECONDS, hctSupplyPolicy, type HctDeployFields } from './payload'
import { buildHctPackage, hctAncestry, readHctPackage } from './proof'
import {
  HCT_HOLDER_SCOPE,
  HCT_ISSUER_SCOPE,
  hctAssetId,
  hctAuthorityLock,
  hctDeployLock,
  hctHeldLock,
  hctIssuerUnlock,
  hctOpenUnlock,
  hctReleaseUnlock,
  hctUnlockBranch,
  hash160Hex,
  p2pkLock,
  readHct,
  revealedSecret,
  type HctClause,
} from './script'
import { checkHctTx, readHctDeploy, walkHct, type HctDeploy } from './validity'

const pub = (key: PrivateKey) => key.toPublicKey().toString()
const identity = PrivateKey.fromRandom()
const issuerKey = hctIssuerPrivateKey(identity)
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

const openClause = (holder: PrivateKey): HctClause => ({ mode: 'open', holder: pub(holder) })
const tokenFields: HctDeployFields = { mode: 'open', kind: 'token', iss: [pub(identity)], m: 1, sym: 'HCT', dec: 0 }

function deployTx(args: { supply: bigint; fields?: HctDeployFields; signer?: PrivateKey; holder?: PrivateKey; clause?: HctClause; scope?: number }) {
  const signer = args.signer ?? issuerKey
  const coin = coinFor(signer)
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({
    lockingScript: hctDeployLock({
      supply: args.supply,
      payload: encodeHctPayload(args.fields ?? tokenFields),
      clause: args.clause ?? openClause(args.holder ?? alice),
    }),
    satoshis: 1,
  })
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, signer, args.scope ?? HCT_ISSUER_SCOPE))
  return tx
}

function deployOf(tx: Transaction): HctDeploy {
  const read = readHctDeploy(tx, 0)
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
    tx.inputs[vin]!.unlockingScript = hctOpenUnlock(signInput(tx, vin, input.holder, HCT_HOLDER_SCOPE))
  })
  return tx
}

const held = (assetId: string, amount: bigint, holder: PrivateKey) => hctHeldLock({ assetId, amount, clause: openClause(holder) })

function storeOf(...txs: Transaction[]) {
  const map = new Map(txs.map((tx) => [String(tx.id('hex')), tx]))
  return async (txid: string) => map.get(txid) ?? null
}

describe('hct scripts', () => {
  const assetId = 'ab'.repeat(20)

  it('reads every form back exactly', () => {
    const deploy = hctDeployLock({ supply: 21_000_000n, payload: encodeHctPayload(tokenFields), clause: openClause(alice) })
    expect(deploy.toHex().startsWith('03686374')).toBe(true)
    expect(readHct(deploy)).toMatchObject({ form: 'deploy', supply: 21_000_000n })
    expect(readHct(held(assetId, 7n, alice))).toMatchObject({ form: 'held', assetId, amount: 7n })
    expect(readHct(held(assetId, 7n, alice))!.form).toBe('held')
    expect(readHct(hctAuthorityLock({ assetId, clause: openClause(alice) }))).toMatchObject({ form: 'authority', assetId })
  })

  it('refuses non-canonical encodings', () => {
    const canonical = held(assetId, 7n, alice).toHex()
    // amount 7 pushed as data instead of OP_7
    const padded = new LockingScript()
      .writeBin(Utils.toArray(`686374${assetId}`, 'hex'))
      .writeBin([7])
      .writeOpCode(OP.OP_2DROP)
      .writeBin(Utils.toArray(pub(alice), 'hex'))
      .writeOpCode(OP.OP_CHECKSIG)
    expect(padded.toHex()).not.toBe(canonical)
    expect(readHct(padded)).toBeNull()
    expect(readHct(`${canonical}51`)).toBeNull()
    const negative = new LockingScript()
      .writeBin(Utils.toArray(`686374${assetId}`, 'hex'))
      .writeOpCode(OP.OP_1NEGATE)
      .writeOpCode(OP.OP_2DROP)
      .writeBin(Utils.toArray(pub(alice), 'hex'))
      .writeOpCode(OP.OP_CHECKSIG)
    expect(readHct(negative)).toBeNull()
    expect(readHct('76a914' + '00'.repeat(20) + '88ac')).toBeNull()
  })

  it('derives the asset id from the outpoint', () => {
    const txid = '11'.repeat(32)
    expect(hctAssetId(txid, 0)).toMatch(/^[0-9a-f]{40}$/)
    expect(hctAssetId(txid, 0)).not.toBe(hctAssetId(txid, 1))
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
    const clause: HctClause = {
      mode: 'countersign',
      holder: pub(alice),
      issuer: { m: 1, keys: [pub(issuerKey)] },
      release: { kind: 'hash', rel: hash160Hex(secret) },
    }
    const coin = new Transaction()
    coin.addInput({ sourceTransaction: funding, sourceOutputIndex: nextFunding(), unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    coin.addOutput({ lockingScript: hctHeldLock({ assetId, amount: 5n, clause }), satoshis: 1 })
    const spend = (unlock: (tx: Transaction) => UnlockingScript) => {
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      tx.addOutput({ lockingScript: hctHeldLock({ assetId, amount: 5n, clause: { ...clause, holder: pub(bob) } }), satoshis: 1 })
      tx.inputs[0]!.unlockingScript = unlock(tx)
      return tx
    }
    const accepted = spend((tx) =>
      hctIssuerUnlock({
        issuerSignatures: [signInput(tx, 0, issuerKey, HCT_ISSUER_SCOPE)],
        shared: false,
        holderSignature: signInput(tx, 0, alice, HCT_HOLDER_SCOPE),
      }),
    )
    expect(inputScriptValid(accepted, 0)).toBe(true)
    expect(hctUnlockBranch(accepted.inputs[0]!.unlockingScript)).toBe('issuer')
    const holderAlone = spend((tx) => hctOpenUnlock(signInput(tx, 0, alice, HCT_HOLDER_SCOPE)))
    expect(inputScriptValid(holderAlone, 0)).toBe(false)
    const forgedIssuer = spend((tx) =>
      hctIssuerUnlock({
        issuerSignatures: [signInput(tx, 0, bob, HCT_ISSUER_SCOPE)],
        shared: false,
        holderSignature: signInput(tx, 0, alice, HCT_HOLDER_SCOPE),
      }),
    )
    expect(inputScriptValid(forgedIssuer, 0)).toBe(false)
    const released = spend((tx) => hctReleaseUnlock(secret, signInput(tx, 0, alice, HCT_HOLDER_SCOPE)))
    expect(inputScriptValid(released, 0)).toBe(true)
    expect(hctUnlockBranch(released.inputs[0]!.unlockingScript)).toBe('release')
    expect(revealedSecret(released.inputs[0]!.unlockingScript)).toEqual(secret)
    const wrongSecret = spend((tx) => hctReleaseUnlock(secret.map((b) => b ^ 1), signInput(tx, 0, alice, HCT_HOLDER_SCOPE)))
    expect(inputScriptValid(wrongSecret, 0)).toBe(false)
  })
})

describe('hct payload', () => {
  it('round-trips and refuses fields that cannot go together', () => {
    const item: HctDeployFields = { mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name: 'Robot', ctype: 'image/png', c: new Uint8Array([1, 2, 3]) }
    expect(decodeHctPayload(Uint8Array.from(encodeHctPayload(item)))).toMatchObject({ kind: 'item', name: 'Robot', ctype: 'image/png' })
    expect(decodeHctPayload(Uint8Array.from(encodeHctPayload(tokenFields)))).toMatchObject({ kind: 'token', sym: 'HCT', dec: 0 })
    expect(() => encodeHctPayload({ ...tokenFields, sil: HCT_MIN_SILENCE_SECONDS })).toThrow()
    expect(() => encodeHctPayload({ ...item, dec: 2 } as HctDeployFields)).toThrow()
    expect(() => encodeHctPayload({ ...tokenFields, ctype: 'image/png' })).toThrow()
    expect(() => encodeHctPayload({ ...tokenFields, name: 'see https://evil.example' })).toThrow()
    expect(() => encodeHctPayload({ ...tokenFields, mode: 'countersign' })).toThrow()
    expect(decodeHctPayload(new Uint8Array([0xa0]))).toBeNull()
  })
})

describe('hct keys', () => {
  it('anyone derives the issuer key from the identity', () => {
    expect(hctIssuerKeyOf(pub(identity))).toBe(pub(issuerKey))
  })

  it('holder keys match on both sides and never repeat', () => {
    const a = hctHolderPublicKey(alice, pub(bob), 'p1', 's1')
    expect(pub(hctHolderPrivateKey(bob, { derivationPrefix: 'p1', derivationSuffix: 's1', senderIdentityKey: pub(alice) }))).toBe(a)
    expect(hctHolderPublicKey(alice, pub(bob), 'p1', 's2')).not.toBe(a)
    const self = hctHolderPublicKey(alice, pub(alice), 'p1', 's1')
    expect(pub(hctHolderPrivateKey(alice, { derivationPrefix: 'p1', derivationSuffix: 's1', senderIdentityKey: pub(alice) }))).toBe(self)
  })
})

describe('hct deploy', () => {
  it('reads a deploy signed by the issuer', () => {
    const tx = deployTx({ supply: 1000n })
    const deploy = deployOf(tx)
    expect(deploy.assetId).toBe(hctAssetId(String(tx.id('hex')), 0))
    expect(deploy.issuerKeys).toEqual([pub(issuerKey)])
  })

  it('refuses a deploy nobody with the issuer key signed', () => {
    const forged = deployTx({ supply: 1000n, signer: bob })
    expect(readHctDeploy(forged, 0)).toMatchObject({ ok: false, reason: 'unsigned' })
  })

  it('refuses an issuer signature that does not commit to every output', () => {
    const single = 0x43
    const loose = deployTx({ supply: 1000n, scope: single })
    expect(readHctDeploy(loose, 0)).toMatchObject({ ok: false, reason: 'unsigned' })
  })

  it('refuses a clause that does not match the payload mode', () => {
    const clause: HctClause = {
      mode: 'countersign',
      holder: pub(alice),
      issuer: { m: 1, keys: [pub(bob)] },
      release: { kind: 'hash', rel: '00'.repeat(20) },
    }
    expect(readHctDeploy(deployTx({ supply: 10n, clause }), 0)).toMatchObject({ ok: false, reason: 'clause' })
  })

  it('refuses an item with a supply above one', () => {
    const fields: HctDeployFields = { mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name: 'Robot' }
    expect(readHctDeploy(deployTx({ supply: 2n, fields }), 0)).toMatchObject({ ok: false, reason: 'item-supply' })
  })
})

describe('hct validity', () => {
  it('conserves, splits and walks back to the deploy', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 60n, bob) }, { script: held(deploy.assetId, 40n, alice) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }, { tx: t1, vout: 1, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    expect(checkHctTx(t1, deploy)).toMatchObject({ ok: true })
    const result = await walkHct(String(t2.id('hex')), deploy, storeOf(dTx, t1, t2), () => false)
    expect(result).toEqual({ ok: true, validated: [String(t2.id('hex')), String(t1.id('hex'))] })
  })

  it('refuses inflation', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 101n, bob) }])
    expect(checkHctTx(t1, deploy)).toMatchObject({ ok: false, reason: 'conservation' })
    expect(await walkHct(String(t1.id('hex')), deploy, storeOf(dTx, t1), () => false)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('refuses outputs conjured without spending the asset', () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    tx.addOutput({ lockingScript: held(deploy.assetId, 50n, bob), satoshis: 1 })
    expect(checkHctTx(tx, deploy)).toMatchObject({ ok: false, reason: 'conjured' })
  })

  it('refuses a held output under a foreign clause', () => {
    const dTx = deployTx({ supply: 10n })
    const deploy = deployOf(dTx)
    const foreign = hctHeldLock({
      assetId: deploy.assetId,
      amount: 10n,
      clause: { mode: 'countersign', holder: pub(bob), issuer: { m: 1, keys: [pub(bob)] }, release: { kind: 'hash', rel: '00'.repeat(20) } },
    })
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: foreign }])
    expect(checkHctTx(t1, deploy)).toMatchObject({ ok: false, reason: 'output' })
  })

  it('refuses minting without an authority', () => {
    const dTx = deployTx({ supply: 10n })
    const deploy = deployOf(dTx)
    const t1 = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 10n, bob) }, { script: hctAuthorityLock({ assetId: deploy.assetId, clause: openClause(alice) }) }],
    )
    expect(checkHctTx(t1, deploy)).toMatchObject({ ok: false, reason: 'mint' })
  })

  it('mints through the authority when the deploy grants one', () => {
    const dTx = deployTx({ supply: 10n, fields: { ...tokenFields, auth: true } })
    const deploy = deployOf(dTx)
    const t1 = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 25n, bob) }, { script: hctAuthorityLock({ assetId: deploy.assetId, clause: openClause(alice) }) }],
    )
    expect(checkHctTx(t1, deploy)).toMatchObject({ ok: true })
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
    child.inputs[0]!.unlockingScript = hctOpenUnlock(signInput(child, 0, bob, HCT_HOLDER_SCOPE))
    expect(checkHctTx(child, deploy)).toMatchObject({ ok: true })
    const result = await walkHct(String(child.id('hex')), deploy, storeOf(dTx, t1, child), () => false)
    expect(result).toMatchObject({ ok: false, reason: 'invalid', txid: String(child.id('hex')) })
  })

  it('says missing, not invalid, when history is absent', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }], [{ script: held(deploy.assetId, 100n, alice) }])
    expect(await walkHct(String(t2.id('hex')), deploy, storeOf(dTx, t2), () => false)).toMatchObject({
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
    expect(await walkHct(String(t2.id('hex')), deploy, storeOf(t1, t2), (txid) => txid === known)).toEqual({
      ok: true,
      validated: [String(t2.id('hex'))],
    })
  })
})

describe('hct proof package', () => {
  it('carries the subject and the hops a recipient lacks, and reads back strictly', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }], [{ script: held(deploy.assetId, 100n, alice) }])
    const ancestry = await hctAncestry(t2, deploy, storeOf(dTx, t1), () => false)
    expect(ancestry.ok && ancestry.txs.map((tx) => String(tx.id('hex')))).toEqual([String(t1.id('hex'))])
    const { pkg, complete } = buildHctPackage(t2, ancestry.ok ? ancestry.txs : [], [dTx])
    expect(complete).toBe(true)
    const read = readHctPackage(JSON.parse(JSON.stringify(pkg)))!
    expect(String(read.subject.id('hex'))).toBe(String(t2.id('hex')))
    const all = new Map([...read.txs, ...read.deploys])
    expect(await walkHct(String(t2.id('hex')), deploy, async (id) => all.get(id) ?? null, () => false)).toMatchObject({ ok: true })
    expect(readHctPackage({ ...pkg, subject: '00'.repeat(32) })).toBeNull()
    expect(readHctPackage({ ...pkg, txs: ['zz'] })).toBeNull()
  })

  it('skips hops the recipient already holds and cuts to the budget', async () => {
    const dTx = deployTx({ supply: 100n })
    const deploy = deployOf(dTx)
    const t1 = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    const t2 = transfer([{ tx: t1, vout: 0, holder: bob }], [{ script: held(deploy.assetId, 100n, alice) }])
    const known = String(t1.id('hex'))
    const ancestry = await hctAncestry(t2, deploy, storeOf(dTx, t1), (txid) => txid === known)
    expect(ancestry).toEqual({ ok: true, txs: [] })
    const { complete } = buildHctPackage(t2, [t1], [dTx], t2.toHexEF().length + 100)
    expect(complete).toBe(false)
  })
})

describe('hct supply policy', () => {
  const capped = (max?: bigint, size?: bigint): HctDeployFields => ({
    ...tokenFields,
    auth: true,
    ...(max != null ? { max } : {}),
    ...(size != null ? { size } : {}),
  })
  const authority = (assetId: string, holder: PrivateKey, issued?: { units: bigint; members: bigint }) =>
    hctAuthorityLock({ assetId, clause: openClause(holder), ...(issued ? { issued } : {}) })

  it('names fixed, open and capped supply from the deploy', () => {
    expect(hctSupplyPolicy(tokenFields)).toEqual({ kind: 'fixed' })
    expect(hctSupplyPolicy({ ...tokenFields, auth: true })).toEqual({ kind: 'open' })
    expect(hctSupplyPolicy(capped(100n, 5n))).toEqual({ kind: 'capped', max: 100n, size: 5n })
  })

  it('round-trips caps past 2^53 and refuses a cap without an authority', () => {
    const max = (1n << 64n) - 1n
    expect(decodeHctPayload(Uint8Array.from(encodeHctPayload(capped(max))))).toMatchObject({ auth: true, max })
    expect(decodeHctPayload(Uint8Array.from(encodeHctPayload(capped(undefined, 3n))))).toMatchObject({ size: 3n })
    expect(() => encodeHctPayload({ ...tokenFields, max: 10n })).toThrow(/auth/)
    expect(() => encodeHctPayload(capped(0n))).toThrow()
    expect(() => encodeHctPayload({ ...capped(10n), kind: 'item', name: 'x', sym: undefined, dec: undefined, auth: undefined })).toThrow()
  })

  it('reads a capped authority back exactly and keeps the open form unchanged', () => {
    const assetId = 'cd'.repeat(20)
    const lock = authority(assetId, alice, { units: 300n, members: 0n })
    expect(readHct(lock)).toMatchObject({ form: 'authority', assetId, issued: { units: 300n, members: 0n } })
    expect(readHct(authority(assetId, alice))).toEqual({ form: 'authority', assetId, clause: openClause(alice) })
    expect(readHct(`${lock.toHex()}51`)).toBeNull()
  })

  it('refuses a deploy whose supply is over its own cap', () => {
    expect(readHctDeploy(deployTx({ supply: 101n, fields: capped(100n) }), 0)).toMatchObject({ ok: false, reason: 'over-cap' })
    expect(readHctDeploy(deployTx({ supply: 100n, fields: capped(100n) }), 0)).toMatchObject({ ok: true })
  })

  it('mints up to the cap and states the running total', () => {
    const dTx = deployTx({ supply: 60n, fields: capped(100n) })
    const deploy = deployOf(dTx)
    const ok = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 100n, alice) }, { script: authority(deploy.assetId, alice, { units: 100n, members: 0n }) }],
    )
    expect(checkHctTx(ok, deploy)).toMatchObject({ ok: true, issued: { units: 100n, members: 0n } })
    const over = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 101n, alice) }, { script: authority(deploy.assetId, alice, { units: 101n, members: 0n }) }],
    )
    expect(checkHctTx(over, deploy)).toMatchObject({ ok: false, reason: 'over-cap' })
  })

  it('refuses an authority that understates, omits or invents its issued count', () => {
    const dTx = deployTx({ supply: 60n, fields: capped(100n) })
    const deploy = deployOf(dTx)
    const lie = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 90n, alice) }, { script: authority(deploy.assetId, alice, { units: 60n, members: 0n }) }],
    )
    expect(checkHctTx(lie, deploy)).toMatchObject({ ok: false, reason: 'mint' })
    const omitted = transfer(
      [{ tx: dTx, vout: 0, holder: alice }],
      [{ script: held(deploy.assetId, 60n, alice) }, { script: authority(deploy.assetId, alice) }],
    )
    expect(checkHctTx(omitted, deploy)).toMatchObject({ ok: false, reason: 'output' })
    const oTx = deployTx({ supply: 10n, fields: { ...tokenFields, auth: true } })
    const open = deployOf(oTx)
    const invented = transfer(
      [{ tx: oTx, vout: 0, holder: alice }],
      [{ script: held(open.assetId, 10n, alice) }, { script: authority(open.assetId, alice, { units: 10n, members: 0n }) }],
    )
    expect(checkHctTx(invented, open)).toMatchObject({ ok: false, reason: 'output' })
  })

  it('still enforces the cap when the authority is dropped', () => {
    const dTx = deployTx({ supply: 60n, fields: capped(100n) })
    const deploy = deployOf(dTx)
    const closing = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 100n, bob) }])
    expect(checkHctTx(closing, deploy)).toMatchObject({ ok: true })
    const over = transfer([{ tx: dTx, vout: 0, holder: alice }], [{ script: held(deploy.assetId, 101n, bob) }])
    expect(checkHctTx(over, deploy)).toMatchObject({ ok: false, reason: 'over-cap' })
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
    expect(await walkHct(String(m2.id('hex')), deploy, storeOf(dTx, m1, m2), () => false)).toMatchObject({ ok: true })
    const m3 = transfer(
      [{ tx: m2, vout: 1, holder: alice }],
      [{ script: held(deploy.assetId, 1n, bob) }, { script: authority(deploy.assetId, alice, { units: 31n, members: 0n }) }],
    )
    expect(await walkHct(String(m3.id('hex')), deploy, storeOf(dTx, m1, m2, m3), () => false)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('counts collection members against its size', () => {
    const cTx = deployTx({ supply: 1n, fields: capped(undefined, 1n) })
    const collection = deployOf(cTx)
    const member = (count: number, issued: { units: bigint; members: bigint }) => {
      const coin = coinFor(issuerKey)
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: coin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      tx.addInput({ sourceTransaction: cTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
      const item: HctDeployFields = { mode: 'open', kind: 'item', iss: [pub(identity)], m: 1, name: 'Member', col: collection.assetId }
      for (let i = 0; i < count; i++) {
        tx.addOutput({ lockingScript: hctDeployLock({ supply: 1n, payload: encodeHctPayload({ ...item, name: `Member ${i}` }), clause: openClause(alice) }), satoshis: 1 })
      }
      tx.addOutput({ lockingScript: held(collection.assetId, 1n, alice), satoshis: 1 })
      tx.addOutput({ lockingScript: authority(collection.assetId, alice, issued), satoshis: 1 })
      tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, issuerKey, HCT_ISSUER_SCOPE))
      tx.inputs[1]!.unlockingScript = hctOpenUnlock(signInput(tx, 1, alice, HCT_HOLDER_SCOPE))
      return tx
    }
    const one = member(1, { units: 1n, members: 1n })
    expect(readHctDeploy(one, 0)).toMatchObject({ ok: true, deploy: { member: true } })
    expect(checkHctTx(one, collection)).toMatchObject({ ok: true, issued: { units: 1n, members: 1n } })
    expect(checkHctTx(member(2, { units: 1n, members: 2n }), collection)).toMatchObject({ ok: false, reason: 'over-cap' })
    expect(checkHctTx(member(1, { units: 1n, members: 0n }), collection)).toMatchObject({ ok: false, reason: 'mint' })
  })
})
