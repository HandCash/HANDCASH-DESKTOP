import { createActor } from 'xstate'
import { describe, expect, it } from 'vitest'
import { qrScannerMachine } from './qrScannerMachine'

describe('qrScannerMachine', () => {
  it('shows loading until the camera is actually playing', () => {
    const actor = createActor(qrScannerMachine).start()
    expect(actor.getSnapshot().value).toBe('loading')
    actor.send({ type: 'CAMERA_READY' })
    expect(actor.getSnapshot().value).toBe('ready')
  })

  it('projects camera failures without exposing the video', () => {
    const actor = createActor(qrScannerMachine).start()
    actor.send({ type: 'FAIL', error: 'Camera denied' })
    expect(actor.getSnapshot().value).toBe('error')
    expect(actor.getSnapshot().context.error).toBe('Camera denied')
  })

  it('finishes once a QR is handled', () => {
    const actor = createActor(qrScannerMachine).start()
    actor.send({ type: 'CAMERA_READY' })
    actor.send({ type: 'SCANNED' })
    expect(actor.getSnapshot().status).toBe('done')
  })

  it('restarts camera acquisition after app resume', () => {
    const actor = createActor(qrScannerMachine).start()
    actor.send({ type: 'CAMERA_READY' })
    actor.send({ type: 'PAUSE' })
    expect(actor.getSnapshot().value).toBe('paused')
    actor.send({ type: 'RESUME' })
    expect(actor.getSnapshot().value).toBe('loading')
    expect(actor.getSnapshot().context.session).toBe(1)
  })
})
