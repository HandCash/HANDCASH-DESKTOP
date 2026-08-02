export type DeviceAuthStatus = {
  available: boolean
  enrolled: boolean
  label: string
}

const DECLINED_KEY = 'handcash.brc100.deviceUnlock.declined'

export async function getDeviceAuthStatus(): Promise<DeviceAuthStatus> {
  const bridge = window.handcash
  if (!bridge?.deviceAuthStatus) {
    return { available: false, enrolled: false, label: 'Device unlock' }
  }
  try {
    return await bridge.deviceAuthStatus()
  } catch {
    return { available: false, enrolled: false, label: 'Device unlock' }
  }
}

export async function enrollDeviceAuth(
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bridge = window.handcash
  if (!bridge?.deviceAuthEnroll) {
    return { ok: false, error: 'Device unlock is not available' }
  }
  const result = await bridge.deviceAuthEnroll(password)
  if (result.ok) {
    try {
      localStorage.removeItem(DECLINED_KEY)
    } catch {
      // ignore
    }
  }
  return result
}

export async function unlockWithDeviceAuth(
  reason = 'Unlock HandCash',
): Promise<{ ok: true; password: string } | { ok: false; error: string }> {
  const bridge = window.handcash
  if (!bridge?.deviceAuthUnlock) {
    return { ok: false, error: 'Device unlock is not available' }
  }
  return bridge.deviceAuthUnlock(reason)
}

export async function clearDeviceAuth(): Promise<void> {
  try {
    await window.handcash?.deviceAuthClear?.()
  } catch {
    // ignore
  }
}

/** User dismissed the post-unlock enroll prompt — don’t nag every unlock. */
export function markDeviceAuthDeclined(): void {
  try {
    localStorage.setItem(DECLINED_KEY, '1')
  } catch {
    // ignore
  }
}

export function hasDeclinedDeviceAuth(): boolean {
  try {
    return localStorage.getItem(DECLINED_KEY) === '1'
  } catch {
    return false
  }
}

export async function maybeOfferDeviceAuthEnroll(password: string): Promise<boolean> {
  const status = await getDeviceAuthStatus()
  if (!status.available || status.enrolled || hasDeclinedDeviceAuth()) return false
  const enable = window.confirm(
    `Unlock with ${status.label} next time?\n\nYour password is still required for backups and sensitive actions.`,
  )
  if (!enable) {
    markDeviceAuthDeclined()
    return false
  }
  const result = await enrollDeviceAuth(password)
  if (!result.ok) {
    window.alert(result.error || `Could not enable ${status.label}`)
    return false
  }
  return true
}
