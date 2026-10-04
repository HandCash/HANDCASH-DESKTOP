import { describe, expect, it } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { signTipInputs } from './signTipInputs'

const key = PrivateKey.fromHex('11'.repeat(32))

/** Inscription envelope ‖ P2PKH, the shape of a held tip. */
function tipLock(n: number): LockingScript {
  const p2pkh = new P2PKH().lock(key.toAddress()).toHex()
  const body = Buffer.from(`tip ${n}`).toString('hex')
  return LockingScript.fromHex(`0063036f7264510a746578742f706c61696e00${(body.length / 2).toString(16).padStart(2, '0')}${body}68${p2pkh}`)
}

function spendOf(count: number): { tx: Transaction; vins: number[] } {
  const source = new Transaction()
  source.addInput({
    sourceTXID: 'ab'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: LockingScript.fromHex('00') as never,
  })
  for (let n = 0; n < count; n++) source.addOutput({ lockingScript: tipLock(n), satoshis: 1 })
  const tx = new Transaction()
  const vins: number[] = []
  for (let n = 0; n < count; n++) {
    const lockingScript = source.outputs[n]!.lockingScript
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: n,
      unlockingScriptTemplate: new P2PKH().unlock(key, 'all', false, 1, lockingScript),
    })
    vins.push(n)
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: count })
  return { tx, vins }
}

describe('signTipInputs', () => {
  it('signs exactly what Transaction.sign() signs, input by input', async () => {
    const ours = spendOf(6)
    const sdk = spendOf(6)
    const spends = await signTipInputs(ours.tx, ours.vins)
    await sdk.tx.sign()

    for (const vin of ours.vins) {
      expect(spends[vin]!.unlockingScript).toBe(sdk.tx.inputs[vin]!.unlockingScript!.toHex())
      expect(ours.tx.inputs[vin]!.unlockingScript!.toHex()).toBe(spends[vin]!.unlockingScript)
    }
  })

  it('refuses an input without a template instead of leaving it unsigned', async () => {
    const { tx } = spendOf(2)
    tx.inputs[1]!.unlockingScriptTemplate = undefined
    await expect(signTipInputs(tx, [0, 1])).rejects.toThrow('Input 1 has no unlocking template')
  })
})
