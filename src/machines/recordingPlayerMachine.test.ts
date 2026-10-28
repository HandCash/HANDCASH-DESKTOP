import { describe, expect, it } from 'vitest'
import { createActor, waitFor } from 'xstate'
import { recordingPlayerMachine, type RecordingPlayerPorts } from './recordingPlayerMachine'

const ID = 'a'.repeat(32)
const OPENED = { meta: null, blob: new Blob([new Uint8Array([1])]), complete: false }

function run(ports: Partial<RecordingPlayerPorts>) {
  const actor = createActor(recordingPlayerMachine, {
    input: { id: ID, ports: { open: async () => OPENED, remove: async () => undefined, ...ports } },
  })
  actor.start()
  return actor
}

describe('recordingPlayerMachine', () => {
  it('opens a recording, then deletes it', async () => {
    const removed: string[] = []
    const actor = run({ remove: async (id) => void removed.push(id) })
    expect(actor.getSnapshot().value).toBe('opening')
    await waitFor(actor, (s) => s.matches('ready'))
    expect(actor.getSnapshot().context.opened).toBe(OPENED)
    actor.send({ type: 'DELETE' })
    await waitFor(actor, (s) => s.matches('deleted'))
    expect(removed).toEqual([ID])
    expect(actor.getSnapshot().context.opened).toBeNull()
  })

  it('says when a recording is not on this device, or could not be opened or deleted', async () => {
    await waitFor(run({ open: async () => null }), (s) => s.matches('gone'))
    await waitFor(run({ open: () => Promise.reject(new Error('locked')) }), (s) => s.matches('failed'))
    const actor = run({ remove: () => Promise.reject(new Error('busy')) })
    await waitFor(actor, (s) => s.matches('ready'))
    actor.send({ type: 'DELETE' })
    await waitFor(actor, (s) => s.matches('failed'))
  })
})
