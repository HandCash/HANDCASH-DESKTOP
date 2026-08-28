import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import { deviceBackupMachine } from './deviceBackupMachine'

function actor() {
  const a = createActor(deviceBackupMachine)
  a.start()
  return a
}

describe('deviceBackupMachine', () => {
  it('starts on the device list with this device’s code hidden', () => {
    const a = actor()
    expect(a.getSnapshot().value).toBe('devices')
    expect(a.getSnapshot().context.showMyCode).toBe(false)
    a.send({ type: 'TOGGLE_MY_CODE' })
    expect(a.getSnapshot().context.showMyCode).toBe(true)
  })

  it('routes a scanned recovery copy straight to that device', () => {
    const a = actor()
    a.send({ type: 'SCAN' })
    expect(a.getSnapshot().value).toBe('scanning')
    a.send({ type: 'SCANNED', peerDeviceId: 'peer-1' })
    expect(a.getSnapshot().value).toEqual({ device: 'choosing' })
    expect(a.getSnapshot().context.peerDeviceId).toBe('peer-1')
  })

  it('returns to the list when a scan yields no device', () => {
    const a = actor()
    a.send({ type: 'SCAN' })
    a.send({ type: 'SCANNED' })
    expect(a.getSnapshot().value).toBe('devices')
  })

  it('seals one direction and shows the copy to hand over', () => {
    const a = actor()
    a.send({ type: 'OPEN_DEVICE', peerDeviceId: 'peer-1' })
    a.send({ type: 'PROTECT_LOCAL' })
    expect(a.getSnapshot().value).toEqual({ device: 'sealPrompt' })
    a.send({ type: 'SEAL' })
    a.send({ type: 'SEAL_OK' })
    expect(a.getSnapshot().value).toEqual({ device: 'sealed' })
  })

  it('keeps a failed seal on its own prompt with the reason', () => {
    const a = actor()
    a.send({ type: 'OPEN_DEVICE', peerDeviceId: 'peer-1' })
    a.send({ type: 'PROTECT_LOCAL' })
    a.send({ type: 'SEAL' })
    a.send({ type: 'FAIL', error: 'Incorrect password' })
    expect(a.getSnapshot().value).toEqual({ device: 'sealPrompt' })
    expect(a.getSnapshot().context.error).toBe('Incorrect password')
  })

  it('cannot reach the import prompt from the seal prompt without going back', () => {
    const a = actor()
    a.send({ type: 'OPEN_DEVICE', peerDeviceId: 'peer-1' })
    a.send({ type: 'PROTECT_LOCAL' })
    a.send({ type: 'PROTECT_PEER' })
    expect(a.getSnapshot().value).toEqual({ device: 'sealPrompt' })
    a.send({ type: 'BACK' })
    a.send({ type: 'PROTECT_PEER' })
    expect(a.getSnapshot().value).toEqual({ device: 'importPrompt' })
  })

  it('clears the selected device when returning to the list', () => {
    const a = actor()
    a.send({ type: 'OPEN_DEVICE', peerDeviceId: 'peer-1' })
    a.send({ type: 'BACK' })
    expect(a.getSnapshot().value).toBe('devices')
    expect(a.getSnapshot().context.peerDeviceId).toBeNull()
  })

  it('opens a stored copy only through the unseal step', () => {
    const a = actor()
    a.send({ type: 'OPEN_RECOVERY', peerDeviceId: 'peer-1' })
    expect(a.getSnapshot().value).toEqual({ recovery: 'locked' })
    a.send({ type: 'UNSEAL_OK' })
    expect(a.getSnapshot().value).toEqual({ recovery: 'locked' })
    a.send({ type: 'UNSEAL' })
    a.send({ type: 'UNSEAL_OK' })
    expect(a.getSnapshot().value).toEqual({ recovery: 'opened' })
  })

  it('returns a cancelled import scan to the store-theirs step', () => {
    const a = actor()
    a.send({ type: 'OPEN_DEVICE', peerDeviceId: 'peer-1' })
    a.send({ type: 'PROTECT_PEER' })
    a.send({ type: 'SCAN' })
    expect(a.getSnapshot().value).toBe('scanning')
    expect(a.getSnapshot().context.scanOrigin).toBe('import')
    a.send({ type: 'SCAN_CANCEL' })
    expect(a.getSnapshot().value).toEqual({ device: 'importPrompt' })
    expect(a.getSnapshot().context.peerDeviceId).toBe('peer-1')
  })

  it('returns a cancelled list scan to the device list', () => {
    const a = actor()
    a.send({ type: 'SCAN' })
    a.send({ type: 'SCAN_CANCEL' })
    expect(a.getSnapshot().value).toBe('devices')
  })
})
