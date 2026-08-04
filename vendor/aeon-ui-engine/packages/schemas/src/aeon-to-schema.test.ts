import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { asyncMachine, buttonLifecycleMachine } from '@aeon-ui/primitives'
import { aeonSnapshotSchema, aeonToPrompt, aeonToSchema } from './aeon-to-schema.js'
import { createAgentEventBridge } from './agent-bridge.js'

describe('aeonToSchema', () => {
  it('builds a hierarchical state tree for async', () => {
    const schema = aeonToSchema(asyncMachine)
    expect(schema.id).toBe('async')
    expect(schema.events).toEqual(expect.arrayContaining(['FETCH', 'RESOLVE', 'REJECT', 'RESET']))
    expect(schema.tree.children.map((c) => c.key)).toEqual(
      expect.arrayContaining(['idle', 'loading', 'success', 'failure', 'empty']),
    )
    const idle = schema.tree.children.find((c) => c.key === 'idle')
    expect(idle?.events).toEqual(expect.arrayContaining(['FETCH', 'RESET']))
  })

  it('omits internal xstate.* events from the public tree', () => {
    const schema = aeonToSchema(asyncMachine)
    expect(schema.events.every((e) => !e.startsWith('xstate.'))).toBe(true)
  })

  it('lists only valid events for the live snapshot', () => {
    const actor = createActor(asyncMachine)
    actor.start()
    const live = aeonSnapshotSchema(asyncMachine, actor.getSnapshot())
    expect(live.value).toBe('idle')
    expect(live.validEvents).toEqual(expect.arrayContaining(['FETCH', 'RESET']))
    expect(live.validEvents).not.toContain('RESOLVE')
    actor.stop()
  })

  it('produces a prompt with JSON tree', () => {
    const prompt = aeonToPrompt(buttonLifecycleMachine)
    expect(prompt).toContain('buttonLifecycle')
    expect(prompt).toContain('```json')
    expect(prompt).toContain('PRESS')
  })
})

describe('createAgentEventBridge', () => {
  it('maps AGENT_STREAM_START → FETCH and blocks illegal events', () => {
    const actor = createActor(asyncMachine)
    actor.start()
    const illegal: string[] = []
    const bridge = createAgentEventBridge(actor, {
      map: {
        AGENT_STREAM_START: 'FETCH',
        AGENT_STREAM_ERROR: (e) =>
          e.type === 'AGENT_STREAM_ERROR' ? { type: 'REJECT', error: e.error } : null,
      },
      onIllegal: (ev, reason) => illegal.push(`${ev.type}:${reason}`),
    })

    expect(bridge.push({ type: 'AGENT_STREAM_START' })).toBe(true)
    expect(actor.getSnapshot().value).toBe('loading')

    // RESOLVE is valid in loading — but AGENT_STREAM_ERROR maps to REJECT which is also valid
    expect(bridge.push({ type: 'AGENT_STREAM_ERROR', error: 'boom' })).toBe(true)
    expect(actor.getSnapshot().value).toBe('failure')

    // FETCH is valid from failure
    expect(bridge.push({ type: 'AGENT_STREAM_START' })).toBe(true)
    expect(actor.getSnapshot().value).toBe('loading')

    actor.stop()
    expect(illegal).toEqual([])
  })
})
