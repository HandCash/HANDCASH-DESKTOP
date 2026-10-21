import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import {
  DEVICE_PROGRESS,
  OPEN_SECRET_PROGRESS,
  PASSWORD_PROGRESS,
  unlockMachine,
} from './unlockMachine'

function start() {
  return createActor(unlockMachine).start()
}

const ALMOST_READY = { title: 'Almost ready', lede: 'Opening your wallet on this device.' }

describe('unlockForm chart', () => {
  it('a password shorter than the unlock floor never starts', () => {
    const actor = start()
    actor.send({ type: 'CHANGE', password: 'short' })
    actor.send({ type: 'SUBMIT' })
    expect(actor.getSnapshot().value).toBe('idle')
  })

  it('a password unlock opens with progress and ends in success', () => {
    const actor = start()
    actor.send({ type: 'CHANGE', password: 'correct horse' })
    actor.send({ type: 'SUBMIT' })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(actor.getSnapshot().context.progress).toEqual(PASSWORD_PROGRESS)
    actor.send({ type: 'PROGRESS', progress: ALMOST_READY })
    expect(actor.getSnapshot().context.progress).toEqual(ALMOST_READY)
    actor.send({ type: 'SUCCESS' })
    expect(actor.getSnapshot().value).toBe('success')
    expect(actor.getSnapshot().context.progress).toBeNull()
  })

  it('a wrong password fails with its reason and can be tried again at once', () => {
    const actor = start()
    actor.send({ type: 'CHANGE', password: 'wrong password' })
    actor.send({ type: 'SUBMIT' })
    actor.send({ type: 'FAIL', error: 'Wrong password' })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context).toMatchObject({
      error: 'Wrong password',
      reason: 'password-failed',
      progress: null,
    })
    actor.send({ type: 'SUBMIT' })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(actor.getSnapshot().context.error).toBeNull()
    expect(actor.getSnapshot().context.reason).toBeNull()
  })

  it('typing after a failure clears it', () => {
    const actor = start()
    actor.send({ type: 'CHANGE', password: 'wrong password' })
    actor.send({ type: 'SUBMIT' })
    actor.send({ type: 'FAIL', error: 'Wrong password' })
    actor.send({ type: 'CHANGE', password: 'wrong password!' })
    expect(actor.getSnapshot().value).toBe('idle')
    expect(actor.getSnapshot().context).toMatchObject({
      password: 'wrong password!',
      error: null,
      reason: null,
    })
  })

  it('Touch ID with no password typed is a chart state, not idle', () => {
    const actor = start()
    actor.send({ type: 'DEVICE', auto: true, visible: true })
    expect(actor.getSnapshot().value).toBe('awaitingDevice')
    expect(actor.getSnapshot().context).toMatchObject({
      factor: 'device',
      progress: DEVICE_PROGRESS,
      deviceTried: true,
    })
    actor.send({ type: 'UNLOCKED' })
    expect(actor.getSnapshot().value).toBe('opening')
    actor.send({ type: 'SUCCESS' })
    expect(actor.getSnapshot().value).toBe('success')
  })

  it('the lock screen waits for the window to be visible before prompting', () => {
    const actor = start()
    actor.send({ type: 'DEVICE', auto: true, visible: false })
    expect(actor.getSnapshot().value).toBe('waitingForVisible')
    expect(actor.getSnapshot().context.progress).toBeNull()
    expect(actor.getSnapshot().context.deviceTried).toBe(false)
    actor.send({ type: 'VISIBLE' })
    expect(actor.getSnapshot().value).toBe('awaitingDevice')
    expect(actor.getSnapshot().context.deviceTried).toBe(true)
  })

  it('while waiting for the window, the password and the fingerprint button still work', () => {
    const typed = start()
    typed.send({ type: 'DEVICE', auto: true, visible: false })
    typed.send({ type: 'CHANGE', password: 'correct horse' })
    typed.send({ type: 'SUBMIT' })
    expect(typed.getSnapshot().value).toBe('opening')
    expect(typed.getSnapshot().context.factor).toBe('password')
    typed.send({ type: 'VISIBLE' })
    expect(typed.getSnapshot().value).toBe('opening')

    const clicked = start()
    clicked.send({ type: 'DEVICE', auto: true, visible: false })
    clicked.send({ type: 'DEVICE', auto: true, visible: true })
    expect(clicked.getSnapshot().value).toBe('waitingForVisible')
    clicked.send({ type: 'DEVICE', auto: false, visible: true })
    expect(clicked.getSnapshot().value).toBe('awaitingDevice')
  })

  it('cancelling Touch ID fails quietly and the lock screen does not prompt again by itself', () => {
    const actor = start()
    actor.send({ type: 'DEVICE', auto: true, visible: true })
    actor.send({ type: 'FAIL', error: 'cancelled', cancelled: true })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context).toMatchObject({ error: '', reason: 'device-cancelled' })
    expect(actor.getSnapshot().can({ type: 'DEVICE', auto: true, visible: true })).toBe(false)
    actor.send({ type: 'DEVICE', auto: false, visible: true })
    expect(actor.getSnapshot().value).toBe('awaitingDevice')
  })

  it('a device failure keeps its message and reason', () => {
    const actor = start()
    actor.send({ type: 'DEVICE', auto: false, visible: true })
    actor.send({ type: 'FAIL', error: 'Touch ID is locked' })
    expect(actor.getSnapshot().context).toMatchObject({
      error: 'Touch ID is locked',
      reason: 'device-failed',
    })
  })

  it('a failure while opening after Touch ID is still a device failure', () => {
    const actor = start()
    actor.send({ type: 'DEVICE', auto: true, visible: true })
    actor.send({ type: 'UNLOCKED' })
    actor.send({ type: 'FAIL', error: 'balance unavailable' })
    expect(actor.getSnapshot().context.reason).toBe('device-failed')
  })

  it('the open secret opens with its own progress and fails with its reason', () => {
    const actor = start()
    actor.send({ type: 'OPEN_SECRET' })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(actor.getSnapshot().context).toMatchObject({
      factor: 'open-secret',
      progress: OPEN_SECRET_PROGRESS,
    })
    actor.send({ type: 'FAIL', error: 'vault unreadable' })
    expect(actor.getSnapshot().context.reason).toBe('open-secret-failed')
    expect(actor.getSnapshot().can({ type: 'OPEN_SECRET' })).toBe(true)
  })

  it('only one attempt runs at a time', () => {
    const actor = start()
    actor.send({ type: 'OPEN_SECRET' })
    expect(actor.getSnapshot().can({ type: 'OPEN_SECRET' })).toBe(false)
    expect(actor.getSnapshot().can({ type: 'DEVICE', auto: false, visible: true })).toBe(false)
    expect(actor.getSnapshot().can({ type: 'SUBMIT' })).toBe(false)

    const device = start()
    device.send({ type: 'DEVICE', auto: true, visible: true })
    expect(device.getSnapshot().can({ type: 'DEVICE', auto: false, visible: true })).toBe(false)
    expect(device.getSnapshot().can({ type: 'OPEN_SECRET' })).toBe(false)
  })

  it('create, restore and an approved sign-in open with the progress they bring', () => {
    const progress = { title: 'Signing in', lede: 'Installing the wallet your other device approved.' }
    const actor = start()
    actor.send({ type: 'START', factor: 'approved', progress })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(actor.getSnapshot().context).toMatchObject({ factor: 'approved', progress })
    actor.send({ type: 'FAIL', error: 'transfer expired' })
    expect(actor.getSnapshot().context.reason).toBe('setup-failed')
    actor.send({
      type: 'START',
      factor: 'restore',
      progress: { title: 'Restoring wallet', lede: 'Verifying your backup.' },
    })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(actor.getSnapshot().context.factor).toBe('restore')
  })
})
