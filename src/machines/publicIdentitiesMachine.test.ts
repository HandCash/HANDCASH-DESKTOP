import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { publicIdentitiesMachine } from './publicIdentitiesMachine'
describe('public identity drafts', () => {
  it('clears public drafts on close and keeps private signing keys out of chart context', () => {
    const actor = createActor(publicIdentitiesMachine).start()
    actor.send({ type: 'IMPORT_KEY' })
    actor.send({ type: 'FIELD', field: 'displayName', value: 'Studio' })
    expect(actor.getSnapshot().matches('importing')).toBe(true)
    expect(Object.keys(actor.getSnapshot().context)).toEqual([
      'identityKey',
      'fields',
    ])
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().context.fields.displayName).toBe('')
    actor.send({
      type: 'EDIT',
      identityKey: 'pubkey',
      fields: {
        displayName: 'Studio',
        icon: 'https://example.test/icon',
        description: '',
      },
    })
    expect(actor.getSnapshot().matches('editing')).toBe(true)
    actor.send({ type: 'CLOSE' })
    actor.send({ type: 'CREATE' })
    expect(actor.getSnapshot().context.identityKey).toBeNull()
    actor.stop()
  })
})
