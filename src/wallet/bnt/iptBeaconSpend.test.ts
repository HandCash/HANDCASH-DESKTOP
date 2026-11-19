import { LockingScript, OP, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { inputScriptValid, signInput } from '../txInputs'
import { signIptBeaconSpend } from './iptBeaconSpend'
import { bntBeaconLock, hash160Hex, p2pkLock, type BntRules } from './script'

const issuer = PrivateKey.fromRandom()
const payer = PrivateKey.fromRandom()
const rules: Extract<BntRules, { mode: 'countersign' }> = {
  mode: 'countersign', issuer: { m: 1, keys: [issuer.toPublicKey().toString()] },
  release: { kind: 'hash', rel: hash160Hex(new Array(32).fill(7)) },
}
function parent(lockingScript: LockingScript, satoshis: number) {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript().writeOpCode(OP.OP_1), sequence: 0xffffffff })
  tx.addOutput({ lockingScript, satoshis })
  return tx
}
function fixture() {
  const beacon = parent(bntBeaconLock(rules), 1)
  const fee = parent(p2pkLock(payer.toPublicKey().toString()), 500)
  return {
    rules, genesis: `${beacon.id('hex')}_0`, beacon: { tx: beacon, vout: 0 }, fee: { tx: fee, vout: 0 }, minimumFee: 100,
    signIssuer: async (tx: Transaction, vin: number) => signInput(tx, vin, issuer, 0x41),
    signFee: async (tx: Transaction, vin: number) => new UnlockingScript().writeBin(signInput(tx, vin, payer, 0x41)),
  }
}
describe('BRC-253 §9 signed singleton beacon spends', () => {
  it('refreshes with the beacon first, one fee input and no change', async () => {
    const args = fixture()
    const tx = await signIptBeaconSpend(args)
    expect(tx.inputs).toHaveLength(2)
    expect(tx.outputs).toHaveLength(1)
    expect(tx.outputs[0]!.lockingScript.toHex()).toBe(bntBeaconLock(rules).toHex())
    expect(inputScriptValid(tx, 0)).toBe(true)
    expect(inputScriptValid(tx, 1)).toBe(true)
    expect(args.beacon.tx.outputs).toHaveLength(1)
  })
  it('retirement retains the final beacon and commits its genesis marker', async () => {
    const args = fixture()
    const tx = await signIptBeaconSpend({ ...args, retire: true })
    expect(tx.outputs).toHaveLength(2)
    expect(tx.outputs[1]!.lockingScript.toASM()).toContain('OP_RETURN')
    expect(inputScriptValid(tx, 0)).toBe(true)
  })
  it('refuses wrong keys, signature scope, funding and shared issuers', async () => {
    const args = fixture()
    await expect(signIptBeaconSpend({ ...args, signIssuer: async (tx, vin) => signInput(tx, vin, payer, 0x41) })).rejects.toThrow('signatures')
    await expect(signIptBeaconSpend({ ...args, signIssuer: async (tx, vin) => signInput(tx, vin, issuer, 0xc1) })).rejects.toThrow('ALL|FORKID')
    await expect(signIptBeaconSpend({ ...args, minimumFee: 501 })).rejects.toThrow('funding')
    await expect(signIptBeaconSpend({ ...args, fee: args.beacon })).rejects.toThrow()
    await expect(signIptBeaconSpend({ ...args, rules: { ...rules, issuer: { m: 2, keys: [issuer.toPublicKey().toString(), payer.toPublicKey().toString()] } } })).rejects.toThrow('quorum')
  })
  it('does not let signing callbacks mutate the committed outputs', async () => {
    const args = fixture()
    await expect(signIptBeaconSpend({ ...args, signIssuer: async (tx, vin) => {
      tx.outputs[0]!.satoshis = 0
      return signInput(tx, vin, issuer, 0x41)
    } })).rejects.toThrow('signatures')
  })
})
