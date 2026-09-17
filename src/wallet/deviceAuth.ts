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

/**
 * The prompt currently on screen, if any.
 *
 * The OS allows one presence prompt at a time: a second `promptPresence` while
 * one is open resolves the *loser* as `cancelled`, and a caller that reads that
 * as the user declining leaves the wallet locked. Two callers overlap in
 * practice — React re-runs the lock-screen effect before its first
 * `setDeviceUnlockAttempted` has committed — so concurrent callers share one
 * prompt and one answer instead of racing for the OS.
 */
let inFlightUnlock:
  | Promise<{ ok: true; secret: string } | { ok: false; error: string }>
  | null = null

/** Prompt native unlock and return the sealed base64 DEK. */
export async function deviceAuthUnlock(
  reason = 'Unlock HandCash',
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const api = bridge()?.deviceAuthUnlock
  if (!api) return { ok: false, error: 'Device unlock is not available on this build' }
  if (inFlightUnlock) return inFlightUnlock
  const attempt = (async () => {
    try {
      return await api(reason)
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })()
  inFlightUnlock = attempt
  try {
    return await attempt
  } finally {
    // Only the prompt we started clears the slot; a later unlock must re-prompt.
    if (inFlightUnlock === attempt) inFlightUnlock = null
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
