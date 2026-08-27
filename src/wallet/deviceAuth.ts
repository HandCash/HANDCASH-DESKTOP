/**
 * Shared device-unlock factor: seals a vault DEK behind OS biometrics /
 * device credential (Mobile) or OS keychain + optional Touch ID (Desktop).
 *
 * This is a separate custody factor from the in-app password — it seals the
 * DEK itself, not a copy of the password.
 */

export type DeviceAuthStatus = {
  available: boolean
  enrolled: boolean
  label: string
  strongBox?: boolean
}

type BridgeDeviceAuth = {
  deviceAuthStatus?: () => Promise<DeviceAuthStatus>
  deviceAuthEnroll?: (
    secret: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  deviceAuthUnlock?: (
    reason?: string,
  ) => Promise<{ ok: true; secret: string } | { ok: false; error: string }>
  deviceAuthClear?: () => Promise<{ ok: true } | { ok: false; error: string }>
}

function bridge(): BridgeDeviceAuth | undefined {
  return window.handcash as BridgeDeviceAuth | undefined
}

export async function deviceAuthStatus(): Promise<DeviceAuthStatus> {
  const api = bridge()?.deviceAuthStatus
  if (!api) return { available: false, enrolled: false, label: 'Device unlock' }
  try {
    return await api()
  } catch {
    return { available: false, enrolled: false, label: 'Device unlock' }
  }
}

/** Seal a base64 DEK behind the device factor. */
export async function deviceAuthEnroll(
  secretB64: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = bridge()?.deviceAuthEnroll
  if (!api) return { ok: false, error: 'Device unlock is not available on this build' }
  try {
    return await api(secretB64)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Prompt native unlock and return the sealed base64 DEK. */
export async function deviceAuthUnlock(
  reason = 'Unlock HandCash',
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const api = bridge()?.deviceAuthUnlock
  if (!api) return { ok: false, error: 'Device unlock is not available on this build' }
  try {
    return await api(reason)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deviceAuthClear(): Promise<void> {
  const api = bridge()?.deviceAuthClear
  if (!api) return
  try {
    await api()
  } catch {
    // ignore
  }
}
