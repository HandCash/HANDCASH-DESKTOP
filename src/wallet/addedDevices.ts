/**
 * Devices this device signed in to the wallet, by scanned code or relayed
 * approval. Kept so the devices list and Activity still show them after a
 * restart; the relay forgets a finished request after an hour.
 */
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableSetItem } from './durableStorage'
import { vaultLocalKey } from './vaultLocalKeys'

export type AddedDevice = {
  /** The new device's one-time sign-in key (scan) or the relay binding. */
  id: string
  label: string
  via: 'local' | 'relay'
  addedAt: number
}

const KEY = storageRegistry.addedDevices.key
const MAX = 50
const listeners = new Set<() => void>()

function isAddedDevice(value: unknown): value is AddedDevice {
  const v = value as AddedDevice
  return (
    typeof v?.id === 'string' &&
    typeof v.label === 'string' &&
    (v.via === 'local' || v.via === 'relay') &&
    Number.isFinite(v.addedAt)
  )
}

export function listAddedDevices(): AddedDevice[] {
  try {
    const parsed = JSON.parse(durableGetItem(vaultLocalKey(KEY)) || '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter(isAddedDevice) : []
  } catch {
    return []
  }
}

function save(list: AddedDevice[]): void {
  durableSetItem(vaultLocalKey(KEY), JSON.stringify(list.slice(0, MAX)))
  for (const listener of listeners) listener()
}

function logActivity(method: 'device-added' | 'device-removed', note: string): void {
  void import('./appActivity').then(({ recordWalletEvent, WALLET_ACTIVITY_ORIGIN }) => {
    recordWalletEvent({ origin: WALLET_ACTIVITY_ORIGIN, method, note })
  })
}

export function recordAddedDevice(device: Omit<AddedDevice, 'addedAt'>, now = Date.now()): void {
  const rest = listAddedDevices().filter((entry) => entry.id !== device.id)
  save([{ ...device, addedAt: now }, ...rest])
  logActivity('device-added', `Signed in on ${device.label}`)
}

/**
 * Takes a device off the list: the added device with `id`, or with no id (a
 * relay device) every added entry under its label, which the relay row hid.
 */
export function noteDeviceRemoved(label: string, id?: string): void {
  const name = label.toLowerCase()
  const removed = (entry: AddedDevice) => (id ? entry.id === id : entry.label.toLowerCase() === name)
  const list = listAddedDevices()
  if (list.some(removed)) save(list.filter((entry) => !removed(entry)))
  logActivity('device-removed', `Removed ${label} from your devices`)
}

export function subscribeAddedDevices(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
