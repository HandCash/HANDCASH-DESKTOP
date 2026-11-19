import { Hash, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { signInput } from '../txInputs'
import { BNT_HOLDER_SCOPE, bntHeldLock, bntOpenUnlock, p2pkLock, type BntRules } from './script'
import type { BntDeploy } from './validity'
import { iptRequestId, signIptProposal, validateIptProposal } from './iptProposal'

function fixture() {
  const holder = PrivateKey.fromRandom()
  const issuer = PrivateKey.fromRandom()
  const rules: BntRules = { mode: 'countersign', issuer: { m: 1, keys: [issuer.toPublicKey().toString()] }, release: { kind: 'hash', rel: 'ab'.repeat(20) } }
  const assetId = 'cd'.repeat(20)
  const parent = new Transaction()
  parent.addInput({ sourceTXID: 'ef'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  parent.addOutput({ satoshis: 1, lockingScript: bntHeldLock({ assetId, amount: 10n, clause: { ...rules, holder: holder.toPublicKey().toString() } }) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  tx.addOutput({ satoshis: 1, lockingScript: bntHeldLock({ assetId, amount: 10n, clause: { ...rules, holder: holder.toPublicKey().toString() } }) })
  const sign = (key = holder, scope = BNT_HOLDER_SCOPE) => {
    tx.inputs[0]!.unlockingScript = bntOpenUnlock(signInput(tx, 0, key, scope))
    return tx.toEF()
  }
  const outpoint = `${parent.id('hex')}.0`
  const accepted = new Map([[outpoint, { satoshis: 1, lockingScript: parent.outputs[0]!.lockingScript.toHex() }]])
  const deploy = { assetId, rules } as BntDeploy
  return { tx, sign, accepted, deploy, outpoint, issuer }
}

describe('BRC-253 proposal commitment and holder validation', () => {
  it('commits exact EF and verifies a real signature over the original script', () => {
    const f = fixture()
    const ef = f.sign()
    expect(validateIptProposal(ef, f.deploy, f.accepted)).toMatchObject({
      requestId: Utils.toHex(Hash.sha256(ef)), inputs: [f.outpoint], amount: 10n,
    })
    const changed = [...ef]
    changed[changed.length - 1] ^= 1
    expect(iptRequestId(changed)).not.toBe(iptRequestId(ef))
  })
  it('refuses unknown or mismatched accepted sources', () => {
    const f = fixture()
    const ef = f.sign()
    expect(() => validateIptProposal(ef, f.deploy, new Map())).toThrow('accepted set')
    f.accepted.get(f.outpoint)!.satoshis = 2
    expect(() => validateIptProposal(ef, f.deploy, f.accepted)).toThrow('accepted set')
  })
  it('refuses wrong holder and signature scope', () => {
    const f = fixture()
    expect(() => validateIptProposal(f.sign(PrivateKey.fromRandom()), f.deploy, f.accepted)).toThrow('signature')
    expect(() => validateIptProposal(f.sign(undefined, 0x41), f.deploy, f.accepted)).toThrow('ALL|ANYONECANPAY')
  })
  it('refuses altered outputs even when amounts still conserve', () => {
    const f = fixture()
    f.sign()
    const changed = fixture()
    f.tx.outputs[0]!.lockingScript = changed.tx.outputs[0]!.lockingScript
    expect(() => validateIptProposal(f.tx.toEF(), f.deploy, f.accepted)).toThrow('signature')
  })
  it('refuses duplicate inputs, nonconservation and non-carrier outputs', () => {
    const f = fixture()
    f.tx.addInput({ ...f.tx.inputs[0]! })
    expect(() => validateIptProposal(f.sign(), f.deploy, f.accepted)).toThrow('duplicate')
    const g = fixture()
    g.tx.outputs[0]!.satoshis = 2
    expect(() => validateIptProposal(g.sign(), g.deploy, g.accepted)).toThrow('output clause')
  })
  it('funds and countersigns a singleton proposal with real script signatures', async () => {
    const f = fixture()
    const feeKey = PrivateKey.fromRandom()
    const fee = new Transaction()
    fee.addInput({ sourceTXID: '12'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    fee.addOutput({ satoshis: 500, lockingScript: p2pkLock(feeKey.toPublicKey().toString()) })
    const ef = f.sign()
    const args = {
      ef, deploy: f.deploy, accepted: f.accepted, fee: { tx: fee, vout: 0 }, minimumFee: 1,
      signIssuer: async (tx: Transaction, vin: number, scope: number) => signInput(tx, vin, f.issuer, scope),
      signFee: async (tx: Transaction, vin: number, scope: number) => bntOpenUnlock(signInput(tx, vin, feeKey, scope)),
    }
    const result = await signIptProposal(args)
    expect(result.requestId).toBe(iptRequestId(ef))
    expect(result.tx.inputs).toHaveLength(2)
    expect(result.tx.outputs.map((o) => o.lockingScript.toHex())).toEqual(f.tx.outputs.map((o) => o.lockingScript.toHex()))
    expect(result.tx.outputs).toHaveLength(1)
    expect(f.tx.inputs).toHaveLength(1)
    await expect(signIptProposal({ ...args, signIssuer: async (tx, vin, scope) => signInput(tx, vin, feeKey, scope) })).rejects.toThrow('signatures')
    await expect(signIptProposal({ ...args, minimumFee: 501 })).rejects.toThrow('fee source')
  })
  it('bounds bytes before parsing', () => {
    expect(() => iptRequestId([])).toThrow('bytes')
    expect(() => iptRequestId([256])).toThrow('bytes')
    expect(() => iptRequestId(new Array(1024 * 1024 + 1).fill(0))).toThrow('bytes')
  })
})
