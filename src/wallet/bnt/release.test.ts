import { LockingScript, MerklePath, OP, PrivateKey, Transaction, UnlockingScript, type ChainTracker } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { signInput } from '../txInputs'
import { checkIptHashRelease } from './release'
import { BNT_ISSUER_SCOPE, bntBeaconLock, hash160Hex, type BntRules } from './script'
import type { BntDeploy } from './validity'

const issuer = PrivateKey.fromRandom()
const secret = new Array(32).fill(7)
const rules: Extract<BntRules, { mode: 'countersign' }> = {
  mode: 'countersign',
  issuer: { m: 1, keys: [issuer.toPublicKey().toString()] },
  release: { kind: 'hash', rel: hash160Hex(secret) },
}
const script = bntBeaconLock(rules)
const height = 800_000
const sink = () => new LockingScript().writeOpCode(OP.OP_TRUE)

function fixture() {
  const origin = new Transaction()
  origin.addOutput({ lockingScript: script, satoshis: 1 })
  const deploy = {
    rules,
    fields: { mode: 'countersign', kind: 'token', iss: [issuer.toPublicKey().toString()], m: 1, bcn: `${origin.id('hex')}_0`, sil: 604_800, rel: hash160Hex(secret) },
  } as BntDeploy
  return { origin, deploy }
}

function refresh(parent: Transaction, outputs = [script]): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  outputs.forEach((lockingScript) => tx.addOutput({ lockingScript, satoshis: 1 }))
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(tx, 0, issuer, BNT_ISSUER_SCOPE)).writeOpCode(OP.OP_1)
  return tx
}

function release(parent: Transaction): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript().writeBin(secret).writeOpCode(OP.OP_0), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: sink(), satoshis: 1 })
  return tx
}

function mined(tx: Transaction): ChainTracker {
  const id = String(tx.id('hex'))
  tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: 'cd'.repeat(32) }, { offset: 1, hash: id, txid: true }]])
  const root = tx.merklePath.computeRoot(id)
  return { isValidRootForHeight: async (r, h) => r === root && h === height, currentHeight: async () => height + 1 }
}

describe('BRC-253 §9 mined hash release', () => {
  it('checks a release through a signed refresh against the deploy and chain root', async () => {
    const { origin, deploy } = fixture()
    const next = refresh(origin)
    const end = release(next)
    expect(await checkIptHashRelease(deploy, [origin, next, end], mined(end))).toEqual({ ok: true, secret })
  })
  it('waits for inclusion, not just a revealed secret or an unrelated merkle root', async () => {
    const { origin, deploy } = fixture()
    const end = release(origin)
    const unrelated = mined(refresh(origin))
    expect(await checkIptHashRelease(deploy, [origin, end], unrelated)).toMatchObject({ ok: false, missing: true })
    mined(end)
    expect(await checkIptHashRelease(deploy, [origin, end], unrelated)).toMatchObject({ ok: false, missing: true })
  })
  it('rejects a valid refresh signature with the wrong commitment scope', async () => {
    const { origin, deploy } = fixture()
    const next = refresh(origin)
    next.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(signInput(next, 0, issuer, 0xc1)).writeOpCode(OP.OP_1)
    const end = release(next)
    expect(await checkIptHashRelease(deploy, [origin, next, end], mined(end))).toMatchObject({ ok: false, missing: false, detail: 'the beacon refresh is not signed ALL|FORKID' })
  })
  it('checks every signature and the dummy in a shared-issuer refresh', async () => {
    const other = PrivateKey.fromRandom()
    const sharedRules = { ...rules, issuer: { m: 2, keys: [issuer.toPublicKey().toString(), other.toPublicKey().toString()] } }
    const sharedScript = bntBeaconLock(sharedRules)
    const origin = new Transaction()
    origin.addOutput({ lockingScript: sharedScript, satoshis: 1 })
    const deploy = { ...fixture().deploy, rules: sharedRules, fields: { ...fixture().deploy.fields, bcn: `${origin.id('hex')}_0` } }
    const next = new Transaction()
    next.addInput({ sourceTransaction: origin, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    next.addOutput({ lockingScript: sharedScript, satoshis: 1 })
    const signatures = [issuer, other].map((key) => signInput(next, 0, key, BNT_ISSUER_SCOPE))
    next.inputs[0]!.unlockingScript = new UnlockingScript().writeOpCode(OP.OP_0).writeBin(signatures[0]!).writeBin(signatures[1]!).writeOpCode(OP.OP_1)
    const end = release(next)
    expect(await checkIptHashRelease(deploy, [origin, next, end], mined(end))).toEqual({ ok: true, secret })
    next.inputs[0]!.unlockingScript = new UnlockingScript().writeOpCode(OP.OP_1).writeBin(signatures[0]!).writeBin(signatures[1]!).writeOpCode(OP.OP_1)
    const badDummy = release(next)
    expect(await checkIptHashRelease(deploy, [origin, next, badDummy], mined(badDummy))).toMatchObject({ ok: false, missing: false })
    next.inputs[0]!.unlockingScript = new UnlockingScript().writeOpCode(OP.OP_0).writeBin(signatures[0]!).writeBin(signatures[0]!).writeOpCode(OP.OP_1)
    const forged = release(next)
    expect(await checkIptHashRelease(deploy, [origin, next, forged], mined(forged))).toMatchObject({ ok: false, missing: false })
  })
  it('rejects a disconnected chain and a different deploy beacon', async () => {
    const { origin, deploy } = fixture()
    const next = refresh(origin)
    const end = release(next)
    const tracker = mined(end)
    expect(await checkIptHashRelease(deploy, [origin, end], tracker)).toMatchObject({ ok: false, missing: false })
    expect(await checkIptHashRelease(deploy, [next, end], tracker)).toMatchObject({ ok: false, missing: false })
  })
  it('rejects duplicate and misplaced next beacons even with valid issuer signatures', async () => {
    const { origin, deploy } = fixture()
    for (const next of [refresh(origin, [script, script]), refresh(origin, [sink(), script])]) {
      const end = release(next)
      expect(await checkIptHashRelease(deploy, [origin, next, end], mined(end))).toMatchObject({ ok: false, missing: false })
    }
  })
  it('rejects a release that creates another beacon', async () => {
    const { origin, deploy } = fixture()
    const end = release(origin)
    end.addOutput({ lockingScript: script, satoshis: 1 })
    expect(await checkIptHashRelease(deploy, [origin, end], mined(end))).toMatchObject({ ok: false, missing: false })
  })
  it('rejects a forged EF parent claim and wrong release secret', async () => {
    const { origin, deploy } = fixture()
    const end = release(origin)
    end.inputs[0]!.sourceTransaction = Transaction.fromHex(origin.toHex())
    end.inputs[0]!.sourceTransaction!.outputs[0]!.satoshis = 2
    end.inputs[0]!.sourceTXID = String(origin.id('hex'))
    expect(await checkIptHashRelease(deploy, [origin, end], mined(end))).toMatchObject({ ok: false, missing: false })
    const wrong = release(origin)
    wrong.inputs[0]!.unlockingScript = new UnlockingScript().writeBin(new Array(32).fill(8)).writeOpCode(OP.OP_0)
    expect(await checkIptHashRelease(deploy, [origin, wrong], mined(wrong))).toMatchObject({ ok: false, missing: false })
  })
})
