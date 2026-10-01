import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { publicIdentitiesMachine } from './publicIdentitiesMachine'

const image = { contentType: 'image/webp', bytes: Uint8Array.from([1, 2, 3]) }

describe('public identity drafts', () => {
  it('keeps private signing keys out of chart context and clears drafts on close', () => {
    const actor = createActor(publicIdentitiesMachine).start()
    actor.send({ type: 'IMPORT_KEY' })
    expect(actor.getSnapshot().matches('importing')).toBe(true)
    expect(Object.keys(actor.getSnapshot().context)).toEqual(['identityKey', 'fields', 'image'])
    actor.send({ type: 'FIELD', field: 'name', value: 'ignored' })
    expect(actor.getSnapshot().context.fields.name).toBe('')
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().matches('browsing')).toBe(true)
    actor.stop()
  })

  it('composes a new version from the published one, and an image only enters by event', () => {
    const actor = createActor(publicIdentitiesMachine).start()
    actor.send({
      type: 'COMPOSE',
      identityKey: 'pubkey',
      fields: { name: 'Studio', description: 'Awards' },
      image,
    })
    expect(actor.getSnapshot().matches('composing')).toBe(true)
    expect(actor.getSnapshot().context).toMatchObject({
      identityKey: 'pubkey',
      fields: { name: 'Studio', description: 'Awards' },
      image,
    })
    actor.send({ type: 'FIELD', field: 'name', value: 'Studio 2' })
    const next = { contentType: 'image/png', bytes: Uint8Array.from([9]) }
    actor.send({ type: 'IMAGE', image: next })
    expect(actor.getSnapshot().context).toMatchObject({
      fields: { name: 'Studio 2' },
      image: next,
    })
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().context).toEqual({
      identityKey: null,
      fields: { name: '', description: '' },
      image: null,
    })
    actor.send({ type: 'COMPOSE', identityKey: 'fresh' })
    expect(actor.getSnapshot().context.image).toBeNull()
    actor.stop()
  })
})
