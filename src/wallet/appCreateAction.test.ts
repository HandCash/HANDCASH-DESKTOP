import { describe, expect, it } from 'vitest'

import { withImmediateAppBroadcast } from './appCreateAction'

describe('withImmediateAppBroadcast', () => {
  it('forces acceptDelayedBroadcast so apps do not wait for seen-on-chain', () => {
    const next = withImmediateAppBroadcast({
      description: 'Plinko bet',
      outputs: [{ satoshis: 1299000 }],
      options: { acceptDelayedBroadcast: false, signAndProcess: true },
    }) as { options: { acceptDelayedBroadcast: boolean; signAndProcess: boolean } }
    expect(next.options.acceptDelayedBroadcast).toBe(true)
    expect(next.options.signAndProcess).toBe(true)
  })

  it('adds options when the app omitted them', () => {
    const next = withImmediateAppBroadcast({ description: 'bet' }) as {
      options: { acceptDelayedBroadcast: boolean }
    }
    expect(next.options.acceptDelayedBroadcast).toBe(true)
  })

  it('leaves non-objects alone', () => {
    expect(withImmediateAppBroadcast(null)).toBeNull()
    expect(withImmediateAppBroadcast('x')).toBe('x')
  })
})
