import { describe, expect, it } from 'vitest'
import { planCoinOutputs, planCoinPayment } from './coinWallet'

const binding = { dust: 546n, size: { overhead: 11, input: 68 }, sequence: 0xfffffffd }
const script = (byte: number, length = 22) => new Uint8Array(length).fill(byte)
const coin = (n: number, litoshi: bigint) => ({ txid: n.toString(16).padStart(64, '0'), vout: 0, litoshi })
const lock = script(1, 34)
const fee = script(2, 34)
const change = script(3)

describe('planCoinOutputs', () => {
  it('pays every output in order, then change', () => {
    const plan = planCoinOutputs(binding, [coin(1, 1_000_000n)], [{ script: lock, value: 400_000n }, { script: fee, value: 2_000n }], change, 2)!
    expect(plan.tx.outputs.map((o) => o.value)).toEqual([400_000n, 2_000n, plan.change!.litoshi])
    expect(plan.tx.outputs[0]!.script).toEqual(lock)
    expect(plan.tx.outputs[1]!.script).toEqual(fee)
    expect(plan.change).toEqual({ vout: 2, litoshi: 1_000_000n - 402_000n - plan.fee })
    const bytes = binding.size.overhead + binding.size.input + (9 + 34) * 2 + (9 + 22)
    expect(plan.fee).toBe(BigInt(2 * bytes))
  })

  it('takes coins largest first until the outputs and fee are covered', () => {
    const plan = planCoinOutputs(binding, [coin(1, 300_000n), coin(2, 200_000n), coin(3, 100_000n)], [{ script: lock, value: 450_000n }], change, 1)!
    expect(plan.inputs).toEqual([`${coin(1, 0n).txid}:0`, `${coin(2, 0n).txid}:0`])
    expect(plan.amounts).toEqual([300_000n, 200_000n])
  })

  it('gives a remainder below dust to the fee rather than keeping it as change', () => {
    const plan = planCoinOutputs(binding, [coin(1, 100_400n)], [{ script: lock, value: 100_000n }], change, 1)!
    expect(plan.change).toBeUndefined()
    expect(plan.tx.outputs).toHaveLength(1)
    expect(plan.fee).toBe(400n)
  })

  it('refuses no outputs and too little', () => {
    expect(planCoinOutputs(binding, [coin(1, 1_000_000n)], [], change, 1)).toBeNull()
    expect(planCoinOutputs(binding, [coin(1, 1_000n)], [{ script: lock, value: 1_000n }], change, 1)).toBeNull()
  })

  it('agrees with planCoinPayment for one output', () => {
    const coins = [coin(1, 500_000n)]
    expect(planCoinPayment(binding, coins, lock, change, 123_456n, 3)).toEqual(planCoinOutputs(binding, coins, [{ script: lock, value: 123_456n }], change, 3))
  })
})
