import type { AddedDevice } from '../../wallet/addedDevices'
import type { BackupFormat } from '../../wallet/backupFormats'
import { BRC140_DEFAULT_THRESHOLD, BRC140_DEFAULT_TOTAL } from '../../wallet/brc140Backup'
import type { SigninDevice } from '../../wallet/deviceSignin/api'
import type { RecoveryMethodStatus } from './recoveryMethods'

export type DeviceRemoval = { kind: 'relay'; deviceId: string } | { kind: 'added'; id: string }

export type SignedInDeviceRow = {
  key: string
  label: string
  status: RecoveryMethodStatus
  /** Null for this device. */
  remove: DeviceRemoval | null
}

export type RelayDevices = { onlineMs: number; devices: SigninDevice[] }

const day = (at: number) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })

/**
 * This device first, then the devices that reported to the sign-in relay, then
 * devices this one signed in that the relay doesn't list (no sign-in email).
 */
export function signedInDeviceRows(args: {
  thisDeviceId: string
  thisLabel: string
  relay: RelayDevices | null
  added: readonly AddedDevice[]
  now?: number
}): SignedInDeviceRow[] {
  const now = args.now ?? Date.now()
  const rows: SignedInDeviceRow[] = [
    { key: 'this', label: args.thisLabel, status: { text: 'This device', tone: 'ok' }, remove: null },
  ]
  const relayed = (args.relay?.devices ?? []).filter((device) => device.deviceId !== args.thisDeviceId)
  for (const device of relayed) {
    const active = device.lastSeen > now - (args.relay?.onlineMs ?? 0)
    rows.push({
      key: `relay:${device.deviceId}`,
      label: device.label,
      status: active ? { text: 'Active now', tone: 'ok' } : { text: `Last seen ${day(device.lastSeen)}`, tone: 'muted' },
      remove: { kind: 'relay', deviceId: device.deviceId },
    })
  }
  const listed = new Set(relayed.map((device) => device.label.toLowerCase()))
  for (const device of args.added) {
    if (listed.has(device.label.toLowerCase())) continue
    rows.push({
      key: `added:${device.id}`,
      label: device.label,
      status: { text: `Added ${day(device.addedAt)}`, tone: 'muted' },
      remove: { kind: 'added', id: device.id },
    })
  }
  return rows
}

export const SELF_BACKUPS: ReadonlyArray<{ format: BackupFormat; title: string }> = [
  { format: 'phrase', title: '24-word recovery phrase' },
  { format: 'split', title: `${BRC140_DEFAULT_TOTAL} key slices, any ${BRC140_DEFAULT_THRESHOLD} restore it` },
  { format: 'key', title: 'Emergency key' },
]

export function selfBackupStatus(
  format: BackupFormat,
  saved: ReadonlySet<BackupFormat>,
  hasPhrase: boolean,
): RecoveryMethodStatus {
  if (format === 'phrase' && !hasPhrase) return { text: 'This wallet has no phrase', tone: 'muted' }
  return saved.has(format) ? { text: 'Saved', tone: 'ok' } : { text: 'Not saved', tone: 'muted' }
}
