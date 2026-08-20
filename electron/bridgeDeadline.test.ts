import { describe, expect, it } from 'vitest'
import {
  BRIDGE_DEADLINE_MS,
  SPEND_DEADLINE_MS,
  bridgeDeadlineCode,
  bridgeDeadlineMessage,
  bridgeDeadlineMs,
  isSpendMethodPath,
} from './bridgeDeadline.js'

describe('bridge deadlines', () => {
  it('gives a spend longer than a read', () => {
    expect(bridgeDeadlineMs('/createAction')).toBe(SPEND_DEADLINE_MS)
    expect(bridgeDeadlineMs('/signAction')).toBe(SPEND_DEADLINE_MS)
    expect(bridgeDeadlineMs('/internalizeAction')).toBe(SPEND_DEADLINE_MS)
    expect(bridgeDeadlineMs('/listOutputs')).toBe(BRIDGE_DEADLINE_MS)
    expect(SPEND_DEADLINE_MS).toBeGreaterThan(BRIDGE_DEADLINE_MS)
  })

  it('tells a caller a spend may still land, but a read did not run', () => {
    expect(bridgeDeadlineCode('/createAction')).toBe('WALLET_BRIDGE_PENDING')
    expect(bridgeDeadlineCode('/listOutputs')).toBe('WALLET_BRIDGE_TIMEOUT')
  })

  it('matches the method regardless of slashes or case', () => {
    expect(isSpendMethodPath('/createAction')).toBe(true)
    expect(isSpendMethodPath('createaction')).toBe(true)
    expect(isSpendMethodPath('/createAction/')).toBe(true)
    expect(isSpendMethodPath('/getPublicKey')).toBe(false)
  })

  it('never describes an in-flight spend as no reply', () => {
    const spend = bridgeDeadlineMessage('POST', '/createAction')
    expect(spend).toContain('WALLET_BRIDGE_PENDING')
    expect(spend).toContain('may still complete')
    expect(spend).not.toContain('no renderer reply')

    const read = bridgeDeadlineMessage('POST', '/listOutputs')
    expect(read).toContain('WALLET_BRIDGE_TIMEOUT')
    expect(read).toContain('no renderer reply')
  })
})
