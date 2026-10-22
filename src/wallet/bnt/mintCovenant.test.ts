import { LockingScript, OP, PrivateKey, Script, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { inputScriptValid } from '../txInputs'
import { bntMintUnlock, mintCovenantBody } from './mintCovenant'
import { bntHeldLock, bntMintLock, readBnt } from './script'

const assetId = 'ab'.repeat(20)
const lim = 1000n
const minter = PrivateKey.fromRandom().toPublicKey().toString()
const anyone = new Script().writeOpCode(OP.OP_TRUE) as LockingScript

function parent(remaining: number): Transaction {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: bntMintLock({ assetId, remaining, lim }), satoshis: 1 })
  tx.addOutput({ lockingScript: anyone, satoshis: 5000 })
  return tx
}

/** A spend of the mint at input 0 with `outputs`, signed by the covenant (changing nLockTime until it signs). */
function spend(remaining: number, outputs: Array<{ lockingScript: LockingScript; satoshis: number }>, unlockRemaining = remaining): Transaction {
  const source = parent(remaining)
  for (let lockTime = 0; lockTime < 64; lockTime++) {
    const tx = new Transaction(1, [], [], lockTime)
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
    for (const o of outputs) tx.addOutput(o)
    const unlock = bntMintUnlock(tx, 0, minter, unlockRemaining)
    if (!unlock) continue
    tx.inputs[0]!.unlockingScript = unlock
    return tx
  }
  throw new Error('no lockTime signs')
}

const held = (amount: bigint, holder = minter) => ({ lockingScript: bntHeldLock({ assetId, amount, clause: { mode: 'open', holder } }), satoshis: 1 })
const mint = (remaining: number, satoshis = 1) => ({ lockingScript: bntMintLock({ assetId, remaining, lim }), satoshis })
const change = { lockingScript: anyone, satoshis: 4000 }

describe('open-mint covenant', () => {
  it('reads back canonically, and its script code needs a 3-byte length', () => {
    expect(readBnt(bntMintLock({ assetId, remaining: 7, lim }))).toEqual({ form: 'mint', assetId, remaining: 7, lim })
    expect(readBnt(bntMintLock({ assetId, remaining: 1, lim: 5n }))).toEqual({ form: 'mint', assetId, remaining: 1, lim: 5n })
    const length = bntMintLock({ assetId, remaining: 1, lim: 1n }).toBinary().length
    expect(length).toBeGreaterThanOrEqual(253)
    expect(length).toBeLessThan(0x10000)
    expect(mintCovenantBody(1n).toHex()).not.toBe(mintCovenantBody(2n).toHex())
  })

  it('lets anyone mint lim units by re-creating the mint with one fewer left', () => {
    expect(inputScriptValid(spend(3, [mint(2), held(lim), change]), 0)).toBe(true)
  })

  it('drops the mint on its last use', () => {
    expect(inputScriptValid(spend(1, [held(lim), change]), 0)).toBe(true)
  })

  it('refuses a mint that keeps its count, mints more, mints to another key than the unlock names, or moves the outputs', () => {
    expect(inputScriptValid(spend(3, [mint(3), held(lim), change]), 0)).toBe(false)
    expect(inputScriptValid(spend(3, [mint(2), held(lim + 1n), change]), 0)).toBe(false)
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(inputScriptValid(spend(3, [mint(2), held(lim, other), change]), 0)).toBe(false)
    expect(inputScriptValid(spend(3, [held(lim), mint(2), change]), 0)).toBe(false)
    expect(inputScriptValid(spend(3, [mint(2, 2), held(lim), change]), 0)).toBe(false)
    expect(inputScriptValid(spend(3, [change]), 0)).toBe(false)
  })

  it('refuses an unlock whose preimage is not this transaction', () => {
    const tx = spend(3, [mint(2), held(lim), change])
    tx.outputs[2]!.satoshis = 3999
    expect(inputScriptValid(tx, 0)).toBe(false)
  })
})
