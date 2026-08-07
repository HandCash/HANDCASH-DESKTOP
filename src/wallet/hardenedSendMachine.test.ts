import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  estimateUnlockingLength,
  feeUnlockBytes,
  hardenedSendMachine,
  spendsFitBudget,
  unlockingScriptByteLength,
} from './hardenedSendMachine'
import { HARDENED_UNLOCKING_SCRIPT_LENGTH } from './oneSatHardenedLatch'

describe('hardenedSendMachine + unlock budget', () => {
  it('estimates enough for embedded parent txs without 1.35× / 20k pad', () => {
    // Three txs totaling ~25k bytes + extras — budget is payload + light framing.
    const txA = 'ab'.repeat(10_000) // 10_000 bytes
    const txB = 'cd'.repeat(8_000)
    const txC = 'ef'.repeat(7_105)
    const state = '11'.repeat(2_000)
    const tipScript = '22'.repeat(1_500)
    const budget = estimateUnlockingLength([txA, txB, txC], [state, tipScript])
    const needed = unlockingScriptByteLength('ff'.repeat(38_095))
    expect(budget).toBeGreaterThanOrEqual(needed)
    expect(budget).toBeGreaterThanOrEqual(HARDENED_UNLOCKING_SCRIPT_LENGTH)
    // No double-pad: must stay well below old ceil(payload*1.35)+20480.
    expect(budget).toBeLessThan(Math.ceil(38_095 * 1.35) + 20_480)
  })

  it('feeUnlockBytes passes the fit size through for createAction', () => {
    expect(feeUnlockBytes(48_000)).toBe(48_000)
    expect(feeUnlockBytes(12_345)).toBe(12_345)
  })

  it('rejects spends over budget before signAction', () => {
    const fit = spendsFitBudget(
      { 0: { unlockingScript: 'aa'.repeat(100) } },
      50,
    )
    expect(fit.ok).toBe(false)
    if (!fit.ok) {
      expect(fit.actual).toBe(100)
      expect(fit.budget).toBe(50)
    }
  })

  it('tracks commit → settle phases', () => {
    const actor = createActor(hardenedSendMachine).start()
    actor.send({ type: 'SEND', outpoint: 'aa.0', mode: 'genesis' })
    expect(actor.getSnapshot().value).toBe('gating')
    actor.send({ type: 'PROVEN_OK' })
    expect(actor.getSnapshot().value).toBe('commitBuild')
    actor.send({ type: 'COMMIT_BUILT', unlockBudgetBytes: 48_000 })
    expect(actor.getSnapshot().value).toBe('commitSign')
    actor.send({ type: 'COMMIT_SIGNED', commitTxid: 'cc'.repeat(32) })
    expect(actor.getSnapshot().value).toBe('settleBuild')
    actor.send({ type: 'SETTLE_BUILT', unlockBudgetBytes: 60_000 })
    expect(actor.getSnapshot().value).toBe('settleSign')
    actor.send({ type: 'SETTLE_SIGNED', settleTxid: 'dd'.repeat(32) })
    expect(actor.getSnapshot().value).toBe('done')
    actor.stop()
  })
})
