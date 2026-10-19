import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { swapSettleMachine, type SwapSettleEvent, type SwapSettlePhase } from './swapSettleMachine'

const at = (phase: SwapSettlePhase) => createActor(swapSettleMachine, { snapshot: swapSettleMachine.resolveState({ value: phase, context: undefined }) }).start()
const can = (phase: SwapSettlePhase, event: SwapSettleEvent) => at(phase).getSnapshot().can(event)

describe('swapSettleMachine', () => {
  it('locks at most once: FUND only before locking, or as a retry while locking', () => {
    expect(can('negotiating', { type: 'FUND' })).toBe(true)
    expect(can('presigning', { type: 'FUND' })).toBe(true)
    expect(can('locking', { type: 'FUND' })).toBe(true)
    for (const phase of ['locked', 'claiming', 'refunding', 'settled', 'refunded', 'ended', 'missed'] as const) {
      expect(can(phase, { type: 'FUND' })).toBe(false)
    }
  })

  it('claims and refunds only after this wallet locked', () => {
    for (const event of [{ type: 'CLAIM' }, { type: 'REFUND' }, { type: 'REFUND_FEE' }] as const) {
      expect(can('negotiating', event)).toBe(false)
      expect(can('presigning', event)).toBe(false)
      expect(can('locking', event)).toBe(false)
      expect(can('locked', event)).toBe(true)
    }
  })

  it('ends without a lock only when declined or expired', () => {
    expect(can('negotiating', { type: 'DONE', outcome: 'declined' })).toBe(true)
    expect(can('presigning', { type: 'DONE', outcome: 'expired' })).toBe(true)
    expect(can('negotiating', { type: 'DONE', outcome: 'swapped' })).toBe(false)
    expect(can('negotiating', { type: 'DONE', outcome: 'refunded' })).toBe(false)
    expect(can('locked', { type: 'DONE', outcome: 'declined' })).toBe(false)
    expect(can('locked', { type: 'DONE', outcome: 'expired' })).toBe(false)
  })

  it('names each locked outcome honestly', () => {
    const end = (outcome: 'swapped' | 'refunded' | 'missed' | 'unsent') => {
      const actor = at('locked')
      actor.send({ type: 'DONE', outcome })
      return actor.getSnapshot()
    }
    expect(end('swapped').value).toBe('settled')
    expect(end('refunded').value).toBe('refunded')
    expect(end('missed').value).toBe('missed')
    expect(end('unsent').value).toBe('ended')
    expect(can('negotiating', { type: 'DONE', outcome: 'unsent' })).toBe(false)
    expect(end('swapped').status).toBe('done')
  })

  it('runs a whole swap: presign, fund, claim, settle', () => {
    const actor = at('negotiating')
    for (const event of [{ type: 'PRESIGN' }, { type: 'PRESIGN' }, { type: 'FUND' }, { type: 'FAIL', error: 'offline' }, { type: 'FUND' }, { type: 'OK' }, { type: 'CLAIM' }, { type: 'FAIL', error: 'mempool' }, { type: 'CLAIM' }, { type: 'OK' }] as const) {
      expect(actor.getSnapshot().can(event)).toBe(true)
      actor.send(event)
    }
    expect(actor.getSnapshot().value).toBe('locked')
    actor.send({ type: 'DONE', outcome: 'swapped' })
    expect(actor.getSnapshot().value).toBe('settled')
  })
})
