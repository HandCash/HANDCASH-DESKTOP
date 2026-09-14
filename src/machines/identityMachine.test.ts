import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { identityMachine } from './identityMachine'

function actor() {
  const a = createActor(identityMachine)
  a.start()
  return a
}

describe('identityMachine', () => {
  it('starts browsing, where root and BRC-169 stay visible and Sigma is not being created', () => {
    const a = actor()
    expect(a.getSnapshot().value).toBe('browsing')
    expect(a.getSnapshot().context.personaId).toBeNull()
  })

  it('will not confirm a persona that has no id', () => {
    const a = actor()
    a.send({ type: 'COMPOSE' })
    a.send({ type: 'EDIT', name: '!!!' })
    a.send({ type: 'REVIEW' })
    expect(a.getSnapshot().value).toBe('composing')
  })

  it('confirms a create before publishing, and failure returns to the draft', () => {
    const a = actor()
    a.send({ type: 'COMPOSE' })
    a.send({ type: 'EDIT', name: 'Studio', about: 'Paints' })
    a.send({ type: 'REVIEW' })
    expect(a.getSnapshot().value).toBe('confirming')
    a.send({ type: 'CONFIRM' })
    expect(a.getSnapshot().value).toBe('publishing')
    a.send({ type: 'FAIL', error: 'short of sats' })
    expect(a.getSnapshot().value).toBe('failure')
    expect(a.getSnapshot().context.error).toBe('short of sats')
    a.send({ type: 'BACK' })
    expect(a.getSnapshot().value).toBe('composing')
    expect(a.getSnapshot().context.name).toBe('Studio')
  })

  it('revokes from a named persona and does not treat that as a create', () => {
    const a = actor()
    a.send({ type: 'REVOKE', personaId: 'studio' })
    expect(a.getSnapshot().value).toBe('revokeConfirm')
    expect(a.getSnapshot().context.personaId).toBe('studio')
    a.send({ type: 'CONFIRM' })
    expect(a.getSnapshot().value).toBe('revoking')
    a.send({ type: 'FAIL', error: 'control missing' })
    a.send({ type: 'BACK' })
    expect(a.getSnapshot().value).toBe('revokeConfirm')
    expect(a.getSnapshot().context.personaId).toBe('studio')
  })
})