import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { fileUploadMachine, getFileUploadPhase } from '../machines/file-upload.js'

describe('fileUploadMachine', () => {
  it('tracks drag → accept → idle', () => {
    const actor = createActor(fileUploadMachine).start()
    expect(getFileUploadPhase(actor.getSnapshot().value)).toBe('idle')

    actor.send({ type: 'DRAG_OVER' })
    expect(getFileUploadPhase(actor.getSnapshot().value)).toBe('dragging')

    actor.send({ type: 'DROP_ACCEPT' })
    expect(getFileUploadPhase(actor.getSnapshot().value)).toBe('idle')
  })

  it('rejects then resets', () => {
    const actor = createActor(fileUploadMachine).start()
    actor.send({ type: 'DROP_REJECT' })
    expect(getFileUploadPhase(actor.getSnapshot().value)).toBe('rejected')

    actor.send({ type: 'RESET' })
    expect(getFileUploadPhase(actor.getSnapshot().value)).toBe('idle')
  })
})
