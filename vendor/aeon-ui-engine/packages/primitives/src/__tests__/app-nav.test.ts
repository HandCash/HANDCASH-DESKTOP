import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import {
  appNavChild,
  appNavMachine,
  appNavStateAttr,
} from '../machines/app-nav.js'

describe('appNavMachine', () => {
  it('switches section and clears stack', () => {
    const actor = createActor(appNavMachine, { input: { section: 'home' } }).start()
    actor.send({ type: 'PUSH', child: { id: '1', type: 'detail' } })
    expect(appNavChild(actor.getSnapshot().context)?.id).toBe('1')
    actor.send({ type: 'SET_SECTION', section: 'settings' })
    const ctx = actor.getSnapshot().context
    expect(ctx.section).toBe('settings')
    expect(ctx.stack).toEqual([])
  })

  it('push / pop / popTo maintain stack', () => {
    const actor = createActor(appNavMachine, { input: { section: 'apps' } }).start()
    actor.send({ type: 'PUSH', child: { id: 'a', type: 'app' } })
    actor.send({ type: 'PUSH', child: { id: 'p', type: 'permission' } })
    expect(appNavStateAttr(actor.getSnapshot().context)).toBe('apps/permission')
    actor.send({ type: 'POP_TO', id: 'a' })
    expect(appNavChild(actor.getSnapshot().context)?.id).toBe('a')
    actor.send({ type: 'POP' })
    expect(appNavChild(actor.getSnapshot().context)).toBeNull()
  })
})
