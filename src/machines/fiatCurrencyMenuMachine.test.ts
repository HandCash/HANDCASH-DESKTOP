import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { fiatCurrencyMenuMachine } from './fiatCurrencyMenuMachine'

describe('fiat currency menu', () => {
  it('toggles open and closed', () => {
    const actor = createActor(fiatCurrencyMenuMachine).start()
    expect(actor.getSnapshot().value).toBe('closed')
    actor.send({ type: 'TOGGLE' })
    expect(actor.getSnapshot().value).toBe('open')
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().value).toBe('closed')
  })

  it('choosing a currency applies it and closes', () => {
    const applyChoice = vi.fn()
    const actor = createActor(fiatCurrencyMenuMachine.provide({ actions: { applyChoice } })).start()
    actor.send({ type: 'TOGGLE' })
    actor.send({ type: 'CHOOSE', code: 'eur' })
    expect(applyChoice).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().value).toBe('closed')
  })
})
