/**
 * The microphones and cameras a call may use, and the constraints that open
 * them. Device ids are per origin and stable across launches, so the user's
 * choice is remembered by id and falls back to the system default when that
 * device is gone.
 */

export type CallDeviceKind = 'audioinput' | 'videoinput'

export type CallDevice = { id: string; kind: CallDeviceKind; label: string }

type DeviceSource = Pick<MediaDevices, 'enumerateDevices'> & Partial<Pick<MediaDevices, 'addEventListener' | 'removeEventListener'>>

function source(): DeviceSource | undefined {
  return typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
}

/** Microphones and cameras, labelled even before permission (when browsers hide labels). */
export async function listCallDevices(from: DeviceSource | undefined = source()): Promise<CallDevice[]> {
  if (!from) return []
  const all = await from.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  const seen = { audioinput: 0, videoinput: 0 }
  const out: CallDevice[] = []
  for (const d of all) {
    if (d.kind !== 'audioinput' && d.kind !== 'videoinput') continue
    // Chromium lists the default and communications aliases next to the real devices.
    if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) continue
    seen[d.kind] += 1
    const fallback = d.kind === 'audioinput' ? `Microphone ${seen[d.kind]}` : `Camera ${seen[d.kind]}`
    out.push({ id: d.deviceId, kind: d.kind, label: d.label.trim() || fallback })
  }
  return out
}

export function subscribeDeviceChanges(listener: () => void, from: DeviceSource | undefined = source()): () => void {
  if (!from?.addEventListener) return () => undefined
  from.addEventListener('devicechange', listener)
  return () => from.removeEventListener?.('devicechange', listener)
}

/** `exact` for a device just picked; a remembered one is only preferred, so a missing one falls back. */
function pick(deviceId: string | null | undefined, exact: boolean): MediaTrackConstraints {
  if (!deviceId) return {}
  return { deviceId: exact ? { exact: deviceId } : { ideal: deviceId } }
}

export function micConstraints(deviceId?: string | null, exact = false): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...pick(deviceId, exact) }
}

export function cameraConstraints(deviceId?: string | null, exact = false): MediaTrackConstraints {
  return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, ...pick(deviceId, exact) }
}

/** The camera after `current` in the list, wrapping; null when there is only one. */
export function nextCamera(devices: CallDevice[], current: string | null | undefined): string | null {
  const cams = devices.filter((d) => d.kind === 'videoinput')
  if (cams.length < 2) return null
  const at = cams.findIndex((d) => d.id === current)
  return cams[(at + 1) % cams.length]!.id
}

export function cameraFailureText(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'HandCash isn’t allowed to use the camera'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found'
  if (name === 'NotReadableError') return 'The camera is in use by another app'
  return 'The camera didn’t start'
}
