import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { authenticityMachine } from './authenticityMachine'
import { canAcceptVerdict, isProvenTier } from './provenCache'

describe('authenticityMachine', () => {
  it('hydrates a proven verdict into proven', () => {
    const actor = createActor(authenticityMachine).start()
    actor.send({
      type: 'HYDRATE',
      verdict: { tier: 'brc150', origin: 'aa_0', verifiedAt: 1 },
    })
    expect(actor.getSnapshot().value).toBe('proven')
    expect(actor.getSnapshot().context.tier).toBe('brc150')
    actor.stop()
  })

  it('refuses to downgrade proven → unproven', () => {
    const actor = createActor(authenticityMachine).start()
    actor.send({
      type: 'PROVEN',
      tier: 'brc150',
      origin: 'aa_0',
    })
    actor.send({ type: 'UNPROVEN', reason: 'transient' })
    expect(actor.getSnapshot().value).toBe('proven')
    expect(actor.getSnapshot().context.tier).toBe('brc150')
    actor.stop()
  })

  it('allows RETRY from unproven into verifying', () => {
    const actor = createActor(authenticityMachine).start()
    actor.send({ type: 'UNPROVEN', reason: 'miss' })
    expect(actor.getSnapshot().value).toBe('unproven')
    actor.send({ type: 'RETRY' })
    expect(actor.getSnapshot().value).toBe('verifying')
    actor.stop()
  })

  it('canAcceptVerdict encodes monotonic policy', () => {
    expect(isProvenTier('brc150')).toBe(true)
    expect(canAcceptVerdict('brc150', 'unproven')).toBe(false)
    expect(canAcceptVerdict('brc150', 'brc150')).toBe(true)
    expect(canAcceptVerdict('unproven', 'brc150')).toBe(true)
  })
})
