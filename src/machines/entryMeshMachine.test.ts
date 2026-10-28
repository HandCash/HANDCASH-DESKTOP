import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { DEPTH_LAYER_COUNT } from '../components/auth/entryMeshMotion'
import { ENTRY_MESH_LAYER_COUNT, entryMeshMachine } from './entryMeshMachine'

describe('entryMeshMachine', () => {
  it('owns all parallax layers in one chart context', () => {
    const actor = createActor(entryMeshMachine).start()
    expect(actor.getSnapshot().context.layerCount).toBe(ENTRY_MESH_LAYER_COUNT)
    expect(ENTRY_MESH_LAYER_COUNT).toBe(DEPTH_LAYER_COUNT)
    expect(ENTRY_MESH_LAYER_COUNT).toBeGreaterThanOrEqual(18)
    expect(ENTRY_MESH_LAYER_COUNT).toBeLessThanOrEqual(36)
    actor.stop()
  })

  it('boots into static when reduced motion wins', () => {
    const actor = createActor(entryMeshMachine).start()
    expect(actor.getSnapshot().value).toBe('booting')
    actor.send({ type: 'BOOT_STATIC' })
    expect(actor.getSnapshot().value).toBe('static')
    actor.send({ type: 'SHOW' })
    expect(actor.getSnapshot().value).toBe('static')
    actor.stop()
  })

  it('plays, pauses off-screen, and resumes', () => {
    const actor = createActor(entryMeshMachine).start()
    actor.send({ type: 'BOOT_PLAY' })
    expect(actor.getSnapshot().value).toBe('playing')
    actor.send({ type: 'HIDE' })
    expect(actor.getSnapshot().value).toBe('paused')
    actor.send({ type: 'SHOW' })
    expect(actor.getSnapshot().value).toBe('playing')
    actor.send({ type: 'REDUCE' })
    expect(actor.getSnapshot().value).toBe('static')
    actor.stop()
  })
})
