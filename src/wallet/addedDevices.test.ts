import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listAddedDevices, noteDeviceRemoved, recordAddedDevice, subscribeAddedDevices } from './addedDevices'

const store = new Map<string, string>()
const events = vi.hoisted(() => [] as Array<{ method: string; note: string }>)
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => void store.set(key, value),
}))
vi.mock('./vaultLocalKeys', () => ({ vaultLocalKey: (key: string) => `vault-a:${key}` }))
vi.mock('./appActivity', () => ({
  WALLET_ACTIVITY_ORIGIN: 'wallet',
  recordWalletEvent: (event: { method: string; note: string }) => void events.push(event),
}))

beforeEach(() => {
  store.clear()
  events.length = 0
})

const labels = () => listAddedDevices().map((device) => device.label)

describe('devices this device signed in', () => {
  it('keeps the newest first, once per id', () => {
    recordAddedDevice({ id: 'a', label: 'iPhone', via: 'local' }, 1)
    recordAddedDevice({ id: 'b', label: 'Work PC', via: 'relay' }, 2)
    recordAddedDevice({ id: 'a', label: 'iPhone', via: 'local' }, 3)
    expect(listAddedDevices()).toEqual([
      { id: 'a', label: 'iPhone', via: 'local', addedAt: 3 },
      { id: 'b', label: 'Work PC', via: 'relay', addedAt: 2 },
    ])
  })

  it('logs an added device to Activity', async () => {
    recordAddedDevice({ id: 'b', label: 'Work PC', via: 'relay' })
    await vi.waitFor(
      () => expect(events).toContainEqual({ origin: 'wallet', method: 'device-added', note: 'Signed in on Work PC' }),
      { timeout: 5000 },
    )
  })

  it('removes an added device by its id', () => {
    recordAddedDevice({ id: 'a', label: 'iPhone', via: 'local' })
    recordAddedDevice({ id: 'b', label: 'Work PC', via: 'relay' })
    noteDeviceRemoved('iPhone', 'a')
    expect(labels()).toEqual(['Work PC'])
  })

  it('removing a relay device drops the added entry under its label, so it does not come back', () => {
    recordAddedDevice({ id: 'a', label: 'iPhone', via: 'relay' })
    recordAddedDevice({ id: 'b', label: 'Work PC', via: 'relay' })
    const changed = vi.fn()
    const stop = subscribeAddedDevices(changed)
    noteDeviceRemoved('iphone')
    stop()
    expect(labels()).toEqual(['Work PC'])
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('logs a removal to Activity even when no added entry matches', async () => {
    noteDeviceRemoved('Old Mac')
    expect(store.size).toBe(0)
    await vi.waitFor(
      () =>
        expect(events).toContainEqual({ origin: 'wallet', method: 'device-removed', note: 'Removed Old Mac from your devices' }),
      { timeout: 5000 },
    )
  })
})
