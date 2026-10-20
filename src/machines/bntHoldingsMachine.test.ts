import { describe, expect, it } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import { bntHoldingsMachine } from './bntHoldingsMachine'
import type { BntAssetSummary } from '../wallet/bnt/wallet'
import { parseTokenAmount } from '../wallet/amounts'

const asset = (assetId: string, kind: 'token' | 'item' = 'token'): BntAssetSummary => ({
  assetId,
  kind,
  mode: 'open',
  sym: 'GOLD',
  dec: 2,
  issuers: [],
  balance: '1000',
  outputs: 1,
  authority: false,
  deploy: `${'a'.repeat(64)}_0`,
})

function start(loads: Array<() => Promise<BntAssetSummary[]>>) {
  let n = 0
  const machine = bntHoldingsMachine.provide({
    actors: { load: fromPromise(() => loads[Math.min(n++, loads.length - 1)]()) },
  })
  return createActor(machine).start()
}

describe('bntHoldingsMachine', () => {
  it('loads, opens a held asset and refuses one it does not hold', async () => {
    const actor = start([async () => [asset('1'.repeat(40))]])
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'OPEN', assetId: '2'.repeat(40) })
    expect(actor.getSnapshot().matches({ ready: 'browsing' })).toBe(true)
    actor.send({ type: 'OPEN', assetId: '1'.repeat(40) })
    expect(actor.getSnapshot().matches({ ready: 'composing' })).toBe(true)
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().context.composing).toBeNull()
  })

  it('keeps the send form across a reload while the asset is still held', async () => {
    const id = '1'.repeat(40)
    const actor = start([async () => [asset(id)], async () => [asset(id)]])
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'OPEN', assetId: id })
    actor.send({ type: 'REFRESH' })
    await waitFor(actor, (s) => s.matches('ready'))
    expect(actor.getSnapshot().matches({ ready: 'composing' })).toBe(true)
  })

  it('closes the form when a reload shows the asset is gone', async () => {
    const id = '1'.repeat(40)
    const actor = start([async () => [asset(id)], async () => []])
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'OPEN', assetId: id })
    actor.send({ type: 'REFRESH' })
    await waitFor(actor, (s) => s.matches('ready'))
    expect(actor.getSnapshot().matches({ ready: 'browsing' })).toBe(true)
    expect(actor.getSnapshot().context.composing).toBeNull()
  })

  it('fails with a reason and recovers on refresh', async () => {
    const actor = start([async () => Promise.reject(new Error('locked')), async () => []])
    await waitFor(actor, (s) => s.matches('failed'))
    expect(actor.getSnapshot().context.error).toBe('locked')
    actor.send({ type: 'REFRESH' })
    await waitFor(actor, (s) => s.matches('ready'))
    expect(actor.getSnapshot().context.error).toBeNull()
  })
})

describe('parseTokenAmount', () => {
  it('converts typed amounts to integer units', () => {
    expect(parseTokenAmount('1.5', 2)).toBe('150')
    expect(parseTokenAmount('1,000', 0)).toBe('1000')
    expect(parseTokenAmount('.01', 2)).toBe('1')
    expect(parseTokenAmount('2.50', 1)).toBe('25')
  })

  it('refuses zero, junk and precision the token does not have', () => {
    for (const bad of ['', '0', '0.00', '.', '1.001', '-1', '1e3', 'abc']) {
      expect(parseTokenAmount(bad, 2), bad).toBeNull()
    }
  })
})
