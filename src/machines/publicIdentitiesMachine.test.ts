import { createActor, waitFor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import { publicIdentitiesMachine, type IdentityPublishPorts } from './publicIdentitiesMachine'
import type { IdentityPublishPlan } from '../wallet/identityPublish'

const image = { contentType: 'image/webp', bytes: Uint8Array.from([1, 2, 3]) }

const plan = (kind: IdentityPublishPlan['kind'] = 'publish'): IdentityPublishPlan => ({
  kind,
  identityKey: 'pubkey',
  bapId: 'bap',
  signer: 'wallet',
  name: 'Studio',
  description: '',
  image: { status: 'new', bytes: 3, contentType: 'image/webp' },
  signingKey: { seq: 1, publicKey: '02'.padEnd(66, 'a') },
  retiredKey: null,
  transactions: [],
  feeSats: 50,
  maxFeeSats: 320,
  digest: 'd'.repeat(64),
})

function ports(overrides: Partial<IdentityPublishPorts> = {}): IdentityPublishPorts {
  return {
    quote: vi.fn(async (request) => plan(request.kind === 'rotate' ? 'rotate' : 'publish')),
    publish: vi.fn(async () => undefined),
    ...overrides,
  }
}

const start = (p = ports()) => createActor(publicIdentitiesMachine, { input: { ports: p } }).start()

const composeReady = (actor: ReturnType<typeof start>) =>
  actor.send({ type: 'COMPOSE', identityKey: 'pubkey', fields: { name: 'Studio', description: '' }, image })

describe('public identity drafts', () => {
  it('keeps private signing keys out of chart context and clears drafts on close', () => {
    const actor = start()
    actor.send({ type: 'IMPORT_KEY' })
    expect(actor.getSnapshot().matches('importing')).toBe(true)
    expect(Object.keys(actor.getSnapshot().context).sort()).toEqual(
      ['error', 'fields', 'identityKey', 'image', 'plan', 'ports', 'request'],
    )
    actor.send({ type: 'FIELD', field: 'name', value: 'ignored' })
    expect(actor.getSnapshot().context.fields.name).toBe('')
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().matches('browsing')).toBe(true)
    actor.stop()
  })

  it('composes a new version from the published one, and an image only enters by event', () => {
    const actor = start()
    actor.send({
      type: 'COMPOSE',
      identityKey: 'pubkey',
      fields: { name: 'Studio', description: 'Awards' },
      image,
    })
    expect(actor.getSnapshot().matches('composing')).toBe(true)
    actor.send({ type: 'FIELD', field: 'name', value: 'Studio 2' })
    const next = { contentType: 'image/png', bytes: Uint8Array.from([9]) }
    actor.send({ type: 'IMAGE', image: next })
    expect(actor.getSnapshot().context).toMatchObject({ fields: { name: 'Studio 2' }, image: next })
    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().context).toMatchObject({
      identityKey: null,
      fields: { name: '', description: '' },
      image: null,
    })
    actor.send({ type: 'COMPOSE', identityKey: 'fresh' })
    expect(actor.getSnapshot().context.image).toBeNull()
    actor.stop()
  })
})

describe('identity publish approval', () => {
  it('signs nothing until the quoted plan is approved, and publishes exactly that plan', async () => {
    const p = ports()
    const actor = start(p)
    composeReady(actor)
    actor.send({ type: 'APPROVE' })
    expect(actor.getSnapshot().matches('composing')).toBe(true)
    actor.send({ type: 'REVIEW' })
    await waitFor(actor, (s) => s.matches('reviewing'))
    expect(p.publish).not.toHaveBeenCalled()
    actor.send({ type: 'FIELD', field: 'name', value: 'Swapped after review' })
    expect(actor.getSnapshot().context.request).toMatchObject({ kind: 'profile', fields: { name: 'Studio' } })
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, (s) => s.matches('browsing'))
    expect(p.publish).toHaveBeenCalledWith(
      { kind: 'profile', identityKey: 'pubkey', fields: { name: 'Studio', description: '' }, image },
      plan(),
    )
    expect(actor.getSnapshot().context).toMatchObject({ identityKey: null, plan: null, request: null })
    actor.stop()
  })

  it('refuses REVIEW without an image and a name', () => {
    const p = ports()
    const actor = start(p)
    actor.send({ type: 'COMPOSE', identityKey: 'pubkey' })
    actor.send({ type: 'REVIEW' })
    expect(actor.getSnapshot().matches('composing')).toBe(true)
    expect(p.quote).not.toHaveBeenCalled()
    actor.stop()
  })

  it('cancelling a review keeps the draft; cancelling a rotation returns to the list', async () => {
    const p = ports()
    const actor = start(p)
    composeReady(actor)
    actor.send({ type: 'REVIEW' })
    await waitFor(actor, (s) => s.matches('reviewing'))
    actor.send({ type: 'CANCEL' })
    expect(actor.getSnapshot().matches('composing')).toBe(true)
    expect(actor.getSnapshot().context).toMatchObject({ image, plan: null, request: null })
    actor.send({ type: 'CLOSE' })
    actor.send({ type: 'ROTATE', identityKey: 'pubkey' })
    await waitFor(actor, (s) => s.matches('reviewing'))
    expect(actor.getSnapshot().context.plan?.kind).toBe('rotate')
    actor.send({ type: 'CANCEL' })
    expect(actor.getSnapshot().matches('browsing')).toBe(true)
    expect(p.publish).not.toHaveBeenCalled()
    actor.stop()
  })

  it('a refused publish names its reason and returns to the draft', async () => {
    const actor = start(
      ports({
        publish: vi.fn(async () => {
          throw new Error('This identity changed since you reviewed it. Review the publish again.')
        }),
      }),
    )
    composeReady(actor)
    actor.send({ type: 'REVIEW' })
    await waitFor(actor, (s) => s.matches('reviewing'))
    actor.send({ type: 'APPROVE' })
    await waitFor(actor, (s) => s.matches('refused'))
    expect(actor.getSnapshot().context).toMatchObject({ plan: null, error: expect.stringMatching(/changed since/) })
    expect(actor.getSnapshot().hasTag('review')).toBe(true)
    actor.send({ type: 'DISMISS' })
    expect(actor.getSnapshot().matches('composing')).toBe(true)
    expect(actor.getSnapshot().context.error).toBeNull()
    actor.stop()
  })
})
