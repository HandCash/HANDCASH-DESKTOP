import { describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'

const compact = vi.hoisted(() => ({ value: false }))
vi.mock('../wallet/isCompactShell', () => ({ isCompactShell: () => compact.value }))
vi.mock('../wallet/navStore', () => ({ openTickerCoins: vi.fn() }))

import { openTickerCoins } from '../wallet/navStore'
import { getTickerCoin, setTickerCoin } from '../wallet/tickerCoin'
import { tickerMachine } from './tickerMachine'

describe('tickerMachine', () => {
  it('chooses in the side column and sets the picked coin', () => {
    compact.value = false
    setTickerCoin('bsv')
    const actor = createActor(tickerMachine).start()
    actor.send({ type: 'CHOOSE' })
    expect(actor.getSnapshot().value).toBe('choosing')
    actor.send({ type: 'PICK', coin: 'ltc' })
    expect(actor.getSnapshot().value).toBe('market')
    expect(getTickerCoin()).toBe('ltc')
  })

  it('opens the selector in the main section on a compact shell', () => {
    compact.value = true
    const actor = createActor(tickerMachine).start()
    actor.send({ type: 'CHOOSE' })
    expect(actor.getSnapshot().value).toBe('market')
    expect(openTickerCoins).toHaveBeenCalledOnce()
  })
})
