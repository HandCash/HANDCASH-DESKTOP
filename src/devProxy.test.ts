import { describe, expect, it } from 'vitest'
import { Agent } from 'node:https'
import config from '../vite.config'

describe('cloud development proxy', () => {
  it('shares a persistent dual-stack agent with a slower address fallback', () => {
    const proxy = config.server!.proxy!
    const api = proxy['/v1']
    const discovery = proxy['/.well-known']
    if (typeof api === 'string' || typeof discovery === 'string') throw new Error('Expected proxy options')
    expect(api.agent).toBeInstanceOf(Agent)
    expect(discovery.agent).toBe(api.agent)
    expect((api.agent as Agent).options).toMatchObject({
      keepAlive: true,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 2000,
    })
    expect(api.target).toBe('https://brc-cloud.bcryderman.workers.dev')
  })
})
